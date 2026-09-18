import type {
  AutomatedAssessment,
  BloodPressureSession,
  DeviceTrust,
  SessionQuality,
  TriageRuleSet,
  ValidatedDevice,
} from "./contracts.ts";

const MS_PER_DAY = 86_400_000;

/** 读数生理合理区间，超出则测量质量不可接受。 */
export const SYSTOLIC_RANGE = { min: 60, max: 250 } as const;
export const DIASTOLIC_RANGE = { min: 40, max: 150 } as const;

/**
 * 医院发布的规则书：v1 要求严重症状必须由可采信读数支撑；
 * v2 起严重症状即使读数质量不足也直接进入紧急人工队列。
 */
export const BUILTIN_RULE_SETS: readonly TriageRuleSet[] = [
  {
    version: "bp-triage-2025-v1",
    effectiveFrom: "2025-01-01T00:00:00Z",
    severeSymptoms: ["severe-headache", "visual-change"],
    thresholds: {
      severe: { systolic: 160, diastolic: 110 },
      elevated: { systolic: 140, diastolic: 90 },
    },
    symptomOverridesQuality: false,
  },
  {
    version: "bp-triage-2026-v2",
    effectiveFrom: "2026-01-01T00:00:00Z",
    severeSymptoms: ["severe-headache", "visual-change", "epigastric-pain"],
    thresholds: {
      severe: { systolic: 160, diastolic: 110 },
      elevated: { systolic: 140, diastolic: 90 },
    },
    symptomOverridesQuality: true,
  },
];

export class RuleRegistry {
  private readonly ruleSets: TriageRuleSet[];

  constructor(initial: readonly TriageRuleSet[] = BUILTIN_RULE_SETS) {
    this.ruleSets = [...initial].sort(
      (a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom),
    );
    const versions = new Set<string>();
    const effectiveDates = new Set<string>();
    for (const ruleSet of this.ruleSets) {
      if (versions.has(ruleSet.version)) {
        throw new Error(`重复的规则版本: ${ruleSet.version}`);
      }
      versions.add(ruleSet.version);
      if (Number.isNaN(Date.parse(ruleSet.effectiveFrom))) {
        throw new Error(`规则 ${ruleSet.version} 的生效时间非法`);
      }
      if (effectiveDates.has(ruleSet.effectiveFrom)) {
        throw new Error(`规则 ${ruleSet.version} 与其他版本同一时刻生效`);
      }
      effectiveDates.add(ruleSet.effectiveFrom);
    }
  }

  /** 取指定时刻（通常为测量时刻）已经生效的最新版本。 */
  versionAt(atIso: string): TriageRuleSet {
    const at = Date.parse(atIso);
    if (Number.isNaN(at)) {
      throw new Error(`评估时间非法: ${atIso}`);
    }
    let selected: TriageRuleSet | undefined;
    for (const ruleSet of this.ruleSets) {
      if (Date.parse(ruleSet.effectiveFrom) <= at) {
        selected = ruleSet;
      } else {
        break;
      }
    }
    if (!selected) {
      throw new Error(`${atIso} 时尚无生效的分诊规则`);
    }
    return selected;
  }

  latest(): TriageRuleSet {
    const last = this.ruleSets[this.ruleSets.length - 1];
    if (!last) {
      throw new Error("规则注册表为空");
    }
    return last;
  }

  all(): readonly TriageRuleSet[] {
    return this.ruleSets;
  }
}

function addDays(iso: string, days: number): Date {
  return new Date(Date.parse(iso) + days * MS_PER_DAY);
}

/**
 * 设备筛查：以测量时刻为评估点，核对腕带/袖带的校准窗口。
 * 这是“设备是否可采信”的筛查，不是医院诊断。
 */
export function evaluateDeviceTrust(
  device: ValidatedDevice | undefined,
  measuredAt: string,
): DeviceTrust {
  if (!device) {
    return { deviceId: "unknown", status: "unknown-device", evaluatedAt: measuredAt };
  }
  const measuredMs = Date.parse(measuredAt);
  const calibratedMs = Date.parse(device.calibratedAt);
  const base: DeviceTrust = {
    deviceId: device.deviceId,
    model: device.model,
    wearableKind: device.wearableKind,
    status: "calibrated",
    calibratedAt: device.calibratedAt,
    calibrationValidDays: device.calibrationValidDays,
    validUntil: addDays(device.calibratedAt, device.calibrationValidDays).toISOString(),
    evaluatedAt: measuredAt,
  };
  if (calibratedMs > measuredMs) {
    // 测量时该“校准”尚未发生，读数同样不能采信。
    return { ...base, status: "calibration-expired" };
  }
  if (measuredMs > Date.parse(base.validUntil!)) {
    return { ...base, status: "calibration-expired" };
  }
  return base;
}

