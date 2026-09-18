#!/usr/bin/env node
/**
 * 启动分诊 HTTP 服务：npm run serve
 * 端口取 PORT，默认 3000。默认载入 fixtures 的设备注册库作为演示数据，
 * 生产应由设备管理系统在 POST /api/devices 中登记。
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadFixtures } from "./fixtures.js";
import { createContext, createTriageServer } from "./server.js";
import { RULE_SET_V2026_01 } from "./triage.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "fixtures", "bp-cases.json");
const { registry } = loadFixtures(fixturePath);

const ctx = createContext({ registry, rules: [RULE_SET_V2026_01] });
const server = createTriageServer(ctx);
const port = Number(process.env.PORT ?? 3000);

server.listen(port, "0.0.0.0", () => {
  console.log(`孕期血压分诊服务已启动：http://127.0.0.1:${port}`);
  console.log(`已登记设备：${[...registry.keys()].join(", ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
