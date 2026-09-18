/**
 * 孕期血压异常分诊 HTTP 后端（node:http，无第三方框架）。
 *
 * 路由：
 *  GET  /health
 *  GET  /api/rules
 *  POST /api/devices                 登记/更新已验证设备（腕带或袖带 + 校准）
 *  POST /api/submissions             幂等提交测量 { submissionId, session, ruleVersion? }
 *  GET  /api/cases/:sessionId        当前行动 + 设备可信度 + 支撑读数/症状 + 人工脉络
 *  GET  /api/queue                   紧急人工队列
 *  POST /api/cases/:sessionId/claim  轮班认领（条件写入，并发仅一人成功）
 *  POST /api/cases/:sessionId/resolve
 *  POST /api/cases/:sessionId/opinions     助产士确认 → 分诊意见
 *  POST /api/cases/:sessionId/corrections  医生覆核 → 追加更正记录
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { BloodPressureSession, SuggestedAction, ValidatedDevice } from "./contracts.js";
import {
  RULE_SET_V2026_01,
  TriageRepository,
  buildCaseView,
  latestRuleSet,
  type TriageCaseView,
  type TriageRuleSet,
} from "./triage.js";

export interface ServerContext {
  repo: TriageRepository;
  registry: Map<string, ValidatedDevice>;
  rules: TriageRuleSet[];
}

export function createContext(seed?: {
  registry?: Map<string, ValidatedDevice>;
  rules?: TriageRuleSet[];
}): ServerContext {
  return {
    repo: new TriageRepository(),
    registry: seed?.registry ?? new Map(),
    rules: seed?.rules ?? [RULE_SET_V2026_01],
  };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) reject(new Error("body-too-large"));
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        // 必须在 end 回调内 reject：此处抛出的异常不会被外层 async 捕获。
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function resolveRule(
  rules: readonly TriageRuleSet[],
  pinnedVersion: string | undefined,
  now: Date,
): TriageRuleSet {
  if (!pinnedVersion) return latestRuleSet(rules, now);
  const found = rules.find((r) => r.version === pinnedVersion);
  if (!found) throw new Error(`未知规则版本 ${pinnedVersion}`);
  if (Date.parse(found.effectiveFrom) > now.getTime()) {
    throw new Error(`规则版本 ${pinnedVersion} 尚未生效`);
  }
  return found;
}

function toSession(raw: unknown): BloodPressureSession {
  const o = requireObject(raw, "session");
  const required: (keyof BloodPressureSession)[] = [
    "sessionId",
    "patientId",
    "gestationalWeek",
    "deviceId",
    "measuredAt",
    "systolic",
    "diastolic",
    "rested",
    "postureConfirmed",
    "symptoms",
  ];
  for (const key of required) {
    if (!(key in o)) throw new Error(`session.${key} 缺失`);
  }
  if (typeof o.sessionId !== "string" || typeof o.patientId !== "string") {
    throw new Error("session.sessionId/patientId 必须是字符串");
  }
  if (typeof o.deviceId !== "string" || typeof o.measuredAt !== "string") {
    throw new Error("session.deviceId/measuredAt 必须是字符串");
  }
  if (!Number.isFinite(o.gestationalWeek) || !Number.isFinite(o.systolic) ||
      !Number.isFinite(o.diastolic)) {
    throw new Error("孕周与血压读数必须是数字");
  }
  if (typeof o.rested !== "boolean" || typeof o.postureConfirmed !== "boolean") {
    throw new Error("rested/postureConfirmed 必须是布尔值");
  }
  if (!Array.isArray(o.symptoms) || !o.symptoms.every((s) => typeof s === "string")) {
    throw new Error("symptoms 必须是字符串数组");
  }
  return {
    sessionId: o.sessionId,
    patientId: o.patientId,
    gestationalWeek: o.gestationalWeek as number,
    deviceId: o.deviceId,
    measuredAt: o.measuredAt,
    systolic: o.systolic as number,
    diastolic: o.diastolic as number,
    rested: o.rested,
    postureConfirmed: o.postureConfirmed,
    symptoms: o.symptoms as string[],
  };
}

export function createTriageServer(ctx: ServerContext = createContext()): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";
      const now = new Date();

      if (method === "GET" && path === "/health") {
        send(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && path === "/api/rules") {
        send(res, 200, {
          rules: ctx.rules.map((r) => ({
            version: r.version,
            effectiveFrom: r.effectiveFrom,
            severeSymptoms: [...r.severeSymptoms],
            elevatedBp: { ...r.elevatedBp },
            severeBp: { ...r.severeBp },
            contactGestationalWeek: r.contactGestationalWeek,
          })),
          current: latestRuleSet(ctx.rules, now).version,
        });
        return;
      }

      if (method === "POST" && path === "/api/devices") {
        const body = requireObject(await readJson(req), "body");
        const device = body.device as ValidatedDevice;
        const d = requireObject(device, "device");
        for (const key of ["deviceId", "model", "wearableKind", "calibratedAt", "calibrationValidDays"] as const) {
          if (!(key in d)) throw new Error(`device.${key} 缺失`);
        }
        if (d.wearableKind !== "wrist" && d.wearableKind !== "cuff") {
          throw new Error("wearableKind 只能是 wrist 或 cuff");
        }
        ctx.registry.set(String(d.deviceId), device);
        send(res, 200, { device });
        return;
      }

      if (method === "POST" && path === "/api/submissions") {
        const body = requireObject(await readJson(req), "body");
        const submissionId = body.submissionId;
        if (typeof submissionId !== "string" || submissionId.length === 0) {
          throw new Error("submissionId 必须是非空字符串");
        }
        const session = toSession(body.session);
        const rule = resolveRule(ctx.rules,
          typeof body.ruleVersion === "string" ? body.ruleVersion : undefined, now);

        const outcome = ctx.repo.submit(session, submissionId, rule, ctx.registry, now);
        send(res, outcome.status === "duplicate" ? 200 : 201, {
          status: outcome.status,
          measurementIndex: outcome.measurementIndex,
          case: buildCaseView(outcome.record),
        });
        return;
      }

      const caseMatch = path.match(/^\/api\/cases\/([^/]+)(\/(claim|resolve|opinions|corrections))?$/);
      if (caseMatch) {
        const sessionId = decodeURIComponent(caseMatch[1]!);
        const sub = caseMatch[3];
        const record = ctx.repo.get(sessionId);
        if (!record) {
          error(res, 404, "case-not-found", `会话 ${sessionId} 不存在`);
          return;
        }

        if (!sub && method === "GET") {
          const view: TriageCaseView = buildCaseView(record);
          send(res, 200, view);
          return;
        }

        if (sub === "claim" && method === "POST") {
          const body = requireObject(await readJson(req), "body");
          if (typeof body.staffId !== "string") throw new Error("staffId 必须是字符串");
          const result = ctx.repo.claim(sessionId, body.staffId, now);
          if (!result.ok) {
            // 轮班同时领取：第二人得到 409，第一名认领保持不变。
            send(res, 409, { ok: false, reason: result.reason, case: buildCaseView(record) });
            return;
          }
          send(res, 200, { ok: true, case: buildCaseView(result.record) });
          return;
        }

        if (sub === "resolve" && method === "POST") {
          ctx.repo.resolve(sessionId, now);
          send(res, 200, { ok: true, case: buildCaseView(ctx.repo.get(sessionId)!) });
          return;
        }

        if (sub === "opinions" && method === "POST") {
          const body = requireObject(await readJson(req), "body");
          if (typeof body.authorId !== "string") throw new Error("authorId 必须是字符串");
          let action: SuggestedAction | undefined;
          if (body.action !== undefined) {
            if (!["remeasure", "contact-soon", "seek-care-now"].includes(String(body.action))) {
              throw new Error("action 非法");
            }
            action = body.action as SuggestedAction;
          }
          const opinion = ctx.repo.confirmOpinion(sessionId, body.authorId, now, action);
          send(res, 201, { opinion, case: buildCaseView(ctx.repo.get(sessionId)!) });
          return;
        }

        if (sub === "corrections" && method === "POST") {
          const body = requireObject(await readJson(req), "body");
          if (typeof body.authorId !== "string") throw new Error("authorId 必须是字符串");
          if (typeof body.correctsOpinionId !== "string") {
            throw new Error("correctsOpinionId 必须是字符串");
          }
          if (!["remeasure", "contact-soon", "seek-care-now"].includes(String(body.action))) {
            throw new Error("action 非法");
          }
          const correction = ctx.repo.correctOpinion(
            sessionId,
            body.authorId,
            body.action as SuggestedAction,
            body.correctsOpinionId,
            now,
          );
          send(res, 201, { correction, case: buildCaseView(ctx.repo.get(sessionId)!) });
          return;
        }
      }

      if (method === "GET" && path === "/api/queue") {
        const items: unknown[] = [];
        // 仓库内部 Map 不直接暴露；通过视图枚举。
        for (const id of ctx.repo.sessionIds()) {
          const record = ctx.repo.get(id)!;
          if (record.queueEntry) items.push(buildCaseView(record));
        }
        send(res, 200, { queue: items });
        return;
      }

      error(res, 404, "not-found", `无此路由：${method} ${path}`);
    } catch (err) {
      if (err instanceof SyntaxError) {
        error(res, 400, "bad-json", "请求体不是合法 JSON");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("必须") || message.includes("缺失") || message.includes("非法") ||
          message.includes("未知规则") || message.includes("尚未生效") || message.includes("属于") ||
          message.includes("被纠正") || message.includes("不在紧急队列") || message.includes("未知会话")) {
        error(res, 400, "bad-request", message);
        return;
      }
      error(res, 500, "internal", message);
    }
  });
}
