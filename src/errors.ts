export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super("not-found", message);
  }
}

/** 紧急队列条目已被另一名轮班人员领取。 */
export class AlreadyClaimedError extends DomainError {
  readonly sessionId: string;
  readonly claimedBy: string;

  constructor(sessionId: string, claimedBy: string) {
    super("already-claimed", `会话 ${sessionId} 已由 ${claimedBy} 领取`);
    this.sessionId = sessionId;
    this.claimedBy = claimedBy;
  }
}

export class NotQueuedError extends DomainError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super("not-in-queue", `会话 ${sessionId} 当前不在紧急人工队列中`);
    this.sessionId = sessionId;
  }
}

/** 该人工状态下不允许此操作（如未确认就纠正、重复确认）。 */
export class InvalidReviewStateError extends DomainError {
  constructor(message: string) {
    super("invalid-review-state", message);
  }
}

/** 设备已登记但内容不一致（型号、校准窗口冲突）。 */
export class DeviceConflictError extends DomainError {
  constructor(message: string) {
    super("device-conflict", message);
  }
}

/** 入参本身不满足契约。 */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super("validation", message);
  }
}
