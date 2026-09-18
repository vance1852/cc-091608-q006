#!/usr/bin/env node
/**
 * 演示入口：载入 fixtures/bp-cases.json 的三类真实形态，逐条走分诊，
 * 打印“可核对分诊材料包”。运行：npm run build && npm start
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadFixtures } from "./fixtures.js";
import {
  RULE_SET_V2026_01,
  TriageRepository,
  buildCaseView,
  type TriageCaseView,
} from "./triage.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "fixtures", "bp-cases.json");

const { registry, cases } = loadFixtures(fixturePath);
const repo = new TriageRepository();

console.log(`规则版本：${RULE_SET_V2026_01.version}（${RULE_SET_V2026_01.effectiveFrom} 起生效）\n`);

for (const prepared of cases) {
  for (const submissionId of prepared.submissionIds) {
    const outcome = repo.submit(
      prepared.session,
      submissionId,
      RULE_SET_V2026_01,
      registry,
    );
    if (outcome.status === "duplicate") {
      console.log(`· 重复提交 ${submissionId} 已幂等忽略，测量次数仍为 ${outcome.measurementIndex}`);
    }
  }

  const record = repo.get(prepared.session.sessionId)!;
  const view: TriageCaseView = buildCaseView(record);
  console.log("=".repeat(72));
  console.log(`会话 ${view.sessionId}｜患者 ${view.patientId}｜孕周 ${view.gestationalWeek}`);
  console.log(
    `当前行动：${view.currentAction}｜设备可信度：${view.device.trust}` +
      `（${view.device.model ?? "未登记"}）｜测量质量：${view.measurement.quality}`,
  );
  console.log(
    `支撑读数：${view.supportingReading ? `${view.supportingReading.systolic}/${view.supportingReading.diastolic}` : "无可采信读数"}` +
      `｜严重症状：${view.symptoms.severe.length ? view.symptoms.severe.join("、") : "无"}` +
      `｜队列：${view.queue.status}`,
  );
  for (const reason of view.rationale) console.log(`  - ${reason}`);
  console.log(
    `去重后测量次数：${view.submission.acceptedCount}` +
      `｜提交记录：${view.submission.submissionIds.join(", ")}`,
  );
  console.log();
}
