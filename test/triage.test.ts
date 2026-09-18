import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { BloodPressureSession, ValidatedDevice } from "../src/contracts.js";
import { loadFixtures } from "../src/fixtures.js";
import {
  RULE_SET_V2026_01,
  TriageRepository,
  assessDevice,
  buildCaseView,
  evaluateTriage,
  assessMeasurement,
  latestRuleSet,
  type TriageRuleSet,
} from "../src/triage.js";

const rules = RULE_SET_V2026_01;
const measuredAt = "2026-09-15T22:40:00Z";

const goodDevice: ValidatedDevice = {
  deviceId: "dev-good",
  model: "WristBP-A2",
  wearableKind: "wrist",
  calibratedAt: "2026-08-20T00:00:00Z",
  calibrationValidDays: 365,
};

function session(overrides: Partial<BloodPressureSession> = {}): BloodPressureSession {
  return {
    sessionId: "s-1",
    patientId: "pat-1",
    gestationalWeek: 30,
    deviceId: "dev-good",
    measuredAt,
    systolic: 120,
    diastolic: 78,
    rested: true,
    postureConfirmed: true,
    symptoms: [],
    ...overrides,
  };
}

function adviceFor(s: BloodPressureSession, registry: Map<string, ValidatedDevice> = new Map([["dev-good", goodDevice]])) {
  const device = assessDevice(s.deviceId, registry, new Date(s.measuredAt));
  const measurement = assessMeasurement(s, rules);
  return evaluateTriage(s, device, measurement, rules);
}

test("设备筛查：校准过期 → 不可信，即使读数升高也只给复测", () => {
  const expired: ValidatedDevice = {
    ...goodDevice,
    deviceId: "dev-old",
    calibratedAt: "2025-11-01T00:00:00Z",
    calibrationValidDays: 180,
  };
  const registry = new Map([["dev-old", expired]]);
  const s = session({ deviceId: "dev-old", systolic: 142, diastolic: 92 });
  const device = assessDevice("dev-old", registry, new Date(measuredAt));

  assert.equal(device.trust, "calibration-expired");
  assert.equal(device.calibrationCurrent, false);
  assert.match(device.reasons.join(), /校准已过期/);

  const advice = adviceFor(s, registry);
  assert.equal(advice.action, "remeasure");
  assert.equal(advice.supportingReading, null, "脏读数不得作为分诊支撑材料");
});

test("设备筛查：未登记设备与合格设备区分开", () => {
  const registry = new Map([["dev-good", goodDevice]]);
  assert.equal(assessDevice("dev-ghost", registry, new Date(measuredAt)).trust, "unknown-device");
  assert.equal(assessDevice("dev-good", registry, new Date(measuredAt)).trust, "validated");
});

test("严重症状：姿势不合格且读数质量不足，仍立即就医并进紧急队列", () => {
  const repo = new TriageRepository();
  const s = session({
    sessionId: "bp-urgent",
    systolic: 151,
    diastolic: 96,
    postureConfirmed: false,
    symptoms: ["severe-headache", "visual-change"],
  });
  const outcome = repo.submit(s, "upload-urgent", rules, new Map([["dev-good", goodDevice]]));

  assert.equal(outcome.record.advice.action, "seek-care-now");
  assert.equal(outcome.record.advice.quality, "requires-reretake");
  assert.equal(outcome.record.advice.supportingReading, null);
  assert.equal(outcome.record.advice.symptomDriven, true);
  assert.deepEqual(outcome.record.advice.severeSymptoms, ["severe-headache", "visual-change"]);
  assert.equal(outcome.record.queueEntry?.status, "queued");
});

test("严重症状在合格测量下也成立，但不再是纯症状驱动", () => {
  const a = adviceFor(session({ systolic: 120, diastolic: 70, symptoms: ["visual-change"] }));
  assert.equal(a.action, "seek-care-now");
  assert.equal(a.symptomDriven, true);
});

test("可信 + 合格 + 升高（≥20周）→ 尽快联系；读数作为支撑材料返回", () => {
  const a = adviceFor(session({ systolic: 138, diastolic: 88 }));
  assert.equal(a.action, "contact-soon");
  assert.deepEqual(a.supportingReading, { systolic: 138, diastolic: 88 });
  assert.equal(a.ruleVersion, rules.version);
});

test("可信 + 合格 + 重度升高（≥160/110）→ 立即就医，无需症状", () => {
  assert.equal(adviceFor(session({ systolic: 160, diastolic: 100 })).action, "seek-care-now");
  assert.equal(adviceFor(session({ systolic: 150, diastolic: 110 })).action, "seek-care-now");
});

test("缺少静息确认且无症状 → 复测，读数不采信", () => {
  const a = adviceFor(session({ systolic: 150, diastolic: 99, rested: false }));
  assert.equal(a.action, "remeasure");
  assert.equal(a.supportingReading, null);
});

