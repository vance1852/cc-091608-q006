import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BloodPressureSession, ValidatedDevice } from "../src/contracts.ts";
import { AlreadyClaimedError, InvalidReviewStateError, NotQueuedError } from "../src/errors.ts";
import { InMemoryStore } from "../src/store.ts";
import { TriageService } from "../src/triage-service.ts";

const freshDevice: ValidatedDevice = {
  deviceId: "cuff-1",
  model: "Cuff Pro",
  wearableKind: "cuff",
  calibratedAt: "2026-08-01T00:00:00Z",
  calibrationValidDays: 365,
};

function sessionInput(overrides: Partial<BloodPressureSession> = {}): BloodPressureSession {
  return {
    sessionId: "s1",
    patientId: "p1",
    gestationalWeek: 28,
    deviceId: "cuff-1",
    measuredAt: "2026-09-10T22:00:00Z",
    systolic: 120,
    diastolic: 80,
    rested: true,
    postureConfirmed: true,
    symptoms: [],
    ...overrides,
  };
}

function makeService(now = "2026-09-10T23:00:00Z"): TriageService {
  const store = new InMemoryStore();
  const service = new TriageService(store, {
    now: () => now,
    newOpinionId: (() => {
      let n = 0;
      return () => `op-${++n}`;
    })(),
  });
  service.registerDevice(freshDevice);
  return service;
}

describe("提交幂等", () => {
  it("同一会话同一提交标识反复上传不累加次数、不重新评估", () => {
    const service = makeService();
    const first = service.submit(sessionInput(), "upload-1");
    assert.equal(first.deduplicated, false);
    assert.deepEqual(first.submissions.accepted, ["upload-1"]);

    const replay = service.submit(sessionInput(), "upload-1");
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(replay.submissions.accepted, ["upload-1"]);
    assert.equal(replay.submissions.deduplicatedReplays, 1);

    // 再次重放仍只累计重放计数，不新增已接受提交
    const replayAgain = service.submit(sessionInput(), "upload-1");
    assert.equal(replayAgain.deduplicated, true);
    assert.deepEqual(replayAgain.submissions.accepted, ["upload-1"]);
    assert.equal(replayAgain.submissions.deduplicatedReplays, 2);
  });

  it("新的重测会话使用新会话标识，可以正常提交", () => {
    const service = makeService();
    service.submit(sessionInput(), "upload-1");
    const receipt = service.submit(sessionInput({ sessionId: "s2" }), "upload-2");
    assert.equal(receipt.deduplicated, false);
    assert.deepEqual(receipt.submissions.accepted, ["upload-2"]);
  });

  it("不同提交标识但同一会话内容冲突时拒绝", () => {
    const service = makeService();
    service.submit(sessionInput(), "upload-1");
    assert.throws(
      () => service.submit(sessionInput({ systolic: 150 }), "upload-2"),
      InvalidReviewStateError,
    );
  });
});

describe("分诊材料", () => {
  it("返回当前行动、设备可信度、读数症状与自动依据", () => {
    const service = makeService();
    service.submit(sessionInput({ systolic: 145, diastolic: 92 }), "u1");
    const record = service.record("s1");
    assert.equal(record.currentAction.action, "contact-soon");
    assert.equal(record.currentAction.source, "automated-screening");
    assert.equal(record.deviceTrust.status, "calibrated");
    assert.equal(record.reading.systolic, 145);
    assert.equal(record.clinical.status, "unreviewed");
    assert.equal(record.automatedScreening.screeningOnly, true);
    assert.ok(record.automatedScreening.basis.includes("rule:bp-elevated"));
  });
});

