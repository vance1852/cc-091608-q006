#!/usr/bin/env node
/**
 * 命令行演练：装载 fixtures/bp-cases.json，按夜间值班流程演示
 * 设备筛查、复测要求、严重症状直入紧急队列、重复提交去重、
 * 队列领取互斥、助产士确认与医生纠正。
 */
import { fileURLToPath } from "node:url";
import { seedFromFixtureFile } from "./seed.ts";
import { InMemoryStore } from "./store.ts";
import { TriageService } from "./triage-service.ts";

const store = new InMemoryStore();
const service = new TriageService(store, { now: () => "2026-09-10T23:00:00Z" });

const fixturePath = fileURLToPath(new URL("../fixtures/bp-cases.json", import.meta.url));
const seeded = await seedFromFixtureFile(service, fixturePath);

const line = (title: string): void => {
  console.log(`\n=== ${title} ===`);
};

line("重复提交去重");
for (const item of seeded) {
  console.log(
    `${item.sessionId}: 提交 ${item.submissionIds.length} 次，重放 ${item.deduplicatedReplays} 次未计数`,
  );
}

for (const sessionId of ["bp-old-cal", "bp-retry", "bp-urgent"]) {
  const record = service.record(sessionId);
  line(`${sessionId} 的分诊材料`);
  console.log(JSON.stringify(record, null, 2));
}

line("紧急人工队列");
console.log(JSON.stringify(service.urgentQueue(), null, 2));

line("两名轮班人员同时领取 bp-urgent");
console.log("助产士 A:", JSON.stringify(service.claim("bp-urgent", "midwife-a")));
try {
  service.claim("bp-urgent", "midwife-b");
} catch (err) {
  console.log(`助产士 B 被拒绝: ${(err as Error).message}`);
}

line("助产士 A 确认 bp-old-cal 的复测建议");
console.log(JSON.stringify(service.confirm("bp-old-cal", "midwife-a", "已电话指导规范复测"), null, 2));

line("助产士 A 确认 bp-urgent 的立即就医建议");
console.log(JSON.stringify(service.confirm("bp-urgent", "midwife-a", "腕带提示，立即回拨"), null, 2));

line("医生覆核 bp-urgent：补问病史后维持立即就医（追加记录，不覆盖）");
console.log(
  JSON.stringify(service.correct("bp-urgent", "doctor-lu", "seek-care-now", {
    note: "电话确认剧烈头痛与视物模糊，按先兆子痫处理",
    now: "2026-09-10T23:20:00Z",
  }), null, 2),
);

line("bp-urgent 最终脉络（自动筛查 + 人工链路）");
const finalRecord = service.record("bp-urgent");
console.log("当前行动:", JSON.stringify(finalRecord.currentAction));
console.log("临床链路:", JSON.stringify(finalRecord.clinical.trail, null, 2));
