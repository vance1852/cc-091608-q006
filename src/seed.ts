import { readFile } from "node:fs/promises";
import type { BloodPressureSession, ValidatedDevice } from "./contracts.ts";
import { TriageService } from "./triage-service.ts";

/**
 * fixtures/bp-cases.json 的原始形态：只保留三类真实病灶，
 * 其余可核对字段由装载器按夜间值班场景补默认值。
 */
export interface FixtureCase {
  sessionId: string;
  /** 存在时表示该会话所用腕带的上次校准时间（bp-old-cal 用它表达校准过期）。 */
  calibratedAt?: string;
  /** 同一上传标识出现多次表示重复上传（bp-retry）。 */
  submissionIds?: string[];
  systolic: number;
  diastolic: number;
  postureConfirmed?: boolean;
  symptoms?: string[];
}

interface FixtureFile {
  cases: FixtureCase[];
}

/** 统一的夜间测量时刻（2026 规则 v2 已生效）。 */
export const FIXTURE_MEASURED_AT = "2026-09-10T22:30:00Z";
export const FIXTURE_PATIENT = "patient-2718";
export const FIXTURE_GESTATIONAL_WEEK = 32;
export const FRESH_DEVICE: ValidatedDevice = {
  deviceId: "wrist-a11y-fresh",
  model: "WristBand A11y",
  wearableKind: "wrist",
  calibratedAt: "2026-08-01T00:00:00Z",
  calibrationValidDays: 365,
};

function deviceFor(fixture: FixtureCase): ValidatedDevice {
  if (fixture.calibratedAt) {
    // 校准窗口 180 天：2025-11-01 -> 2026-05-01，对 2026-09 的测量已过期。
    return {
      deviceId: `device-${fixture.sessionId}`,
      model: "WristBand Legacy",
      wearableKind: "wrist",
      calibratedAt: fixture.calibratedAt,
      calibrationValidDays: 180,
    };
  }
  return { ...FRESH_DEVICE };
}

function sessionFor(fixture: FixtureCase, device: ValidatedDevice): BloodPressureSession {
  return {
    sessionId: fixture.sessionId,
    patientId: FIXTURE_PATIENT,
    gestationalWeek: FIXTURE_GESTATIONAL_WEEK,
    deviceId: device.deviceId,
    measuredAt: FIXTURE_MEASURED_AT,
    systolic: fixture.systolic,
    diastolic: fixture.diastolic,
    rested: true,
    postureConfirmed: fixture.postureConfirmed ?? true,
    symptoms: [...(fixture.symptoms ?? [])],
  };
}

export interface SeededSession {
  sessionId: string;
  submissionIds: string[];
  deduplicatedReplays: number;
}

/**
 * 用 fixture 装载一台全新服务：登记设备、逐次提交（含重放），
 * 返回每个会话的提交结果。
 */
export async function seedFromFixtureFile(
  service: TriageService,
  fixturePath: string,
): Promise<SeededSession[]> {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as FixtureFile;
  return seedFromCases(service, raw.cases);
}

export function seedFromCases(service: TriageService, cases: readonly FixtureCase[]): SeededSession[] {
  const results: SeededSession[] = [];
  for (const fixture of cases) {
    const device = deviceFor(fixture);
    service.registerDevice(device);
    const session = sessionFor(fixture, device);
    const submissionIds = fixture.submissionIds?.length
      ? fixture.submissionIds
      : [`upload-${fixture.sessionId}`];

    let deduplicatedReplays = 0;
    for (const submissionId of submissionIds) {
      const receipt = service.submit(session, submissionId);
      if (receipt.deduplicated) {
        deduplicatedReplays += 1;
      }
    }
    results.push({ sessionId: fixture.sessionId, submissionIds, deduplicatedReplays });
  }
  return results;
}