describe("紧急队列领取互斥", () => {
  function urgentService(): TriageService {
    const service = makeService();
    service.submit(
      sessionInput({ systolic: 151, diastolic: 96, symptoms: ["severe-headache", "visual-change"] }),
      "u1",
    );
    return service;
  }

  it("同时领取只有一人成功", () => {
    const service = urgentService();
    assert.deepEqual(service.claim("s1", "midwife-a"), {
      claimedBy: "midwife-a",
      claimedAt: "2026-09-10T23:00:00Z",
    });
    assert.throws(() => service.claim("s1", "midwife-b"), AlreadyClaimedError);
  });

  it("同一人重复领取幂等", () => {
    const service = urgentService();
    service.claim("s1", "midwife-a");
    assert.doesNotThrow(() => service.claim("s1", "midwife-a"));
  });

  it("非紧急会话不能领取", () => {
    const service = makeService();
    service.submit(sessionInput(), "u1");
    assert.throws(() => service.claim("s1", "midwife-a"), NotQueuedError);
  });

  it("队列条目携带孕周、读数与症状", () => {
    const service = urgentService();
    const [item] = service.urgentQueue();
    assert.equal(item!.sessionId, "s1");
    assert.equal(item!.gestationalWeek, 28);
    assert.deepEqual(item!.symptoms, ["severe-headache", "visual-change"]);
  });
});

describe("助产士确认与医生覆核", () => {
  it("助产士确认后当前行动来源切换为临床意见", () => {
    const service = makeService();
    service.submit(sessionInput({ systolic: 145, diastolic: 92 }), "u1");
    const entry = service.confirm("s1", "midwife-a", "已回拨");
    assert.equal(entry.authorRole, "midwife");
    assert.equal(entry.opinion.action, "contact-soon");
    const record = service.record("s1");
    assert.equal(record.currentAction.source, "clinical-opinion");
    assert.equal(record.clinical.status, "confirmed");
    assert.equal(record.clinical.trail.length, 1);
  });

  it("不能重复确认", () => {
    const service = makeService();
    service.submit(sessionInput({ systolic: 145, diastolic: 92 }), "u1");
    service.confirm("s1", "midwife-a");
    assert.throws(() => service.confirm("s1", "midwife-b"), InvalidReviewStateError);
  });

  it("读数正常（no-action）不能形成分诊意见", () => {
    const service = makeService();
    service.submit(sessionInput(), "u1");
    assert.throws(() => service.confirm("s1", "midwife-a"), InvalidReviewStateError);
  });

  it("医生追加纠正记录且不覆盖原意见", () => {
    const service = makeService();
    service.submit(sessionInput({ systolic: 145, diastolic: 92 }), "u1");
    service.confirm("s1", "midwife-a", "腕带读数升高");
    const corrected = service.correct("s1", "doctor-lu", "remeasure", {
      note: "设备型号已停产，要求医用袖带复测",
    });
    assert.equal(corrected.authorRole, "doctor");
    assert.equal(corrected.opinion.correctsOpinionId, "op-1");
    const record = service.record("s1");
    assert.equal(record.clinical.status, "corrected");
    assert.equal(record.clinical.trail.length, 2);
    assert.equal(record.clinical.current!.opinion.action, "remeasure");
    assert.equal(record.clinical.trail[0]!.opinion.action, "contact-soon");
    assert.equal(record.clinical.trail[1]!.opinion.correctsOpinionId, "op-1");
  });

  it("未确认不能直接覆核", () => {
    const service = makeService();
    service.submit(sessionInput({ systolic: 145, diastolic: 92 }), "u1");
    assert.throws(() => service.correct("s1", "doctor-lu", "remeasure"), InvalidReviewStateError);
  });

  it("医生把立即就医纠正为尽快联系后退出紧急队列并释放领取锁", () => {
    const service = makeService();
    service.submit(
      sessionInput({ systolic: 151, diastolic: 96, symptoms: ["severe-headache"] }),
      "u1",
    );
    service.claim("s1", "midwife-a");
    service.confirm("s1", "midwife-a");
    service.correct("s1", "doctor-lu", "contact-soon", { note: "症状为偏头痛史" });
    assert.equal(service.urgentQueue().length, 0);
    const record = service.record("s1");
    assert.equal(record.urgentQueue.queued, false);
    assert.equal(record.urgentQueue.claimedBy, undefined);
  });
});
