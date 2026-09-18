import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BloodPressureSession, ValidatedDevice } from "../src/contracts.ts";
import { assessSession, evaluateDeviceTrust, evaluateQuality, RuleRegistry } from "../src/rules.ts";

const rules = new RuleRegistry();
const V1 = rules.versionAt("2025-06-01T00:00:00Z");
const V2 = rules.versionAt("2026-06-01T00:00:00Z");

const freshCuff: ValidatedDevice = {
  deviceId: "cuff-1",
  model: "Cuff Pro",
  wearableKind: "cuff",
  calibratedAt: "2026-08-01T00:00:00Z",
  calibrationValidDays: 365,
};

function session(overrides: Partial<BloodPressureSession> = {}): BloodPressureSession {
  return {
    sessionId: "s1",
    patientId: "p1",
    gestationalWeek: 30,
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

describe("RuleRegistry", () => {
  it("按测量时刻选择已生效的最新版本", () => {
    assert.equal(V1.version, "bp-triage-2025-v1");
    assert.equal(V2.version, "bp-triage-2026-v2");
    assert.equal(rules.latest().version, "bp-triage-2026-v2");
  });

  it("早于任何版本生效时报错", () => {
    assert.throws(() => rules.versionAt("2024-01-01T00:00:00Z"), /尚无生效/);
  });
});

describe("设备筛查", () => {
  it("校准窗口内为 calibrated，并给出 validUntil", () => {
    const trust = evaluateDeviceTrust(freshCuff, "2026-09-10T22:00:00Z");
    assert.equal(trust.status, "calibrated");
    assert.equal(trust.validUntil, "2027-08-01T00:00:00.000Z");
  });

  it("校准过期（fixture bp-old-cal 形态）", () => {
    const trust = evaluateDeviceTrust(
      { ...freshCuff, calibratedAt: "2025-11-01T00:00:00Z", calibrationValidDays: 180 },
      "2026-09-10T22:00:00Z",
    );
    assert.equal(trust.status, "calibration-expired");
  });

  it("设备未登记为 unknown-device", () => {
    const trust = evaluateDeviceTrust(undefined, "2026-09-10T22:00:00Z");
    assert.equal(trust.status, "unknown-device");
  });
});

describe("测量质量", () => {
  it("静息与姿势均确认且读数合理才合格", () => {
    assert.equal(evaluateQuality(session()).acceptable, true);
    assert.deepEqual(evaluateQuality(session({ rested: false })).reasons, ["not-rested"]);
    assert.deepEqual(
      evaluateQuality(session({ postureConfirmed: false })).reasons,
      ["posture-unconfirmed"],
    );
    assert.deepEqual(
      evaluateQuality(session({ systolic: 300, diastolic: 80 })).reasons,
      ["reading-out-of-range"],
    );
  });
});

describe("自动筛查", () => {
  it("读数正常且质量合格：no-action，不进队列", () => {
    const a = assessSession(session(), freshCuff, V2);
    assert.equal(a.action, "no-action");
    assert.equal(a.urgentQueue, false);
    assert.equal(a.screeningOnly, true);
  });

  it("设备校准过期但血压升高：要求复测而非联系门诊", () => {
    const a = assessSession(session({ systolic: 142, diastolic: 92 }), undefined, V2);
    // undefined -> unknown-device；再单独验证过期设备
    assert.equal(a.action, "remeasure");
    const expired = assessSession(
      session({ systolic: 142, diastolic: 92, deviceId: "old" }),
      { ...freshCuff, deviceId: "old", calibratedAt: "2025-11-01T00:00:00Z", calibrationValidDays: 180 },
      V2,
    );
    assert.equal(expired.action, "remeasure");
    assert.equal(expired.deviceTrust.status, "calibration-expired");
  });

  it("血压升高、读数可采信：尽快联系", () => {
    const a = assessSession(session({ systolic: 144, diastolic: 88 }), freshCuff, V2);
    assert.equal(a.action, "contact-soon");
  });

  it("血压达重度阈值：立即就医并入队", () => {
    const a = assessSession(session({ systolic: 162, diastolic: 105 }), freshCuff, V2);
    assert.equal(a.action, "seek-care-now");
    assert.equal(a.urgentQueue, true);
  });

  it("v2：严重症状 + 姿势未确认（fixture bp-urgent 形态）仍直入紧急队列", () => {
    const a = assessSession(
      session({ systolic: 151, diastolic: 96, postureConfirmed: false, symptoms: ["severe-headache", "visual-change"] }),
      freshCuff,
      V2,
    );
    assert.equal(a.action, "seek-care-now");
    assert.equal(a.urgentQueue, true);
    assert.deepEqual(a.triggeredSevereSymptoms, ["severe-headache", "visual-change"]);
    assert.ok(a.basis.includes("rule:symptom-overrides-quality"));
  });

  it("v1：严重症状但读数质量不足时只要求复测", () => {
    const a = assessSession(
      session({
        measuredAt: "2025-09-10T22:00:00Z",
        postureConfirmed: false,
        symptoms: ["severe-headache"],
      }),
      freshCuff,
      V1,
    );
    assert.equal(a.action, "remeasure");
    assert.equal(a.urgentQueue, false);
  });

  it("严重症状 + 合格读数：任何版本都立即就医", () => {
    const a = assessSession(
      session({ symptoms: ["visual-change"] }),
      freshCuff,
      V1,
    );
    assert.equal(a.action, "seek-care-now");
  });

  it("自动结论携带机器可核对依据", () => {
    const a = assessSession(
      session({ systolic: 151, diastolic: 96, postureConfirmed: false, symptoms: ["severe-headache"] }),
      freshCuff,
      V2,
    );
    assert.ok(a.basis.includes("device:calibrated"));
    assert.ok(a.basis.includes("quality:posture-unconfirmed"));
    assert.ok(a.basis.some((b) => b.startsWith("symptom:")));
  });
});
