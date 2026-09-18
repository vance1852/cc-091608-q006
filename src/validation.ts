import type { BloodPressureSession, ValidatedDevice } from "./contracts.ts";
import { ValidationError } from "./errors.ts";

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} 必须是非空字符串`);
  }
  return value;
}

function requireIsoDate(value: unknown, field: string): string {
  const s = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(s))) {
    throw new ValidationError(`${field} 必须是合法的 ISO 时间: ${s}`);
  }
  return s;
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} 必须是 ${min}..${max} 的整数`);
  }
  return value;
}

export function validateDevice(input: unknown): ValidatedDevice {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("设备信息必须是对象");
  }
  const obj = input as Record<string, unknown>;
  const device: ValidatedDevice = {
    deviceId: requireNonEmptyString(obj.deviceId, "deviceId"),
    model: requireNonEmptyString(obj.model, "model"),
    wearableKind: obj.wearableKind === "wrist" || obj.wearableKind === "cuff"
      ? obj.wearableKind
      : (() => {
          throw new ValidationError("wearableKind 必须是 wrist 或 cuff");
        })(),
    calibratedAt: requireIsoDate(obj.calibratedAt, "calibratedAt"),
    calibrationValidDays: requireInt(obj.calibrationValidDays, "calibrationValidDays", 0, 3650),
  };
  return device;
}

export function validateSession(input: unknown): BloodPressureSession {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("测量会话必须是对象");
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.symptoms) || !obj.symptoms.every((s) => typeof s === "string")) {
    throw new ValidationError("symptoms 必须是字符串数组");
  }
  const symptoms = obj.symptoms as string[];
  if (new Set(symptoms).size !== symptoms.length) {
    throw new ValidationError("symptoms 含重复条目");
  }
  const session: BloodPressureSession = {
    sessionId: requireNonEmptyString(obj.sessionId, "sessionId"),
    patientId: requireNonEmptyString(obj.patientId, "patientId"),
    gestationalWeek: requireInt(obj.gestationalWeek, "gestationalWeek", 0, 45),
    deviceId: requireNonEmptyString(obj.deviceId, "deviceId"),
    measuredAt: requireIsoDate(obj.measuredAt, "measuredAt"),
    systolic: requireInt(obj.systolic, "systolic", 0, 300),
    diastolic: requireInt(obj.diastolic, "diastolic", 0, 220),
    rested: obj.rested === true,
    postureConfirmed: obj.postureConfirmed === true,
    symptoms: [...symptoms],
  };
  if (session.diastolic >= session.systolic) {
    throw new ValidationError("舒张压必须小于收缩压");
  }
  return session;
}
