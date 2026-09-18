import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { seedFromFixtureFile } from "../src/seed.ts";
import { InMemoryStore } from "../src/store.ts";
import { TriageService } from "../src/triage-service.ts";

async function seededService(): Promise<TriageService> {
  const store = new InMemoryStore();
  const service = new TriageService(store, { now: () => "2026-09-10T23:00:00Z" });
  const fixturePath = fileURLToPath(new URL("../fixtures/bp-cases.json", import.meta.url));
  await seedFromFixtureFile(service, fixturePath);
  return service;
}

describe("bp-cases.json 三类真实形态", () => {
  it("bp-old-cal：校准过期，即使血压升高也只要求复测", async () => {
    const service = await seededService();
    const record = service.record("bp-old-cal");
    assert.equal(record.deviceTrust.status, "calibration-expired");
    assert.equal(record.deviceTrust.wearableKind, "wrist");
    assert.equal(record.currentAction.action, "remeasure");
    assert.equal(record.gestationalWeek, 32);
    assert.ok(record.automatedScreening.basis.includes("device:calibration-expired"));
    assert.equal(record.clinical.status, "unreviewed");
    assert.equal(record.urgentQueue.queued, false);
  });

  it("bp-retry：重复上传只计数一次", async () => {
    const service = await seededService();
    assert.deepEqual(recordOf(service).submissions.accepted, ["upload-21"]);
    assert.equal(recordOf(service).submissions.deduplicatedReplays, 1);
  });

  function recordOf(service: TriageService) {
    return service.record("bp-retry");
  }

  it("bp-retry：读数 138/88 低于 140/90 阈值，设备与质量可信时无需行动", async () => {
    const service = await seededService();
    const record = service.record("bp-retry");
    assert.equal(record.deviceTrust.status, "calibrated");
    assert.equal(record.currentAction.action, "no-action");
    assert.equal(record.urgentQueue.queued, false);
  });

  it("bp-urgent：姿势未确认但严重症状仍直入紧急人工队列", async () => {
    const service = await seededService();
    const record = service.record("bp-urgent");
    assert.equal(record.automatedScreening.quality.acceptable, false);
    assert.equal(record.currentAction.action, "seek-care-now");
    assert.equal(record.urgentQueue.queued, true);
    assert.deepEqual(record.symptoms, ["severe-headache", "visual-change"]);
    assert.ok(record.automatedScreening.basis.includes("rule:symptom-overrides-quality"));
  });

  it("队列中只有 bp-urgent，且领取互斥", async () => {
    const service = await seededService();
    const queue = service.urgentQueue();
    assert.deepEqual(queue.map((i) => i.sessionId), ["bp-urgent"]);
    service.claim("bp-urgent", "night-midwife-1");
    assert.throws(() => service.claim("bp-urgent", "night-midwife-2"), /已由/);
  });

  it("人工确认与医生覆核形成完整脉络，且自动筛查记录始终保留", async () => {
    const service = await seededService();
    service.claim("bp-urgent", "night-midwife-1");
    service.confirm("bp-urgent", "night-midwife-1", "回拨未接，已联系家属");
    const trailBefore = service.record("bp-urgent").clinical.trail;
    assert.equal(trailBefore.length, 1);

    service.correct("bp-urgent", "obgyn-lu", "seek-care-now", {
      note: "到院评估，维持立即就医",
      now: "2026-09-10T23:30:00Z",
    });
    const record = service.record("bp-urgent");
    assert.equal(record.clinical.trail.length, 2);
    assert.equal(record.clinical.status, "corrected");
    assert.equal(record.clinical.current!.opinion.correctsOpinionId,
      record.clinical.trail[0]!.opinion.opinionId);
    // 自动材料仍可核对
    assert.equal(record.automatedScreening.action, "seek-care-now");
    assert.equal(record.automatedScreening.screeningOnly, true);
    assert.equal(record.currentAction.source, "clinical-opinion");
  });
});
