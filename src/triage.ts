/**
 * 孕期血压异常分诊核心域。
 *
 * 分层（与 src/contracts.ts 对应）：
 *  - 设备筛查（ValidatedDevice + 校准/型号检查）——只决定设备是否可信，绝不作医院诊断；
 *  - 测量会话（BloodPressureSession + 静息/姿势等质量事实）；
 *  - 症状问答（严重头痛、视物异常等红旗症状）；
 *  - 自动建议（remeasure / contact-soon / seek-care-now）——机器只给当前行动，
 *    不形成分诊意见；分诊意见必须由助产士确认；医生可追加“更正”记录覆核。
 *
 * 数据一致性：
 *  - 同一会话的重复提交按 sessionId+submissionId 幂等，不累加测量次数；
 *  - 紧急人工队列认领采用条件写入，并发下仅第一人成功，其余收到冲突。
 */

import type {
  BloodPressureSession,
  SuggestedAction,
  TriageOpinion,
  ValidatedDevice,
} from "./contracts.js";

// ---------------------------------------------------------------------------
// 规则版本
// ---------------------------------------------------------------------------

/**
 * 医院发布的规则按版本生效。evaluate 时固定一个 ruleVersion，
 * 输出的每条建议/意见都携带其依据的版本；换版不追溯改变历史结论。
 */
export interface TriageRuleSet {
  version: string;
  /** 生效起点（含），ISO 时间。 */
  effectiveFrom: string;
  /** 严重症状：即使读数质量不足也必须进入紧急人工队列。 */
  severeSymptoms: readonly string[];
  /** 家庭自测高血压界值（收缩压 / 舒张压，单位 mmHg），达到其一即升高行动级别。 */
  elevatedBp: { systolic: number; diastolic: number };
  /** 重度升高界值，达到即立即就医。 */
  severeBp: { systolic: number; diastolic: number };
  /** 进入“尽快联系”的最小孕周（预防/排查子痫前期，默认 20 周）。 */
  contactGestationalWeek: number;
}

/** 2026 版规则：家庭复测确认升高的按指南处理；红旗症状一票进入紧急队列。 */
export const RULE_SET_V2026_01: TriageRuleSet = Object.freeze({
  version: "2026.01",
  effectiveFrom: "2026-01-01T00:00:00Z",
  severeSymptoms: Object.freeze([
    "severe-headache",
    "visual-change",
    "epigastric-pain",
    "shortness-of-breath",
  ]),
  elevatedBp: Object.freeze({ systolic: 135, diastolic: 85 }),
  severeBp: Object.freeze({ systolic: 160, diastolic: 110 }),
  // 注意：bp-cases.json 中 151/96 + 严重症状 → seek-care-now 由症状触发，不依赖重度界值。
  contactGestationalWeek: 20,
});

export function latestRuleSet(
  rules: readonly TriageRuleSet[],
  now: Date = new Date(),
): TriageRuleSet {
  const effective = rules
    .filter((r) => Date.parse(r.effectiveFrom) <= now.getTime())
    // 生效时间相同时按版本号降序兜底，保持选择确定。
    .sort((a, b) => {
      const byTime = Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom);
      return byTime !== 0 ? byTime : b.version.localeCompare(a.version);
    });
  const chosen = effective[0];
  if (!chosen) throw new Error("No effective triage rule set at " + now.toISOString());
  return chosen;
}

// ---------------------------------------------------------------------------
// 设备筛查
// ---------------------------------------------------------------------------

export type DeviceTrustLevel = "validated" | "unknown-device" | "calibration-expired";

export interface DeviceAssessment {
  deviceId: string;
  trust: DeviceTrustLevel;
  /** 登记的腕带/袖带型号；未登记为 null。 */
  model: string | null;
  wearableKind: "wrist" | "cuff" | null;
  /** 近期校准是否合格：未登记设备或校准过期均为 false。 */
  calibrationCurrent: boolean;
  calibrationAgeDays: number | null;
  calibrationValidDays: number | null;
  reasons: string[];
}

/**
 * 核对设备：必须是已登记、已验证的型号，且校准在有效期内（按测量时间判定，
 * 而不是提交时间）。这是“设备筛查”，不是诊断。
 */
