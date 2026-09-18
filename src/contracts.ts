export type SuggestedAction = "remeasure" | "contact-soon" | "seek-care-now";

/** 自动筛查在读数正常时不给出行动建议；临床意见只能取三种明确行动。 */
export type AutomatedAction = SuggestedAction | "no-action";

export interface ValidatedDevice {
  deviceId: string;
  model: string;
  wearableKind: "wrist" | "cuff";
  calibratedAt: string;
  calibrationValidDays: number;
}

export interface BloodPressureSession {
  sessionId: string;
  patientId: string;
  gestationalWeek: number;
  deviceId: string;
  measuredAt: string;
  systolic: number;
  diastolic: number;
  rested: boolean;
  postureConfirmed: boolean;
  symptoms: string[];
}

export interface TriageOpinion {
  opinionId: string;
  sessionId: string;
  action: SuggestedAction;
  authorId: string;
  ruleVersion: string;
  createdAt: string;
  correctsOpinionId?: string;
}

// ---------------------------------------------------------------------------
// 以下为家庭测量 -> 可核对分诊材料的扩展契约
// ---------------------------------------------------------------------------

/** 设备筛查结论：只回答“这次读数可否采信”，不是医院诊断。 */
export type DeviceTrustStatus =
  | "calibrated"
  | "calibration-expired"
  | "unknown-device";

export interface DeviceTrust {
  deviceId: string;
  model?: string;
  wearableKind?: "wrist" | "cuff";
  status: DeviceTrustStatus;
  calibratedAt?: string;
  calibrationValidDays?: number;
  /** calibratedAt + calibrationValidDays，状态为 calibrated/expired 时存在。 */
  validUntil?: string;
  /** 以测量时刻为评估点，回答“测量当时设备是否在校准期内”。 */
  evaluatedAt: string;
}

/** 测量会话质量：静息、姿势、读数生理合理性。 */
export interface SessionQuality {
  acceptable: boolean;
  rested: boolean;
  postureConfirmed: boolean;
  /** 不合格原因代码，如 not-rested / posture-unconfirmed / reading-out-of-range。 */
  reasons: string[];
}

export interface BpThreshold {
  readonly systolic: number;
  readonly diastolic: number;
}

/** 医院发布、按版本生效的分诊规则。 */
export interface TriageRuleSet {
  readonly version: string;
  readonly effectiveFrom: string;
  readonly severeSymptoms: readonly string[];
  readonly thresholds: {
    readonly severe: BpThreshold;
    readonly elevated: BpThreshold;
  };
  /**
   * 严重症状能否在设备/测量质量不合格时直接升级。
   * 旧版要求读数可采信；新版规定症状证据不足也先进紧急人工队列。
   */
  readonly symptomOverridesQuality: boolean;
}

/**
 * 自动化结果：只表达复测 / 尽快联系 / 立即就医，screeningOnly 恒为 true，
 * 区分设备筛查与医院诊断。
 */
export interface AutomatedAssessment {
  sessionId: string;
  ruleVersion: string;
  action: AutomatedAction;
  deviceTrust: DeviceTrust;
  quality: SessionQuality;
  /** 命中规则严重症状清单的会话症状。 */
  triggeredSevereSymptoms: string[];
  /** 机器可核对的判定依据代码。 */
  basis: string[];
  urgentQueue: boolean;
  readonly screeningOnly: true;
  evaluatedAt: string;
}

export type ClinicalRole = "midwife" | "doctor";
export type ClinicalStatus = "unreviewed" | "confirmed" | "corrected";

/** 人工判断链上的一条：意见本体 + 作者角色 + 备注，原意见永不被覆盖。 */
export interface ClinicalReviewEntry {
  opinion: TriageOpinion;
  authorRole: ClinicalRole;
  note?: string;
}

export interface SubmissionSummary {
  /** 已接收的去重提交标识（同一会话重复上传不追加）。 */
  accepted: string[];
  /** 被识别为重放、未计数的次数。 */
  deduplicatedReplays: number;
}

export interface UrgentQueueItem {
  sessionId: string;
  patientId: string;
  gestationalWeek: number;
  action: SuggestedAction;
  reading: { systolic: number; diastolic: number };
  symptoms: string[];
  ruleVersion: string;
  claimedBy?: string;
  claimedAt?: string;
}

/** 接口返回的分诊材料：当前行动 + 设备可信度 + 读数/症状依据 + 人工脉络。 */
export interface TriageRecord {
  sessionId: string;
  patientId: string;
  gestationalWeek: number;
  measuredAt: string;
  reading: { systolic: number; diastolic: number };
  symptoms: string[];
  /** 已有人工意见时以临床意见为准，否则展示自动筛查建议。 */
  currentAction: {
    action: AutomatedAction;
    source: "automated-screening" | "clinical-opinion";
  };
  deviceTrust: DeviceTrust;
  automatedScreening: AutomatedAssessment;
  clinical: {
    status: ClinicalStatus;
    current?: ClinicalReviewEntry;
    trail: ClinicalReviewEntry[];
  };
  urgentQueue: {
    queued: boolean;
    claimedBy?: string;
    claimedAt?: string;
  };
  submissions: SubmissionSummary;
}

export interface SubmissionReceipt {
  sessionId: string;
  submissionId: string;
  /** true 表示这是重放，未重新计数、未重新评估。 */
  deduplicated: boolean;
  submissions: SubmissionSummary;
}
