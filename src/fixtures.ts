/**
 * fixtures/bp-cases.json 的加载与“脱敏片段 → 可核对分诊材料”的补齐。
 *
 * 原始 fixture 只保留三类真实形态的关键事实（校准过期、重复上传、严重症状），
 * 缺少患者、设备型号、孕周、静息等核对要素。补齐口径集中在此处并显式注释，
 * 生产环境这些字段必须来自设备注册系统与患者 App，而不是服务端臆造。
 */

import { readFileSync } from "node:fs";

import type { BloodPressureSession, ValidatedDevice } from "./contracts.js";

interface FixtureCaseShape {
  sessionId: string;
  calibratedAt?: string;
  submissionIds?: string[];
  systolic: number;
  diastolic: number;
  postureConfirmed?: boolean;
  symptoms?: string[];
}

interface FixtureFile {
  cases: FixtureCaseShape[];
}

export interface PreparedCase {
  session: BloodPressureSession;
  /** 同一物理测量可能被 App 重复上传（bp-retry 携带两个相同 id）。 */
  submissionIds: string[];
}

export interface LoadedFixtures {
  /** 设备注册库：腕带/袖带型号 + 近期校准记录。 */
  registry: Map<string, ValidatedDevice>;
  cases: PreparedCase[];
}

const DEFAULT_MEASURED_AT = "2026-09-15T22:40:00Z"; // 夜间值班场景
const DEFAULT_GESTATIONAL_WEEK = 30;
const GOOD_DEVICE_ID = "dev-wrist-ok";
const OLD_DEVICE_ID = "dev-wrist-old";
const CALIBRATION_VALID_DAYS = 180;

export function loadFixtures(path: string): LoadedFixtures {
  const raw = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
  if (!raw || !Array.isArray(raw.cases)) {
    throw new Error("fixture 结构非法：缺少 cases 数组");
  }

  const registry = new Map<string, ValidatedDevice>();

  const cases: PreparedCase[] = raw.cases.map((c) => {
    // fixture 中显式给出 calibratedAt 的（bp-old-cal）→ 该会话绑定一台校准过期设备；
    // 其余会话使用近期校准过的同款腕带。
    const expired = c.calibratedAt !== undefined;
    const deviceId = expired ? OLD_DEVICE_ID : GOOD_DEVICE_ID;
    if (expired) {
      registry.set(OLD_DEVICE_ID, {
        deviceId: OLD_DEVICE_ID,
        model: "WristBP-A1",
        wearableKind: "wrist",
        calibratedAt: c.calibratedAt!,
        calibrationValidDays: CALIBRATION_VALID_DAYS,
      });
    } else {
      registry.set(GOOD_DEVICE_ID, {
        deviceId: GOOD_DEVICE_ID,
        model: "WristBP-A2",
        wearableKind: "wrist",
        calibratedAt: "2026-08-20T00:00:00Z",
        calibrationValidDays: 365,
      });
    }

    const session: BloodPressureSession = {
      sessionId: c.sessionId,
      patientId: `pat-${c.sessionId}`,
      gestationalWeek: DEFAULT_GESTATIONAL_WEEK,
      deviceId,
      measuredAt: DEFAULT_MEASURED_AT,
      systolic: c.systolic,
      diastolic: c.diastolic,
      rested: true, // fixture 未标记静息不合格
      postureConfirmed: c.postureConfirmed ?? true,
      symptoms: c.symptoms ?? [],
    };

    return {
      session,
      submissionIds: c.submissionIds && c.submissionIds.length > 0
        ? c.submissionIds
        : [`upload-${c.sessionId}`],
    };
  });

  return { registry, cases };
}
