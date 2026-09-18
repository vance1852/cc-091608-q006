# 孕期血压异常分诊

把家庭腕式/袖带血压测量变成**可核对的分诊材料**，并把“设备筛查”与“医院诊断”清楚分开：
机器只产出当前行动建议（复测 / 尽快联系 / 立即就医），**分诊意见必须由助产士确认**，
医生覆核时以**追加更正记录**纠正，全过程保留读数、症状与人工判断的来龙去脉。

`src/contracts.ts` 定义设备验证、测量会话、症状问答与分诊意见四层契约；
`fixtures/bp-cases.json` 保留三类脱敏真实形态：校准过期、重复上传、严重症状。

## 领域分层与判定

每条记录都关联：**孕周、腕带/袖带型号、近期校准、测量前静息、姿势确认**。

1. **设备筛查**（`assessDevice`）：设备须已登记验证，且校准时点相对*测量时间*仍在有效期内。
   结果为 `validated` / `unknown-device` / `calibration-expired`。这只是设备可信度，不是诊断。
2. **测量质量**（`assessMeasurement`）：静息与姿势任一缺失即 `requires-reretake`。
3. **症状问答**：`severe-headache`、`visual-change` 等为红旗症状。
4. **自动建议**（`evaluateTriage`，随 `ruleVersion` 固定版本）：
   - 严重症状 → **`seek-care-now`** 并进紧急人工队列，**即使读数质量不足**（症状驱动，不等待复测）；
   - 可信设备 + 合格姿势下，重度升高（默认 ≥160/110）→ `seek-care-now`；
   - 可信、合格但升高（默认 ≥135/85）→ `contact-soon`（≥20 周提示排查子痫前期）；
   - 质量/设备不合格且无严重症状 → **`remeasure`**，脏读数不返回为支撑材料。

医院规则按版本生效（`TriageRuleSet` + `latestRuleSet`）；输出携带其依据的 `ruleVersion`。

## 一致性保证

- **幂等提交**：以 `(sessionId, submissionId)` 去重。同一物理测量重复上传返回 `duplicate`，
  测量次数不累加（`bp-retry` 的两个相同 `upload-21` 只计 1 次）。
- **并发认领**：紧急队列领取是条件写入，轮班两人同时领取时仅一人 `200`，另一人 `409`。
- **意见与更正**：自动建议不是意见；`confirmOpinion` 由助产士确认，
  `correctOpinion` 由医生追加 `correctsOpinionId` 指向的更正记录，原意见保留不删。

接口返回的是**材料包**（`buildCaseView`）而非孤立分值：当前行动、设备可信度、
支撑它的读数与症状、判定理由、提交去重情况、队列状态、完整意见链。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/rules` | 规则版本列表与当前生效版本 |
| POST | `/api/devices` | 登记/更新已验证设备（型号、腕带/袖带、校准） |
| POST | `/api/submissions` | 幂等提交测量 `{submissionId, session, ruleVersion?}` |
| GET | `/api/cases/:id` | 材料包：行动 + 设备可信度 + 读数/症状 + 人工脉络 |
| GET | `/api/queue` | 紧急人工队列 |
| POST | `/api/cases/:id/claim` | 认领（并发仅一人成功，其余 409） |
| POST | `/api/cases/:id/resolve` | 处理完成 |
| POST | `/api/cases/:id/opinions` | 助产士确认 → 分诊意见 |
| POST | `/api/cases/:id/corrections` | 医生覆核 → 追加更正记录 |

## 运行

Node.js 22，TypeScript 严格模式（`strict` + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes`），无第三方运行时依赖。

```bash
npm install
npm test        # tsc --noEmit 类型检查 + 编译 + node:test（21 项）
npm run build   # 编译到 dist/
npm start       # 回放 fixtures 三类形态，打印材料包
npm run serve   # 启动 HTTP 服务（PORT，默认 3000）
```

> `fixtures/bp-cases.json` 只含脱敏关键事实；患者、型号、孕周、静息等补齐字段集中在
> `src/fixtures.ts` 并显式标注，生产环境须来自设备注册系统与患者 App。
