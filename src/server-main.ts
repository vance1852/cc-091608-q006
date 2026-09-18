import { fileURLToPath } from "node:url";
import { createTriageServer } from "./http-server.ts";
import { seedFromFixtureFile } from "./seed.ts";
import { InMemoryStore } from "./store.ts";
import { TriageService } from "./triage-service.ts";

const store = new InMemoryStore();
const service = new TriageService(store);

const fixturePath = fileURLToPath(new URL("../fixtures/bp-cases.json", import.meta.url));
await seedFromFixtureFile(service, fixturePath);

const port = Number(process.env.PORT ?? 3000);
const server = createTriageServer(service);

server.listen(port, () => {
  console.log(`孕期血压分诊服务已启动: http://localhost:${port}`);
  console.log("已从 fixtures/bp-cases.json 装载示例会话");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
