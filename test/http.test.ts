import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createTriageServer } from "../src/http-server.ts";
import { InMemoryStore } from "../src/store.ts";
import { TriageService } from "../src/triage-service.ts";

let server: Server;
let baseUrl: string;

const session = {
  sessionId: "http-s1",
  patientId: "p-9",
  gestationalWeek: 31,
  deviceId: "cuff-9",
  measuredAt: "2026-09-12T08:00:00Z",
  systolic: 152,
  diastolic: 98,
  rested: true,
  postureConfirmed: false,
  symptoms: ["severe-headache"],
};

before(async () => {
  const store = new InMemoryStore();
  const service = new TriageService(store);
  service.registerDevice({
    deviceId: "cuff-9",
    model: "Cuff Pro",
    wearableKind: "cuff",
    calibratedAt: "2026-08-01T00:00:00Z",
    calibrationValidDays: 365,
  });
  server = createTriageServer(service);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function json(method: string, path: string, body?: unknown): Promise<{ status: number; payload: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await res.json();
  return { status: res.status, payload };
}

describe("HTTP 接口", () => {
  it("GET /rules 返回按版本生效的规则书", async () => {
    const { status, payload } = await json("GET", "/rules");
    assert.equal(status, 200);
    assert.equal(payload.length, 2);
    assert.equal(payload[1].version, "bp-triage-2026-v2");
  });

  it("提交、重放去重、取回分诊材料", async () => {
    const first = await json("POST", "/sessions", { submissionId: "up-1", session });
    assert.equal(first.status, 200);
    assert.equal(first.payload.deduplicated, false);

    const replay = await json("POST", "/sessions", { submissionId: "up-1", session });
    assert.equal(replay.status, 200);
    assert.equal(replay.payload.deduplicated, true);
    assert.deepEqual(replay.payload.submissions.accepted, ["up-1"]);
    assert.equal(replay.payload.submissions.deduplicatedReplays, 1);

    const record = await json("GET", "/sessions/http-s1");
    assert.equal(record.status, 200);
    assert.equal(record.payload.currentAction.action, "seek-care-now");
    assert.equal(record.payload.deviceTrust.model, "Cuff Pro");
    assert.equal(record.payload.automatedScreening.screeningOnly, true);
    assert.deepEqual(record.payload.symptoms, ["severe-headache"]);
  });

  it("同时领取只有一人成功（200 vs 409）", async () => {
    const a = await json("POST", "/sessions/http-s1/claim", { staffId: "mw-a" });
    assert.equal(a.status, 200);
    const b = await json("POST", "/sessions/http-s1/claim", { staffId: "mw-b" });
    assert.equal(b.status, 409);
    assert.equal(b.payload.error.code, "already-claimed");
    const queue = await json("GET", "/queue");
    assert.equal(queue.payload.items[0].claimedBy, "mw-a");
  });

  it("助产士确认后医生追加纠正记录", async () => {
    const confirmed = await json("POST", "/sessions/http-s1/confirm", {
      staffId: "mw-a",
      note: "腕带告警回拨",
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.payload.authorRole, "midwife");

    const corrected = await json("POST", "/sessions/http-s1/correct", {
      staffId: "doc-lu",
      action: "contact-soon",
      note: "复诊后降级",
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.payload.authorRole, "doctor");
    assert.ok(corrected.payload.opinion.correctsOpinionId);

    const record = await json("GET", "/sessions/http-s1");
    assert.equal(record.payload.clinical.status, "corrected");
    assert.equal(record.payload.clinical.trail.length, 2);
    assert.equal(record.payload.currentAction.action, "contact-soon");
  });

  it("错误请求返回结构化错误（400/404/409）", async () => {
    const bad = await json("POST", "/sessions", { submissionId: "x", session: {} });
    assert.equal(bad.status, 400);
    assert.equal(bad.payload.error.code, "validation");

    const missing = await json("GET", "/sessions/nope");
    assert.equal(missing.status, 404);

    const nonQueue = await json("POST", "/sessions/http-s1/claim", { staffId: "mw-c" });
    // 医生已降级为 contact-soon，会话已退出紧急队列
    assert.equal(nonQueue.status, 409);
    assert.equal(nonQueue.payload.error.code, "not-in-queue");
  });
});
