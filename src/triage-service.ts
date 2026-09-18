import type {
  AutomatedAssessment,
  ClinicalReviewEntry,
  SubmissionReceipt,
  SuggestedAction,
  TriageRecord,
  TriageRuleSet,
  UrgentQueueItem,
} from "./contracts.ts";
import {
  InvalidReviewStateError,
  NotFoundError,
  NotQueuedError,
  ValidationError,
} from "./errors.ts";
import { assessSession, RuleRegistry } from "./rules.ts";
import { InMemoryStore } from "./store.ts";
import { validateDevice, validateSession } from "./validation.ts";

export interface TriageServiceOptions {
  rules?: RuleRegistry;
  now?: () => string;
  newOpinionId?: () => string;
}

export interface CorrectOptions {
  note?: string;
  now?: string;
}

const AUTOMATED_ACTIONS = new Set<SuggestedAction>([
  "remeasure",
  "contact-soon",
  "seek-care-now",
]);

export class TriageService {
  private readonly store: InMemoryStore;
  private readonly rules: RuleRegistry;
  private readonly now: () => string;
  private readonly newOpinionId: () => string;

  constructor(store: InMemoryStore, options: TriageServiceOptions = {}) {
    this.store = store;
    this.rules = options.rules ?? new RuleRegistry();
    this.now = options.now ?? (() => new Date().toISOString());
    let counter = 0;
    this.newOpinionId =
      options.newOpinionId ??
      (() => `op-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  ruleVersions(): readonly TriageRuleSet[] {
    return this.rules.all();
  }

  registerDevice(raw: unknown): void {
    this.store.registerDevice(validateDevice(raw));
  }

  /**
   * 提交一次家庭测量会话。
   * 同一会话 + 同一 submissionId 反复上传：不累加次数、不重新评估。
   */
  submit(rawSession: unknown, submissionId: string): SubmissionReceipt {
    if (typeof submissionId !== "string" || submissionId.trim() === "") {
      throw new ValidationError("submissionId 必须是非空字符串");
    }
    const session = validateSession(rawSession);
    if (this.store.hasSubmission(session.sessionId, submissionId)) {
      // 重放：不累加次数、不重新评估，仅累计重放计数。
      this.store.noteReplay(session.sessionId);
      return {
        sessionId: session.sessionId,
        submissionId,
        deduplicated: true,
        submissions: this.store.submissionSummary(session.sessionId),
      };
    }
    if (this.store.getSession(session.sessionId)) {
      // 新提交标识却指向已存在会话：拒绝；重测须用新的会话标识。
      throw new InvalidReviewStateError(
        `会话 ${session.sessionId} 已存在；重测请使用新的会话标识`,
      );
    }
    this.store.recordSubmission(session.sessionId, submissionId);

    const rule = this.rules.versionAt(session.measuredAt);
    const device = this.store.getDevice(session.deviceId);
    const assessment = assessSession(session, device, rule);

    this.store.upsertSession(session);
    this.store.saveAssessment(assessment);

    return {
      sessionId: session.sessionId,
      submissionId,
      deduplicated: false,
      submissions: this.store.submissionSummary(session.sessionId),
    };
  }

  /** 完整分诊材料：当前行动、设备可信度、读数与症状依据、人工判断脉络。 */
  record(sessionId: string): TriageRecord {
    const session = this.requireSession(sessionId);
    const assessment = this.store.getAssessment(sessionId);
    if (!assessment) {
      throw new NotFoundError(`会话 ${sessionId} 缺少自动筛查结果`);
    }
    const trail = this.store.trailFor(sessionId);
    const current = this.store.latestReview(sessionId);

    return {
      sessionId: session.sessionId,
      patientId: session.patientId,
      gestationalWeek: session.gestationalWeek,
      measuredAt: session.measuredAt,
      reading: { systolic: session.systolic, diastolic: session.diastolic },
      symptoms: [...session.symptoms],
      currentAction: current
        ? { action: current.opinion.action, source: "clinical-opinion" }
        : { action: assessment.action, source: "automated-screening" },
      deviceTrust: assessment.deviceTrust,
      automatedScreening: assessment,
      clinical: {
        status: current
          ? trail.length > 1 || current.opinion.correctsOpinionId
            ? "corrected"
            : "confirmed"
          : "unreviewed",
        ...(current ? { current } : {}),
        trail,
      },
      urgentQueue: this.queueView(sessionId),
      submissions: this.store.submissionSummary(sessionId),
    };
  }

  /** 紧急人工队列：未覆核时取自动筛查，已有意见时取最新临床行动。 */
  urgentQueue(): UrgentQueueItem[] {
    const urgent: UrgentQueueItem[] = [];
    for (const sessionId of this.store.sessions.keys()) {
      if (!this.isEffectivelyUrgent(sessionId)) {
        continue;
      }
      const session = this.store.getSession(sessionId)!;
      const assessment = this.store.getAssessment(sessionId)!;
      const review = this.store.latestReview(sessionId);
      const action = review ? review.opinion.action : assessment.action;
      if (action !== "seek-care-now") {
        continue;
      }
      const claim = this.store.claimOf(sessionId);
      urgent.push({
        sessionId,
        patientId: session.patientId,
        gestationalWeek: session.gestationalWeek,
        action,
        reading: { systolic: session.systolic, diastolic: session.diastolic },
        symptoms: [...session.symptoms],
        ruleVersion: review ? review.opinion.ruleVersion : assessment.ruleVersion,
        ...(claim ? { claimedBy: claim.by, claimedAt: claim.at } : {}),
      });
    }
    return urgent.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  /** 轮班人员领取：同时领取只有一人成功，同一人重复领取幂等。 */
  claim(sessionId: string, staffId: string, now: string = this.now()): {
    claimedBy: string;
    claimedAt: string;
  } {
    this.requireSession(sessionId);
    if (!this.isEffectivelyUrgent(sessionId)) {
      throw new NotQueuedError(sessionId);
    }
    this.store.claim(sessionId, staffId, now);
    return { claimedBy: staffId, claimedAt: now };
  }

  /** 助产士确认自动建议，形成首条分诊意见。 */
  confirm(sessionId: string, midwifeId: string, note?: string, now: string = this.now()): ClinicalReviewEntry {
    this.requireSession(sessionId);
    if (this.store.latestReview(sessionId)) {
      throw new InvalidReviewStateError("会话已有分诊意见；修改请由医生追加覆核记录");
    }
    const assessment = this.requireAssessment(sessionId);
    if (!AUTOMATED_ACTIONS.has(assessment.action as SuggestedAction)) {
      throw new InvalidReviewStateError(
        `自动筛查结论为 ${assessment.action}，无需形成分诊意见`,
      );
    }
    const entry: ClinicalReviewEntry = {
      opinion: {
        opinionId: this.newOpinionId(),
        sessionId,
        action: assessment.action as SuggestedAction,
        authorId: midwifeId,
        // 临床意见标注其确认的自动结论所依据的规则版本。
        ruleVersion: assessment.ruleVersion,
        createdAt: now,
      },
      authorRole: "midwife",
      ...(note !== undefined ? { note } : {}),
    };
    this.store.saveReview(entry);
    return entry;
  }

  /** 医生覆核：不覆盖原记录，而是追加一条带 correctsOpinionId 的纠正意见。 */
  correct(
    sessionId: string,
    doctorId: string,
    action: SuggestedAction,
    options: CorrectOptions = {},
  ): ClinicalReviewEntry {
    this.requireSession(sessionId);
    const previous = this.store.latestReview(sessionId);
    if (!previous) {
      throw new InvalidReviewStateError("尚无助产士确认的意见，不能直接覆核");
    }
    if (!AUTOMATED_ACTIONS.has(action)) {
      throw new ValidationError("纠正行动必须是 remeasure / contact-soon / seek-care-now");
    }
    const now = options.now ?? this.now();
    const entry: ClinicalReviewEntry = {
      opinion: {
        opinionId: this.newOpinionId(),
        sessionId,
        action,
        authorId: doctorId,
        ruleVersion: this.rules.versionAt(now).version,
        createdAt: now,
        correctsOpinionId: previous.opinion.opinionId,
      },
      authorRole: "doctor",
      ...(options.note !== undefined ? { note: options.note } : {}),
    };
    this.store.saveReview(entry);
    return entry;
  }

  // -- 内部 ----------------------------------------------------------------

  private requireSession(sessionId: string) {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new NotFoundError(`会话 ${sessionId} 不存在`);
    }
    return session;
  }

  private requireAssessment(sessionId: string): AutomatedAssessment {
    const assessment = this.store.getAssessment(sessionId);
    if (!assessment) {
      throw new NotFoundError(`会话 ${sessionId} 缺少自动筛查结果`);
    }
    return assessment;
  }

  private isEffectivelyUrgent(sessionId: string): boolean {
    const review = this.store.latestReview(sessionId);
    if (review) {
      return review.opinion.action === "seek-care-now";
    }
    return this.store.getAssessment(sessionId)?.urgentQueue ?? false;
  }

  private queueView(sessionId: string): TriageRecord["urgentQueue"] {
    if (!this.isEffectivelyUrgent(sessionId)) {
      return { queued: false };
    }
    const claim = this.store.claimOf(sessionId);
    return {
      queued: true,
      ...(claim ? { claimedBy: claim.by, claimedAt: claim.at } : {}),
    };
  }
}