/** 测量质量：测量前静息、姿势确认、读数生理合理性。 */
export function evaluateQuality(session: BloodPressureSession): SessionQuality {
  const reasons: string[] = [];
  if (!session.rested) {
    reasons.push("not-rested");
  }
  if (!session.postureConfirmed) {
    reasons.push("posture-unconfirmed");
  }
  const { systolic, diastolic } = session;
  const inRange =
    systolic >= SYSTOLIC_RANGE.min &&
    systolic <= SYSTOLIC_RANGE.max &&
    diastolic >= DIASTOLIC_RANGE.min &&
    diastolic <= DIASTOLIC_RANGE.max &&
    diastolic < systolic;
  if (!inRange) {
    reasons.push("reading-out-of-range");
  }
  return {
    acceptable: reasons.length === 0,
    rested: session.rested,
    postureConfirmed: session.postureConfirmed,
    reasons,
  };
}

function bpBand(
  session: BloodPressureSession,
  rule: TriageRuleSet,
): "severe" | "elevated" | "normal" {
  const { severe, elevated } = rule.thresholds;
  if (session.systolic >= severe.systolic || session.diastolic >= severe.diastolic) {
    return "severe";
  }
  if (
    session.systolic >= elevated.systolic ||
    session.diastolic >= elevated.diastolic
  ) {
    return "elevated";
  }
  return "normal";
}

/**
 * 自动筛查：结论仅为复测 / 尽快联系 / 立即就医（或读数正常时 no-action），
 * screeningOnly 恒为 true。设备与质量不合格一律要求复测，
 * 唯一例外按规则版本决定：严重症状可无视读数质量升级到紧急人工队列。
 */
export function assessSession(
  session: BloodPressureSession,
  device: ValidatedDevice | undefined,
  rule: TriageRuleSet,
): AutomatedAssessment {
  const deviceTrust = evaluateDeviceTrust(device, session.measuredAt);
  const quality = evaluateQuality(session);
  const usableReading =
    deviceTrust.status === "calibrated" && quality.acceptable;

  const triggeredSevereSymptoms = session.symptoms.filter((symptom) =>
    rule.severeSymptoms.includes(symptom),
  );
  const band = bpBand(session, rule);

  const basis: string[] = [];
  basis.push(
    deviceTrust.status === "calibrated"
      ? "device:calibrated"
      : deviceTrust.status === "unknown-device"
        ? "device:unknown"
        : "device:calibration-expired",
  );
  basis.push(...quality.reasons.map((reason) => `quality:${reason}`));
  basis.push(`bp:${band}`);
  basis.push(...triggeredSevereSymptoms.map((symptom) => `symptom:${symptom}`));

  let action: AutomatedAssessment["action"];
  if (triggeredSevereSymptoms.length > 0) {
    // 症状分支：是否接受质量不足的证据由规则版本决定。
    if (usableReading || rule.symptomOverridesQuality) {
      action = "seek-care-now";
      basis.push("rule:severe-symptom");
      if (!usableReading && rule.symptomOverridesQuality) {
        basis.push("rule:symptom-overrides-quality");
      }
    } else {
      action = "remeasure";
      basis.push("rule:severe-symptom-unverified");
    }
  } else if (!usableReading) {
    action = "remeasure";
    basis.push("rule:reading-unusable");
  } else if (band === "severe") {
    action = "seek-care-now";
    basis.push("rule:bp-severe");
  } else if (band === "elevated") {
    action = "contact-soon";
    basis.push("rule:bp-elevated");
  } else {
    action = "no-action";
    basis.push("rule:bp-normal");
  }

  return {
    sessionId: session.sessionId,
    ruleVersion: rule.version,
    action,
    deviceTrust,
    quality,
    triggeredSevereSymptoms,
    basis,
    urgentQueue: action === "seek-care-now",
    screeningOnly: true,
    evaluatedAt: session.measuredAt,
  };
}
