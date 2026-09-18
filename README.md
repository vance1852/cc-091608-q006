# 孕期血压异常分诊

夜间值班助产士收到孕妇腕式血压连续偏高的留言时，需要先核对设备校准、测量姿势与伴随症状，才能区分“规范复测”“尽快联系门诊”与“立即就医”。本服务把家庭测量整理成**可核对的分诊材料**，并严格区分设备/读数筛查（自动）与医院诊断（人工）。

## 领域边界

- **设备筛查 ≠ 医院诊断**：自动结论 `screeningOnly: true`，只表达 `remeasure` / `contact-soon` / `seek-care-now`（读数正常时为 `no-action`），不形成临床意见。
- **人工链路**：助产士 `confirm` 确认自动建议才产生首条 `TriageOpinion`；医生 `correct` 以**追加记录**（`correctsOpinionId`）纠正，原意见永不覆盖。
- **规则按版本生效**：`bp-triage-2025-v1` 要求严重症状有可采信读数支撑；`bp-triage-2026-v2` 起严重症状即使读数质量不足（如姿势未确认）也直入紧急人工队列。评估以**测量时刻**选择规则版本。

每条记录都关联：孕周、腕带/袖带型号与佩戴方式、近期校准（含 `validUntil`）、测量前静息、姿势确认。

## 筛查规则（v2 摘要）

| 情况 | 自动行动 |
| --- | --- |
| 设备未登记 / 校准过期，或静息、姿势、读数不合理 | `remeasure`（读数不可采信，不能据此升级） |
| 读数可采信且 ≥140/90 | `contact-soon` |
| 读数可采信且 ≥160/110 | `seek-care-now` |
| 命中严重症状（剧烈头痛、视物异常、上腹痛），**即使读数质量不足** | `seek-care-now` + 紧急人工队列 |

## 关键不变量

- **提交幂等**：同一会话 + 同一 `submissionId` 反复上传不累加次数、不重新评估，只累计 `deduplicatedReplays`。
- **领取互斥**：紧急队列条目两名轮班人员同时领取时只有一人成功（另一人收到 `409 already-claimed`），同一人重复领取幂等。
- **接口返回分诊材料而非孤立分值**：当前行动及其来源、设备可信度、支撑读数与症状、机器可核对的 `basis` 依据码、完整人工判断脉络。

## 目录

- `src/contracts.ts` — 设备、会话、症状问答、自动筛查、临床意见链、分诊材料 DTO
- `src/rules.ts` — 版本化规则注册表、设备可信度、测量质量、自动筛查引擎
- `src/store.ts` — 内存仓储：幂等提交索引、紧急队列领取锁、意见链
- `src/triage-service.ts` — 业务编排（提交/领取/确认/覆核）
- `src/validation.ts` — 入参契约校验
- `src/http-server.ts` / `server-main.ts` — 仅依赖 `node:http` 的 REST 接口
- `src/seed.ts` / `cli.ts` — fixture 装载与命令行全流程演练
- `fixtures/bp-cases.json` — 校准过期、重复上传、严重症状三类真实形态
- `test/` — 规则、服务、fixture 端到端、HTTP 集成测试

## 使用

Node.js 22，无需构建步骤（Node 直接擦除 TypeScript 类型运行）：

```bash
npm test          # tsc --noEmit 严格类型检查 + node:test
npm run demo      # 用 fixtures 演练去重、领取互斥、确认与医生覆核
npm start         # 启动 HTTP 服务（默认 3000，预载 fixture，PORT 可改）
```

### HTTP 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET  /rules` | 已发布的规则版本 |
| `POST /devices` | 登记腕带/袖带及校准窗口 |
| `POST /sessions` | 提交测量会话，体含 `submissionId` 与 `session`（重放幂等） |
| `GET  /sessions/:id` | 完整分诊材料 |
| `GET  /queue` | 紧急人工队列 |
| `POST /sessions/:id/claim` | 领取（互斥） |
| `POST /sessions/:id/confirm` | 助产士确认 |
| `POST /sessions/:id/correct` | 医生追加覆核记录 |

```bash
curl -s localhost:3000/sessions/bp-urgent | jq .currentAction
# { "action": "seek-care-now", "source": "automated-screening" }
```

## 备注

仓储为单进程内存实现；领取互斥依赖 Node 事件循环中“检查 + 写入”同步完成、不会被穿插。多实例部署时需把 `store.ts` 的索引与领取锁替换为带唯一约束/事务的持久存储，领域层契约不变。