test("幂等：同一 submissionId 重复上传不累加次数；不同提交才计数", () => {
  const repo = new TriageRepository();
  const registry = new Map([["dev-good", goodDevice]]);
  const s = session({ sessionId: "bp-retry", systolic: 138, diastolic: 88 });

  const first = repo.submit(s, "upload-21", rules, registry);
  const second = repo.submit(s, "upload-21", rules, registry);
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.equal(second.measurementIndex, 1);
  assert.equal(repo.get("bp-retry")!.acceptedCount, 1);

  const third = repo.submit(s, "upload-22", rules, registry);
  assert.equal(third.status, "accepted");
  assert.equal(third.measurementIndex, 2);
});

test("同一 submissionId 不得挂到不同会话", () => {
  const repo = new TriageRepository();
  const registry = new Map([["dev-good", goodDevice]]);
  repo.submit(session({ sessionId: "a" }), "x", rules, registry);
  assert.throws(
    () => repo.submit(session({ sessionId: "b" }), "x", rules, registry),
    /已属于会话/,
  );
});

test("队列认领：并发仅一人成功，第二人得到 already-claimed", () => {
  const repo = new TriageRepository();
  const registry = new Map([["dev-good", goodDevice]]);
  repo.submit(
    session({ sessionId: "bp-urgent", symptoms: ["severe-headache"] }),
    "u1",
    rules,
    registry,
  );

  // 两个轮班人员同时（同一事件循环批次）领取。
  const [r1, r2] = [
    repo.claim("bp-urgent", "midwife-li"),
    repo.claim("bp-urgent", "midwife-wang"),
  ];
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "already-claimed");
  assert.equal(repo.get("bp-urgent")!.queueEntry!.claimedBy, "midwife-li");
});

test("助产士确认才形成意见；医生覆核以追加记录纠正，原意见保留", () => {
  const repo = new TriageRepository();
  const registry = new Map([["dev-good", goodDevice]]);
  repo.submit(session({ systolic: 138, diastolic: 88 }), "u1", rules, registry);

  // 确认前没有任何意见——自动建议不是意见。
  assert.equal(repo.get("s-1")!.opinions.length, 0);
  const opinion = repo.confirmOpinion("s-1", "midwife-li");
  assert.equal(opinion.action, "contact-soon");
  assert.equal(opinion.ruleVersion, rules.version);

  const correction = repo.correctOpinion("s-1", "dr-chen", "seek-care-now", opinion.opinionId);
  assert.equal(correction.correctsOpinionId, opinion.opinionId);
  assert.equal(correction.action, "seek-care-now");

  const stored = repo.get("s-1")!.opinions;
  assert.equal(stored.length, 2, "纠正为追加，不删除原始判断");
  assert.equal(stored[0]!.opinionId, opinion.opinionId);
  assert.equal(stored[1]!.correctsOpinionId, opinion.opinionId);
});

test("纠正不存在的意见应报错", () => {
  const repo = new TriageRepository();
  const registry = new Map([["dev-good", goodDevice]]);
  repo.submit(session(), "u1", rules, registry);
  assert.throws(() => repo.correctOpinion("s-1", "dr-chen", "remeasure", "ghost"), /被纠正/);
});

test("规则按版本生效：当前时刻选最新已生效版本；无生效版本报错", () => {
  const future: TriageRuleSet = {
    ...rules,
    version: "2027.01",
    effectiveFrom: "2027-01-01T00:00:00Z",
    severeSymptoms: [...rules.severeSymptoms],
  };
  assert.equal(latestRuleSet([future, rules], new Date("2026-09-15")).version, "2026.01");
  assert.throws(() => latestRuleSet([future], new Date("2026-01-01")), /No effective/);
});

test("fixtures 三类形态端到端：过期→复测、重复→计数1、严重症状→紧急", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(here, "..", "..", "fixtures", "bp-cases.json");
  const { registry, cases } = loadFixtures(fixturePath);
  const repo = new TriageRepository();

  const views = new Map(
    cases.map((c) => {
      for (const sid of c.submissionIds) repo.submit(c.session, sid, rules, registry);
      return [c.session.sessionId, buildCaseView(repo.get(c.session.sessionId)!)];
    }),
  );

  const oldCal = views.get("bp-old-cal")!;
  assert.equal(oldCal.currentAction, "remeasure");
  assert.equal(oldCal.device.trust, "calibration-expired");
  assert.equal(oldCal.supportingReading, null);
  assert.equal(oldCal.device.wearableKind, "wrist", "每条记录都关联腕带/袖带型号");
  assert.equal(oldCal.gestationalWeek, 30);

  const retry = views.get("bp-retry")!;
  assert.equal(retry.currentAction, "contact-soon");
  assert.equal(retry.submission.acceptedCount, 1);
  assert.deepEqual(retry.submission.submissionIds, ["upload-21"]);

  const urgent = views.get("bp-urgent")!;
  assert.equal(urgent.currentAction, "seek-care-now");
  assert.equal(urgent.measurement.postureConfirmed, false);
  assert.deepEqual(urgent.symptoms.severe, ["severe-headache", "visual-change"]);
  assert.equal(urgent.queue.status, "queued");
  assert.equal(urgent.ruleVersion, "2026.01");
});
