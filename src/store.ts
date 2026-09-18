import type {
  AutomatedAssessment,
  BloodPressureSession,
  ClinicalReviewEntry,
  TriageOpinion,
  ValidatedDevice,
} from "./contracts.ts";
import {
  AlreadyClaimedError,
  DeviceConflictError,
  NotFoundError,
} from "./errors.ts";

/**
 * 单进程内存仓储。Node 同步执行期间“检查 + 写入”不会被其他调用穿插
 * （事件循环在一次同步调用结束前不切换），因此领取等检查-写入操作天然原子，
 * 轮班人员同时领取时只有一人能写入 claim。
 */
export class InMemoryStore {
  readonly devices = new Map<string, ValidatedDevice>();
  readonly sessions = new Map<string, BloodPressureSession>();

  /** sessionId -> 已计数的提交标识集合（重放不再加入）。 */
  readonly submissionIndex = new Map<string, Set<string>>();
  /** sessionId -> 重放（重复上传）被识别、未计数的次数。 */
  readonly replayCounts = new Map<string, number>();

  readonly assessments = new Map<string, AutomatedAssessment>();

  readonly opinions = new Map<string, ClinicalReviewEntry>();
  private readonly opinionOrder: string[] = [];
  private readonly latestOpinionBySession = new Map<string, string>();

  /** sessionId -> 最新一条紧急意见；行动被纠正为非紧急时移除。 */
  readonly queueIndex = new Map<string, string>();
  readonly claims = new Map<string, { by: string; at: string }>();

  // -- 设备 ----------------------------------------------------------------

  registerDevice(input: ValidatedDevice): void {
    const existing = this.devices.get(input.deviceId);
    if (existing) {
      const same =
        existing.model === input.model &&
        existing.wearableKind === input.wearableKind &&
        existing.calibratedAt === input.calibratedAt &&
        existing.calibrationValidDays === input.calibrationValidDays;
      if (!same) {
        throw new DeviceConflictError(`设备 ${input.deviceId} 已登记且信息不一致`);
      }
      return;
    }
    this.devices.set(input.deviceId, { ...input });
  }

  getDevice(deviceId: string): ValidatedDevice | undefined {
    return this.devices.get(deviceId);
  }

  // -- 提交幂等 ------------------------------------------------------------

  /** 同一会话 + 同一 submissionId 的重复上传不累加次数。 */
  hasSubmission(sessionId: string, submissionId: string): boolean {
    return this.submissionIndex.get(sessionId)?.has(submissionId) ?? false;
  }

  /** 登记一次新提交（调用前应先用 hasSubmission 排除重放）。 */
  recordSubmission(sessionId: string, submissionId: string): void {
    let set = this.submissionIndex.get(sessionId);
    if (!set) {
      set = new Set();
      this.submissionIndex.set(sessionId, set);
    }
    if (set.has(submissionId)) {
      this.replayCounts.set(sessionId, (this.replayCounts.get(sessionId) ?? 0) + 1);
      return;
    }
    set.add(submissionId);
  }

  /** 记录一次已识别的重放（用于统计）。 */
  noteReplay(sessionId: string): void {
    this.replayCounts.set(sessionId, (this.replayCounts.get(sessionId) ?? 0) + 1);
  }

  submissionSummary(sessionId: string): { accepted: string[]; deduplicatedReplays: number } {
    return {
      accepted: [...(this.submissionIndex.get(sessionId) ?? [])],
      deduplicatedReplays: this.replayCounts.get(sessionId) ?? 0,
    };
  }

  // -- 会话与自动筛查 ------------------------------------------------------

  upsertSession(session: BloodPressureSession): void {
    this.sessions.set(session.sessionId, { ...session });
  }

  getSession(sessionId: string): BloodPressureSession | undefined {
    return this.sessions.get(sessionId);
  }

  saveAssessment(assessment: AutomatedAssessment): void {
    this.assessments.set(assessment.sessionId, assessment);
  }

  getAssessment(sessionId: string): AutomatedAssessment | undefined {
    return this.assessments.get(sessionId);
  }

  // -- 人工意见 ------------------------------------------------------------

  saveReview(entry: ClinicalReviewEntry): void {
    const { opinion } = entry;
    this.opinions.set(opinion.opinionId, {
      opinion: { ...opinion },
      authorRole: entry.authorRole,
      ...(entry.note !== undefined ? { note: entry.note } : {}),
    });
    this.opinionOrder.push(opinion.opinionId);
    this.latestOpinionBySession.set(opinion.sessionId, opinion.opinionId);
    if (opinion.action === "seek-care-now") {
      this.queueIndex.set(opinion.sessionId, opinion.opinionId);
    } else {
      // 医生覆核为非紧急行动：退出紧急队列并释放领取锁。
      this.queueIndex.delete(opinion.sessionId);
      this.claims.delete(opinion.sessionId);
    }
  }

  trailFor(sessionId: string): ClinicalReviewEntry[] {
    return this.opinionOrder
      .map((id) => this.opinions.get(id)!)
      .filter((entry) => entry.opinion.sessionId === sessionId);
  }

  latestReview(sessionId: string): ClinicalReviewEntry | undefined {
    const id = this.latestOpinionBySession.get(sessionId);
    return id ? this.opinions.get(id) : undefined;
  }

  // -- 紧急队列与领取 ------------------------------------------------------

  isQueued(sessionId: string): boolean {
    return this.queueIndex.has(sessionId);
  }

  /**
   * 领取紧急队列条目。是否在队列中由服务层依据“自动筛查或最新意见”判定；
   * 仓储层只保证对同一会话的领取互斥。已被他人领取时抛 AlreadyClaimedError；
   * 同一人重复领取幂等成功。
   */
  claim(sessionId: string, staffId: string, now: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new NotFoundError(`会话 ${sessionId} 不存在`);
    }
    const existing = this.claims.get(sessionId);
    if (existing) {
      if (existing.by === staffId) {
        return;
      }
      throw new AlreadyClaimedError(sessionId, existing.by);
    }
    this.claims.set(sessionId, { by: staffId, at: now });
  }

  claimOf(sessionId: string): { by: string; at: string } | undefined {
    return this.claims.get(sessionId);
  }

  queuedSessionIds(): string[] {
    return [...this.queueIndex.keys()];
  }
}