export function assessDevice(
  deviceId: string,
  registry: ReadonlyMap<string, ValidatedDevice>,
  measuredAt: Date,
): DeviceAssessment {
  const device = registry.get(deviceId);
  if (!device) {
    return {
      deviceId,
      trust: "unknown-device",
      model: null,
      wearableKind: null,
      calibrationCurrent: false,
      calibrationAgeDays: null,
      calibrationValidDays: null,
      reasons: ["设备未登记或未通过验证，无法确认读数来自已校准设备"],
    };
  }

  const ageMs = measuredAt.getTime() - Date.parse(device.calibratedAt);
  const ageDays = ageMs / 86_400_000;
  const calibrationCurrent = ageDays >= 0 && ageDays <= device.calibrationValidDays;

  const reasons: string[] = [];
  if (ageDays < 0) {
    reasons.push("校准日期晚于测量时间，记录可疑");
  } else if (!calibrationCurrent) {
    reasons.push(
      `校准已过期 ${Math.ceil(ageDays - device.calibrationValidDays)} 天` +
        `（校准于 ${device.calibratedAt}，有效期 ${device.calibrationValidDays} 天）`,
    );
  }

  return {
    deviceId,
    trust: calibrationCurrent ? "validated" : "calibration-expired",
    model: device.model,
    wearableKind: device.wearableKind,
    calibrationCurrent,
    calibrationAgeDays: ageDays,
    calibrationValidDays: device.calibrationValidDays,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 测量质量与症状
// ---------------------------------------------------------------------------

export type MeasurementQuality = "valid" | "requires-reretake";

export interface MeasurementContext {
  quality: MeasurementQuality;
  /** 测量前是否充分静息。 */
  rested: boolean;
  /** 姿势（坐位、手臂与心脏同高）是否经确认。 */
  postureConfirmed: boolean;
  gestationalWeek: number;
  /** 本次会话内出现的严重症状。 */
  severeSymptomsPresent: string[];
  qualityIssues: string[];
}

export function assessMeasurement(
  session: BloodPressureSession,
  rules: TriageRuleSet,
): MeasurementContext {
  const issues: string[] = [];
  if (!session.rested) issues.push("缺少测量前充分静息确认");
  if (!session.postureConfirmed) issues.push("测量姿势未经确认（坐位、手臂与心脏同高）");
  if (!Number.isFinite(session.systolic) || !Number.isFinite(session.diastolic)) {
    issues.push("血压读数缺失或非法");
  }

  const severe = session.symptoms.filter((s) => rules.severeSymptoms.includes(s));

  return {
    quality: issues.length === 0 ? "valid" : "requires-reretake",
    rested: session.rested,
    postureConfirmed: session.postureConfirmed,
    gestationalWeek: session.gestationalWeek,
    severeSymptomsPresent: severe,
    qualityIssues: issues,
  };
}

// ---------------------------------------------------------------------------
// 自动建议
// ---------------------------------------------------------------------------

export interface AutoTriageAdvice {
  action: SuggestedAction;
  ruleVersion: string;
  deviceTrust: DeviceTrustLevel;
  quality: MeasurementQuality;
  /** 支撑建议的读数；若质量不足无法作为依据则为 null。 */
  supportingReading: { systolic: number; diastolic: number } | null;
  severeSymptoms: string[];
  /** 该建议是否仅由严重症状触发（读数质量不足时仍成立）。 */
  symptomDriven: boolean;
  rationale: string[];
}

/**
 * 计算当前行动建议。关键优先级：
 *  1. 严重症状 → seek-care-now 并进紧急人工队列，即使设备/姿势不合格；
 *  2. 可信设备 + 合格姿势下的重度升高 → seek-care-now；
 *  3. 可信、合格但升高 → contact-soon（≥20 周升高需排查子痫前期）；
 *  4. 质量不合格且无严重症状 → remeasure（复测，不把脏读数当成诊断材料）。
 */
export function evaluateTriage(
  session: BloodPressureSession,
  device: DeviceAssessment,
  measurement: MeasurementContext,
  rules: TriageRuleSet,
): AutoTriageAdvice {
  const rationale: string[] = [];
  const readingValid =
    device.trust === "validated" && measurement.quality === "valid";
  const reading =
    Number.isFinite(session.systolic) && Number.isFinite(session.diastolic)
      ? { systolic: session.systolic, diastolic: session.diastolic }
      : null;

  const hasSevereSymptoms = measurement.severeSymptomsPresent.length > 0;

  // 1) 严重症状一票进入紧急路径，与读数质量解耦。
  if (hasSevereSymptoms) {
    rationale.push(
      `孕妇报告严重症状：${measurement.severeSymptomsPresent.join("、")}，` +
        "无论读数质量如何均须立即就医并进入紧急人工队列",
    );
    if (!readingValid) {
      rationale.push(
        `本次读数不可直接采信（设备：${device.trust}；测量质量：${measurement.quality}），` +
          "紧急转诊以症状为依据，不等待复测",
      );
    }
    return {
      action: "seek-care-now",
      ruleVersion: rules.version,
      deviceTrust: device.trust,
      quality: measurement.quality,
      supportingReading: readingValid ? reading : null,
      // 读数本身可信时症状与读数共同支撑；质量不足时纯症状驱动。
      symptomDriven: !readingValid || !isAtOrAbove(reading!, rules.severeBp),
      severeSymptoms: [...measurement.severeSymptomsPresent],
      rationale,
    };
  }

  // 2) 读数整体不可信 → 常规重测（已被上面的严重症状短路排除）。
  if (!readingValid) {
    rationale.push(
      `家庭测量不满足核对条件（设备可信度：${device.trust}；测量质量：${measurement.quality}），` +
        "自动建议为按规范复测，不据此升高临床级别",
    );
    for (const reason of device.reasons) rationale.push(reason);
    for (const issue of measurement.qualityIssues) rationale.push(issue);
    return {
      action: "remeasure",
      ruleVersion: rules.version,
      deviceTrust: device.trust,
      quality: measurement.quality,
      supportingReading: null,
      symptomDriven: false,
      severeSymptoms: [],
      rationale,
    };
  }

  // 可信、合格的读数：按血压级别给建议。
  const bp = reading!;
  if (isAtOrAbove(bp, rules.severeBp)) {
    rationale.push(
      `可信读数 ${bp.systolic}/${bp.diastolic} mmHg 达到重度升高界值` +
        ` ${rules.severeBp.systolic}/${rules.severeBp.diastolic}，立即就医`,
    );
    return {
      action: "seek-care-now",
      ruleVersion: rules.version,
      deviceTrust: device.trust,
      quality: measurement.quality,
      supportingReading: bp,
      symptomDriven: false,
      severeSymptoms: [],
      rationale,
    };
  }

  if (isAtOrAbove(bp, rules.elevatedBp)) {
    if (session.gestationalWeek >= rules.contactGestationalWeek) {
      rationale.push(
        `可信读数 ${bp.systolic}/${bp.diastolic} mmHg 达到家庭升高界值` +
          ` ${rules.elevatedBp.systolic}/${rules.elevatedBp.diastolic}，` +
          `孕周 ${session.gestationalWeek} 周（≥ ${rules.contactGestationalWeek} 周）需尽快联系产科排查子痫前期`,
      );
    } else {
      rationale.push(
        `可信读数 ${bp.systolic}/${bp.diastolic} mmHg 轻度升高，孕周 ${session.gestationalWeek} 周，尽快联系门诊确认`,
      );
    }
    return {
      action: "contact-soon",
      ruleVersion: rules.version,
      deviceTrust: device.trust,
      quality: measurement.quality,
      supportingReading: bp,
      symptomDriven: false,
      severeSymptoms: [],
      rationale,
    };
  }

  rationale.push(
    `可信读数 ${bp.systolic}/${bp.diastolic} mmHg 未达升高界值，继续按医嘱家庭监测`,
  );
  return {
    action: "remeasure",
    ruleVersion: rules.version,
    deviceTrust: device.trust,
    quality: measurement.quality,
    supportingReading: bp,
    symptomDriven: false,
    severeSymptoms: [],
    rationale,
  };
}

function isAtOrAbove(
  bp: { systolic: number; diastolic: number },
  threshold: { systolic: number; diastolic: number },
): boolean {
  return bp.systolic >= threshold.systolic || bp.diastolic >= threshold.diastolic;
}

// ---------------------------------------------------------------------------
// 幂等提交与紧急队列、人工意见（内存存储 + 条件写入）
// ---------------------------------------------------------------------------

export interface StoredSubmission {
  submissionId: string;
  sessionId: string;
  firstReceivedAt: string;
}

export interface StoredSessionRecord {
  session: BloodPressureSession;
  device: DeviceAssessment;
  measurement: MeasurementContext;
  advice: AutoTriageAdvice;
  /** 已接受的提交标识，重复上传直接返回已有结果。 */
  submissions: Map<string, StoredSubmission>;
  /** 该会话被系统接受的测量次数（去重后；同一物理测量的重复上传不累加）。 */
  acceptedCount: number;
  opinions: TriageOpinion[];
  /** 紧急队列条目；非紧急或已撤销为 null。 */
  queueEntry: {
    claimedBy: string | null;
    claimedAt: string | null;
    status: "queued" | "claimed" | "resolved";
  } | null;
  updatedAt: string;
}

export interface SubmitOutcome {
  status: "accepted" | "duplicate";
  /** 接受的第几次测量（去重后）；重复提交时保持不变。 */
  measurementIndex: number;
  record: StoredSessionRecord;
}

export class TriageRepository {
  readonly #sessions = new Map<string, StoredSessionRecord>();
  /** submissionId → sessionId，保证同一提交不能重复计数。 */
  readonly #submissionIndex = new Map<string, string>();

  /**
   * 幂等提交。以 (sessionId, submissionId) 去重；fixtures 中同一物理测量
   * 携带两个相同 submissionId（重复上传），第二次起返回 duplicate，计数不变。
   */
  submit(
    session: BloodPressureSession,
    submissionId: string,
    rules: TriageRuleSet,
    deviceRegistry: ReadonlyMap<string, ValidatedDevice>,
    now: Date = new Date(),
  ): SubmitOutcome {
    const existingSession = this.#submissionIndex.get(submissionId);
    if (existingSession !== undefined) {
      if (existingSession !== session.sessionId) {
        throw new Error(
          `submissionId ${submissionId} 已属于会话 ${existingSession}，不能挂到其他会话`,
        );
      }
      const record = this.#require(session.sessionId);
      return {
        status: "duplicate",
        measurementIndex: record.acceptedCount,
        record,
      };
    }

    const record = this.#sessions.get(session.sessionId);
    const device = assessDevice(session.deviceId, deviceRegistry, new Date(session.measuredAt));
    const measurement = assessMeasurement(session, rules);
    const advice = evaluateTriage(session, device, measurement, rules);

    const isoNow = now.toISOString();
    if (record) {
      // 同一会话新的（不同 submissionId）测量：计数 +1，并以最新事实刷新评估。
      record.session = session;
      record.device = device;
      record.measurement = measurement;
      record.advice = advice;
      record.acceptedCount += 1;
      record.updatedAt = isoNow;
      record.submissions.set(submissionId, {
        submissionId,
        sessionId: session.sessionId,
        firstReceivedAt: isoNow,
      });
      this.#submissionIndex.set(submissionId, session.sessionId);
      this.#syncQueue(record);
      return { status: "accepted", measurementIndex: record.acceptedCount, record };
    }

    const fresh: StoredSessionRecord = {
      session,
      device,
      measurement,
      advice,
      submissions: new Map([
        [
          submissionId,
          { submissionId, sessionId: session.sessionId, firstReceivedAt: isoNow },
        ],
      ]),
      acceptedCount: 1,
      opinions: [],
      queueEntry: null,
      updatedAt: isoNow,
    };
    this.#sessions.set(session.sessionId, fresh);
    this.#submissionIndex.set(submissionId, session.sessionId);
    this.#syncQueue(fresh);
    return { status: "accepted", measurementIndex: 1, record: fresh };
  }

  get(sessionId: string): StoredSessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  sessionIds(): string[] {
    return [...this.#sessions.keys()];
  }

  /**
   * 条件认领紧急队列条目。轮班人员同时领取时只有一人成功：
   * 仅当当前 claimedBy 为 null 且状态为 queued 时写入认领人。
   * 第二个并发领取者收到 409 风格冲突，不改写第一人。
   */ claim(
    sessionId: string,
    staffId: string,
    now: Date = new Date(),
  ): { ok: true; record: StoredSessionRecord } | { ok: false; reason: string } {
    const record = this.#require(sessionId);
    const entry = record.queueEntry;
    if (!entry) return { ok: false, reason: "not-queued" };
    if (entry.status !== "queued" || entry.claimedBy !== null) {
      return {
        ok: false,
        reason: "already-claimed",
      };
    }
    entry.claimedBy = staffId;
    entry.claimedAt = now.toISOString();
    entry.status = "claimed";
    record.updatedAt = entry.claimedAt;
    return { ok: true, record };
  }

  resolve(sessionId: string, now: Date = new Date()): void {
    const record = this.#require(sessionId);
    if (!record.queueEntry) throw new Error(`会话 ${sessionId} 不在紧急队列中`);
    record.queueEntry.status = "resolved";
    record.updatedAt = now.toISOString();
  }

  /**
   * 助产士确认自动建议 → 形成分诊意见。自动建议本身不是意见。
   * 若传入与当前建议不一致的行动，说明人工 override，允许但需记录作者与版本。
   */
  confirmOpinion(
    sessionId: string,
    authorId: string,
    now: Date = new Date(),
    action?: SuggestedAction,
  ): TriageOpinion {
    const record = this.#require(sessionId);
    const finalAction = action ?? record.advice.action;
    const opinion: TriageOpinion = {
      opinionId: `op-${sessionId}-${record.opinions.length + 1}`,
      sessionId,
      action: finalAction,
      authorId,
      ruleVersion: record.advice.ruleVersion,
      createdAt: now.toISOString(),
    };
    record.opinions.push(opinion);
    record.updatedAt = opinion.createdAt;
    return opinion;
  }

  /**
   * 医生覆核：追加一条“更正”意见，不删除/改写原意见，保留来龙去脉。
   * correctsOpinionId 指向被纠正的那条记录。
   */
  correctOpinion(
    sessionId: string,
    authorId: string,
    action: SuggestedAction,
    correctsOpinionId: string,
    now: Date = new Date(),
  ): TriageOpinion {
    const record = this.#require(sessionId);
    if (!record.opinions.some((o) => o.opinionId === correctsOpinionId)) {
      throw new Error(`被纠正的意见 ${correctsOpinionId} 不存在`);
    }
    const correction: TriageOpinion = {
      opinionId: `op-${sessionId}-${record.opinions.length + 1}`,
      sessionId,
      action,
      authorId,
      ruleVersion: record.advice.ruleVersion,
      createdAt: now.toISOString(),
      correctsOpinionId,
    };
    record.opinions.push(correction);
    record.updatedAt = correction.createdAt;
    return correction;
  }

  #syncQueue(record: StoredSessionRecord): void {
    const mustQueue = record.advice.action === "seek-care-now";
    if (mustQueue && !record.queueEntry) {
      record.queueEntry = { claimedBy: null, claimedAt: null, status: "queued" };
    } else if (!mustQueue && record.queueEntry?.status === "queued") {
      // 尚未被认领的条目可随证据更新撤出；已认领/已处理的保留审计痕迹。
      record.queueEntry = null;
    }
  }

  #require(sessionId: string): StoredSessionRecord {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new Error(`未知会话 ${sessionId}`);
    return record;
  }
}

// ---------------------------------------------------------------------------
// 对外“材料包”：不是孤立分值，而是当前行动 + 设备可信度 + 支撑读数/症状 + 人工脉络
// ---------------------------------------------------------------------------

export interface TriageCaseView {
  sessionId: string;
  patientId: string;
  gestationalWeek: number;
  currentAction: SuggestedAction;
  ruleVersion: string;
  device: {
    trust: DeviceTrustLevel;
    model: string | null;
    wearableKind: "wrist" | "cuff" | null;
    calibrationCurrent: boolean;
    calibrationAgeDays: number | null;
    reasons: string[];
  };
  measurement: {
    quality: MeasurementQuality;
    rested: boolean;
    postureConfirmed: boolean;
    qualityIssues: string[];
  };
  supportingReading: { systolic: number; diastolic: number; measuredAt: string } | null;
  symptoms: { reported: string[]; severe: string[] };
  rationale: string[];
  submission: { acceptedCount: number; submissionIds: string[]; latestStatus: string };
  queue: { status: "queued" | "claimed" | "resolved" | "none"; claimedBy: string | null };
  opinions: TriageOpinion[];
}

export function buildCaseView(record: StoredSessionRecord): TriageCaseView {
  const { session, device, measurement, advice } = record;
  return {
    sessionId: session.sessionId,
    patientId: session.patientId,
    gestationalWeek: session.gestationalWeek,
    currentAction: advice.action,
    ruleVersion: advice.ruleVersion,
    device: {
      trust: device.trust,
      model: device.model,
      wearableKind: device.wearableKind,
      calibrationCurrent: device.calibrationCurrent,
      calibrationAgeDays: device.calibrationAgeDays,
      reasons: device.reasons,
    },
    measurement: {
      quality: measurement.quality,
      rested: measurement.rested,
      postureConfirmed: measurement.postureConfirmed,
      qualityIssues: measurement.qualityIssues,
    },
    supportingReading: advice.supportingReading
      ? { ...advice.supportingReading, measuredAt: session.measuredAt }
      : null,
    symptoms: {
      reported: [...session.symptoms],
      severe: advice.severeSymptoms,
    },
    rationale: advice.rationale,
    submission: {
      acceptedCount: record.acceptedCount,
      submissionIds: [...record.submissions.keys()],
      latestStatus: record.updatedAt,
    },
    queue: record.queueEntry
      ? {
          status: record.queueEntry.status,
          claimedBy: record.queueEntry.claimedBy,
        }
      : { status: "none", claimedBy: null },
    opinions: [...record.opinions],
  };
}
