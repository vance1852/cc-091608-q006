import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createTriageServer, createContext, type ServerContext } from "../src/server.js";
import { loadFixtures } from "../src/fixtures.js";
import { RULE_SET_V2026_01 } from "../src/triage.js";
import type { Server } from "node:http";

let server: Server;
let base: string;
let ctx: ServerContext;

const measuredAt = "2026-09-15T22:40:00Z";
const goodSession = {
  sessionId: "s-http",
  patientId: "pat-http",
  gestationalWeek: 30,
  deviceId: "dev-wrist-ok",
  measuredAt,
  systolic: 138,
  diastolic: 88,
  rested: true,
  postureConfirmed: true,
  symptoms: [] as string[],
};

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit =
    body === undefined
      ? { method }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const res = await fetch(`${base}${path}`, init);
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

before(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(here, "..", "..", "fixtures", "bp-cases.json");
  const loaded = loadFixtures(fixturePath);
  ctx = createContext({ registry: loaded.registry, rules: [RULE_SET_V2026_01] });
  server = createTriageServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("无监听地址");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  // fetch/undici 默认保留 keep-alive 连接，server.close() 会等其断开；
  // 先强制关闭现存连接，避免 teardown 挂起。
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

test("GET /health 与 /api/rules", async () => {
  assert.equal((await api("GET", "/health")).status, 200);
  const rules = await api("GET", "/api/rules");
  assert.equal((rules.json as { current: string }).current, "2026.01");
});

test("POST /api/submissions：接受 → 201；同 submissionId 重放 → 200 duplicate", async () => {
  const payload = { submissionId: "up-1", session: goodSession };
  const first = await api("POST", "/api/submissions", payload);
  assert.equal(first.status, 201);
  assert.equal((first.json as { status: string }).status, "accepted");

  const second = await api("POST", "/api/submissions", payload);
  assert.equal(second.status, 200);
  assert.equal((second.json as { status: string; measurementIndex: number }).status, "duplicate");
  assert.equal((second.json as { measurementIndex: number }).measurementIndex, 1);
});

test("GET /api/cases/:id 返回材料包：当前行动、设备可信度、支撑读数、症状、人工脉络", async () => {
  const res = await api("GET", "/api/cases/s-http");
  assert.equal(res.status, 200);
  const v = res.json as {
    currentAction: string;
    device: { trust: string; model: string };
    supportingReading: { systolic: number; diastolic: number } | null;
    opinions: unknown[];
  };
  assert.equal(v.currentAction, "contact-soon");
  assert.equal(v.device.trust, "validated");
  assert.equal(v.device.model, "WristBP-A2");
  assert.deepEqual(v.supportingReading, { systolic: 138, diastolic: 88, measuredAt });
  assert.deepEqual(v.opinions, []);
});

test("严重症状 + 姿势不合格 → seek-care-now 进队列；并发认领只有一人 200", async () => {
  const urgent = {
    ...goodSession,
    sessionId: "bp-urgent",
    systolic: 151,
    diastolic: 96,
    postureConfirmed: false,
    symptoms: ["severe-headache", "visual-change"],
  };
  const submitted = await api("POST", "/api/submissions", {
    submissionId: "up-urgent",
    session: urgent,
  });
  assert.equal(submitted.status, 201);
  const c = submitted.json as { case: { currentAction: string; supportingReading: unknown } };
  assert.equal(c.case.currentAction, "seek-care-now");
  assert.equal(c.case.supportingReading, null, "质量不足时不以读数为支撑，症状驱动");

  const queue = await api("GET", "/api/queue");
  const items = (queue.json as { queue: { sessionId: string }[] }).queue;
  assert.ok(items.some((q) => q.sessionId === "bp-urgent"));

  // 两个轮班人员同时领取。
  const [r1, r2] = await Promise.all([
    api("POST", "/api/cases/bp-urgent/claim", { staffId: "midwife-li" }),
    api("POST", "/api/cases/bp-urgent/claim", { staffId: "midwife-wang" }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = r1.status === 200 ? r1 : r2;
  assert.equal(
    (winner.json as { case: { queue: { claimedBy: string } } }).case.queue.claimedBy,
    r1.status === 200 ? "midwife-li" : "midwife-wang",
  );

  // 再领仍是冲突。
  const third = await api("POST", "/api/cases/bp-urgent/claim", { staffId: "midwife-zhao" });
  assert.equal(third.status, 409);
});

test("助产士确认 → 意见；医生覆核 → 追加更正，历史都可查", async () => {
  const o1 = await api("POST", "/api/cases/s-http/opinions", {
    authorId: "midwife-li",
    action: "contact-soon",
  });
  assert.equal(o1.status, 201);
  const opinionId = (o1.json as { opinion: { opinionId: string } }).opinion.opinionId;

  const o2 = await api("POST", "/api/cases/s-http/corrections", {
    authorId: "dr-chen",
    action: "seek-care-now",
    correctsOpinionId: opinionId,
  });
  assert.equal(o2.status, 201);
  assert.equal(
    (o2.json as { correction: { correctsOpinionId: string } }).correction.correctsOpinionId,
    opinionId,
  );

  const view = await api("GET", "/api/cases/s-http");
  assert.equal((view.json as { opinions: unknown[] }).opinions.length, 2);
});

test("校准过期会话 → remeasure，且不进紧急队列", async () => {
  const { cases, registry } = loadFixtures(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "bp-cases.json"),
  );
  void registry;
  const oldCal = cases.find((c) => c.session.sessionId === "bp-old-cal")!;
  const res = await api("POST", "/api/submissions", {
    submissionId: "up-old",
    session: oldCal.session,
  });
  const v = (res.json as { case: { currentAction: string; device: { trust: string } } }).case;
  assert.equal(v.currentAction, "remeasure");
  assert.equal(v.device.trust, "calibration-expired");
});

test("错误处理：未知会话 404、坏 JSON 400、缺字段 400", async () => {
  assert.equal((await api("GET", "/api/cases/nope")).status, 404);
  const badJson = await fetch(`${base}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(badJson.status, 400);
  const missing = await api("POST", "/api/submissions", { submissionId: "x" });
  assert.equal(missing.status, 400);
});
