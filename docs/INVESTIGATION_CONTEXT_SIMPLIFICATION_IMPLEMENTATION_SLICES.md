# 调查与 Context 状态简化 — Implementation Slices

状态：Slices 0–4 已完成契约、迁移部件与离线验证；Slices 5–7 待实施，生产尚未切换。编写日期：2026-10-30；更新日期：2026-11-03。

依据：[调查与 Context 状态简化：设计方案](./INVESTIGATION_CONTEXT_SIMPLIFICATION.md)正文第 1–13 节。该设计正文优先于其历史附录及旧 Phase 4 契约。本文拆解迁移任务，不声明运行时已经改变；不改写历史验收结果，也不把本次迁移重新编号为 Phase 5。

## 1. 交付目标与范围

将当前“对话 + 调查聚合”改为“Pi messages + 应用执行控制”：

```text
用户消息实际开始处理
  → 分配请求身份与独立预算
  → 模型分析 messages
  → 按当前选择同步接收具体工具调用
  → 排队、检查运行条件、扣减额度、MCP 派发
  → 受限且脱敏、带准确来源的工具结果进入 messages
  → 模型继续分析或直接给出报告
```

保留一个 AgentSession、一个 MCP server、默认只读、显式 model-supplied context、all/exact 选择、手动 MCP 恢复、取消、超时和有限并发。移除 Incident、EvidenceStore、Hypothesis 等调查领域结构及其授权、存储、工具、命令和摘要同步机制。

本次不增加工具能力、受控操作、shell/kubectl、原始响应保留、报告 schema、导出命令或新的调查归档。Phase 5 的工具扩展和逐次人工批准继续独立交付。

按单一 Session、无历史导航、无 reload/rebind 设计。Pi 内置命令、快捷键和程序入口禁用是独立后续交付，见[命令与操作限制方案](./TUI_COMMAND_VISIBILITY_AND_RESTRICTIONS.md)。它不阻塞本次删除旧恢复机制；在真正拦截前，应明确记录开放入口的产品缺口，不能宣称已强制禁用。

## 2. 基线、依赖与切换策略

当前生产路径仍通过 `InvestigationController`、incident lease 和 EvidenceStore 执行。以下为迁移落点，不要求保留现有文件名，也不要求新建同名替代实体：

| 当前落点                                                                        | 本次职责调整                                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/runtime/investigation-lifecycle.ts`、`src/runtime/pi-runtime.ts`           | 改为逐条用户请求的执行归属、预算、取消和模型迭代控制             |
| `src/cluster/context-manager.ts`、`context-resolver.ts`、`execution-queue.ts`   | 当前选择、运行时可用性、同步接收和有限并发；不再拼接全局权限快照 |
| `src/app/mcp-controller.ts`、`src/mcp/connection.ts`                            | 连接替换、发现、发布及 ready 屏障；只保留一种连接身份保护        |
| `src/mcp/tool-bridge.ts`、`incident-diagnostic.ts`、`result-normalizer.ts`      | 统一调用管线，结果直接进入 messages，不再提交领域观察            |
| `src/tui/cluster-extension.ts`、`cluster-command.ts`、选择器及 runtime guidance | 当前环境通知、压缩后恢复、单一当前选择展示                       |
| `src/domain/`、`src/investigation/`、调查 controller/tools/guidance             | 删除调查职责；必要输入校验、脱敏和执行控制先迁出                 |
| `src/config/`、`config/`、测试 fixtures                                         | 将 per-incident 配置迁为请求限制，删除失去含义的字段与配额       |

建议依赖顺序：

```text
Slice 0 契约与 Pi 事件验证
  → Slice 1 请求执行控制
  → Slice 2 当前选择与调用接收
  → Slice 3 连接替换与发布
  → Slice 4 工具结果
  → Slice 5 环境消息与压缩
  → Slice 6 生产切换、删除旧模型与文档同步
  → Slice 7 完整验收
```

Slices 1–5 提供可测试的迁移部件及组合测试；在 Slice 6 前不将部分新语义接入生产。生产仍保持完整旧路径，避免新请求预算、旧 incident 授权、旧证据提交混合执行。若拆成多个 PR，每个合并点都必须保持现有生产行为和安全门禁；Slice 6 一次切换并删除旧路径，不增加兼容配置、双写或长期双管线。

Slices 0–4 的契约与验证记录见下文；Slices 5–7 待实施。通过前置测试不等于生产迁移完成。

## 3. Slice 0 — 冻结执行契约并验证 Pi 事件边界

**目的：** 在删除 Incident 前，证明请求身份、预算和环境恢复能绑定到真实执行事件，而不是猜测 `before_agent_start` / `agent_end` 的含义。

**工作：**

- 阅读当前安装的 Pi 类型与实现，用真实 Pi、确定性模型流记录事件顺序。覆盖输入被消费、空闲提问、用户 steering、多个 queued follow-up、重试、手动/自动 compaction、自动续跑、取消和最终 settled。
- 确定每条用户消息“实际开始处理、下一次模型请求之前”的可靠挂接点。用户 steering 和 follow-up 固定 `one-at-a-time`，用户配置不能恢复批处理。
- 明确模型迭代的可计数边界及强制停止方式，验证无效工具调用、预算耗尽后的循环也能停止。不能仅靠 prompt、单次工具拒绝或 `agent_end`。
- 确认自动 compaction 后直接续跑时，能够在下一次模型请求前补充当前环境；不能只验证下一轮 `before_agent_start`。
- 冻结请求/调用最小字段、预算配置名及默认值/上限、结果时间含义、取消收尾、选择器草稿校验和连接发布顺序。明确 MCP 发现调用与模型诊断 dispatch 的计费边界，不借发现调用绕过限制。
- 形成 `docs/INVESTIGATION_CONTEXT_SIMPLIFICATION_CONTRACTS.md`，记录已验证接口、事件序列、失败路径、配置迁移和对应测试。不复制设计附录的中间方案。

**验收：**

- 同一个底层 loop 内的两条 follow-up 能识别为两个请求；自动重试、压缩、续跑不能被误认作新请求。
- 实际使用的 Pi 接口具备确定性 fixture 证据；若当前依赖缺少必要挂接点，明确依赖升级或受维护交付方案，完成后再进入依赖该能力的 slice，不引入未经验证的事件猜测。
- 命令禁用接口的独立后续交付不成为本 slice 的阻塞项。

Slice 0 交付（2026-10-30）：[执行契约](./INVESTIGATION_CONTEXT_SIMPLIFICATION_CONTRACTS.md)与 `tests/integration/pi-execution-boundaries.test.ts`。真实 Pi 0.99.0 确定性 fixture 覆盖消费输入、steering、逐条 follow-up、重试、手动/自动压缩、自动续跑、无效工具循环停止、取消及 settled。生产路径不变；来源标记适配器与全请求限制的组合实现属于 Slice 1。原来源标记方案已于 2026-11-03 简化：用户 steering/follow-up 统一以用户 message_start 创建请求，无需区分来源。检查使用 `npm run verify`；不包含 live 或视觉验收。

## 4. Slice 1 — 请求身份、双重限制与取消收尾

**依赖：** Slice 0。

**工作：**

- 实现仅含请求身份、dispatch 计数、模型迭代计数、取消信号及排队/活动调用跟踪的运行状态。不得保存问题语义、假设、结论、调查状态或 session→incident 映射。
- 每条有效用户消息在实际开始处理时获得新身份与独立额度；排队不预先分配活动请求或消耗额度。命令和被输入处理器消费的输入不创建请求。
- 用户 steering 与 follow-up 均在实际开始处理时创建新请求和完整额度；两种队列固定逐条交付。应用环境 custom steering 不创建请求，空闲时仅追加环境消息。工具循环、重试、压缩、自动续跑和重连沿用当前身份及两类剩余额度。
- 实际派发前同步扣减 dispatch 额度，并行调用共享上限。排队或派发前拒绝不扣减；已派发失败、超时、取消不退款，重新派发另计。
- 运行层执行独立模型迭代上限，覆盖连续无效调用及 dispatch 耗尽后的循环；达到上限停止自动运行并向用户说明限制。
- 正常结束前收尾本轮已接收调用。显式取消停止排队派发、尝试中止活动调用，并为每个原工具调用产生匹配的取消/错误收尾；后续请求不接管旧调用或剩余额度。
- 在配置层迁移 `investigation.maxToolCalls`，增加模型迭代限制；审查 `defaultTimeRange` 等原调查配置，删除无归属字段。按 Slice 0 契约更新模板及错误说明，不提供旧配置兼容别名。

**验收：**

- 同一对话先提问、再追问、再换题，各获得独立额度，无需 LLM 分类。
- 多条用户 steering/follow-up 逐条处理并各得新额度；应用环境通知、重试、压缩、重连、续跑均不刷新计数。
- 并发临界额度不超发；派发失败不退款，未派发拒绝不扣减。
- 迭代上限能终止反复无效参数、越界及额度耗尽后的调用循环。
- 取消后旧调用迟到不发布成功、不重复收尾、不悬空；新请求使用新身份；正常完成与退出均释放资源。

Slice 1 交付（2026-11-02）：

- `src/execution/request-execution.ts` 提供请求身份、独立 dispatch/model iteration 计数、同步扣费、有界队列、活动调用取消和一次性收尾；正常结束等待已接收调用，底层不响应取消时也及时返回取消结果并忽略迟到成功。
- `src/runtime/request-execution-adapter.ts` 集中包装公开 Pi API，以用户 message_start 统一创建请求，不再跟踪 steering/follow-up 来源；锁定 Session、settings 与 agent 的 steering/follow-up 模式入口。每次实际模型流前扣减迭代额度，保留原 finishTurn hook，达到上限清队列并中止 Session，最终 settled 收尾，退出恢复包装与释放订阅。
- `src/config/execution.ts` 与 `requestSreConfigSchema` 提供新配置验证，`config/pi-sre.request.example.yaml` 是待切换模板；新 schema 拒绝 investigation/defaultTimeRange，无兼容别名。为遵守第 2 节原子切换约束，**生产 loader、当前模板和旧调查配置直到 Slice 6 才一起替换**；此阶段新配置不能直接用于生产启动。
- `tests/unit/execution/request-execution.test.ts` 与真实 Pi fixture 组合覆盖重复文本、逐条 follow-up、消费输入、各模式入口、重试、手动/自动压缩、无效工具循环、dispatch 耗尽、before-settle 续跑、活动/排队取消和新请求独立额度。生产 composition 未引用新适配器；不包含安装包、live 或视觉验收。

## 5. Slice 2 — 单一当前选择与同步调用接收

**依赖：** Slices 0–1。

**工作：**

- 区分启动名称校验和运行时可用交集计算。保留 CLI → 显式配置 → 默认 live `*` 的启动优先级；未知显式名称启动失败，不回退 all。
- 当前选择仅为 all 或 exact set。all 跟随已验证 inventory；exact 保存完整用户意图，派发候选为 selected ∩ available。
- exact 成员消失后保留为 unavailable selected；选择器展示并允许用户明确取消。成员恢复后自动成为候选，新成员不扩大 exact。
- 接收具体调用时，在同一同步边界校验参数、当前选择、准确 context、工具能力和可用性，并登记调用 ID、请求 ID、context、必要参数、原连接身份和取消信号；登记后排队即视为已接收。
- 新选择只影响此后接收的调用。队列派发前检查所属请求、取消、原连接、原工具和原目标可用性，不按后来选择重新授权，不替换 context 或同名实际目标。
- 删除阻止活动期间改选的 work/epoch 依赖；选择器仅保留防止应用过期草稿所必需的校验，不重建全局执行 revision。

**验收：**

- A 调用已接收并排队，改选 B 后仍可按原 A 派发并返回 A 来源；改选后新到达的 A 调用被拒绝。
- `{A,B}` + inventory `{A,C}` 保留选择 `{A,B}`，仅 A 可执行；B 恢复后可执行，C 仍越界。全部不可用时阻止调用且不改写选择。
- singleton/all/exact 都要求模型显式提供准确 context；缺失、未知、越界、不可用或工具不兼容时不派发，不注入或覆盖参数。
- 与目标无关的 inventory 增减或 default 展示元数据变化不使有效在途结果失效；原目标消失或实际指向变化时不将排队调用路由到替代目标。

Slice 2 交付（2026-11-03）：

- `src/cluster/current-selection.ts` 分离严格启动名称校验与运行时交集计算，复用 CLI → 配置 → live `*` 优先级。exact 保留 unavailable selected；all 跟随 inventory。没有 validatedSelection、执行 revision 或 work epoch。
- `src/execution/accept-mcp-call.ts` 在同步边界消费发现 schema、只读策略与当前选择，复制参数并通过 Slice 1 的 RequestExecution 登记、排队和计费。派发前只检查原连接、原工具及原目标，不按新选择重新授权；结果返回前也检查原运行条件。每个目标的局部身份仅用于防止消失/恢复或实际指向变化后旧调用访问替代目标；无关 inventory/default 变化不使调用失效。
- `src/tui/current-cluster-picker.ts` 复用已支持 unavailable 行的 picker，活动调用不阻止改选；草稿只比较选择及 inventory 的名称/目标事实，不比较工作或全局执行版本。允许保留或明确移除 unavailable 成员，取消/UI 失败不提交。
- `tests/unit/execution/accept-mcp-call.test.ts` 将新选择、接收入口、RequestExecution 与 recording fake MCP 组合，覆盖同步登记、A 排队后改选 B、参数复制、exact 消失/恢复/全部不可用、all、显式 context/schema/能力拒绝、无关刷新、原目标/工具失效、单调用取消与选择器过期草稿。生产 composition 仍不引用新部件；连接失效的主动中断及发布屏障由 Slice 3 交付，模型可见来源封装由 Slice 4 交付。

## 6. Slice 3 — MCP 连接替换与统一发布屏障

**依赖：** Slices 1–2。

**工作：**

- MCP/应用协调层拥有唯一连接身份保护，将 publication block 合并到 MCP 未就绪状态；不保留调查 tools generation 或组合权限快照。
- 保持启动连接、断线标为不可用、用户 `/mcp_restart` 恢复；普通命令保留健康连接，`--force` 替换健康连接。不新增后台自动重连。
- 替换顺序固定为：关闭 dispatch/撤旧工具 → 使旧连接失效并收尾旧调用 → 新连接发现工具/schema/inventory → 按未变选择计算目标 → 发布匹配工具、环境与通知 → 开放 dispatch。
- 发现或发布失败保持诊断关闭，不回退旧 schema、工具或 inventory。发布不等待模型确认；工具调用仍受真实 ready 状态校验。
- MCP 连接取消与 AgentSession 取消分开。旧调用不迁移、不重放；重连不创建用户请求、不刷新预算，也不重建扩展。

**验收：**

| 替换时状态   | 必须观察到的结果                             | Dispatch 计数 |
| ------------ | -------------------------------------------- | ------------- |
| 已成功发布   | 保留原历史结果                               | 保持已消耗    |
| 已派发未完成 | 尝试中止；原调用返回连接中断、未取得有效结果 | 不退款        |
| 已接收但排队 | 移出队列；原调用返回连接中断、未执行         | 不扣减        |
| 旧连接迟到   | 无成功发布或重复收尾；只完成剩余资源清理     | 不改变        |

- 工具/schema/inventory 任一步发现或发布失败，都无法从捕获的旧 handler 绕过屏障。
- 同名 context 指向改变后旧调用不访问新目标；新调用使用当前 schema 重新校验。
- 活动请求恢复后可沿用剩余额度继续；已收尾时恢复只更新环境，不自动启动模型，用户下一条“继续”才创建新请求。
- MCP 不可用、认证不可用和 Kubernetes 操作失败保持可区分，不声称已获得集群访问。

Slice 3 交付（2026-11-03）：

- `src/app/request-mcp-controller.ts` 提供待切换的连接协调器，复用现有 MCP transport、工具/schema 发现及 inventory 验证。启动连接与用户手动恢复共用替换流程；普通恢复保留健康连接，force 替换健康连接，并发命令共享当前操作；无后台重连。
- 同一原连接对象持有 ready 状态和取消信号，不增加调查 generation 或复合权限快照。替换先关闭派发、撤工具并失效旧连接，等待已接收调用收尾及旧 transport 关闭，再发现新工具和 inventory。exact 意图不变，all 跟随新 inventory；失败时清空可执行 inventory，不回退旧事实。
- 发布回调负责安装匹配工具、环境和通知；回调完成且原连接仍有效后才开放派发，不等待模型确认。发布期间捕获的新 handler 与旧 handler 均无法执行，发现、撤工具或发布失败继续关闭诊断。扩展与 AgentSession 不在协调器内创建或重绑。
- `accept-mcp-call.ts` 合并原连接取消信号，使排队和活动调用及时收尾；连接中断返回 error，保留是否已派发及时间，不取消用户请求、不退款、不重放，也不改变模型迭代额度。底层忽略 abort 的迟到成功被忽略。
- `tests/unit/execution/request-mcp-controller.test.ts` 组合真实发现/schema、当前选择、同步接收、RequestExecution 和 recording fake MCP，覆盖断线/force 的活动及排队调用、健康保留、并发恢复、剩余额度、新请求、schema/目标变化、发现和发布失败、发布中断线、撤工具失败及退出清理。MCP 断线、认证错误和 Kubernetes 操作失败不混同；模型可见错误来源呈现仍由 Slice 4 交付。
- 针对性离线测试 38/38 通过；`npm run verify` 全部通过（格式、lint、类型检查、49 个测试文件通过/1 跳过、728 个测试通过/7 跳过、构建通过）。生产 composition 仍使用旧协调器；安装包、live 和视觉验收留到 Slice 7。

## 7. Slice 4 — 无 EvidenceStore 的统一工具结果管线

**依赖：** Slices 1–3。

**工作：**

- 将普通 snapshot 路径与 incident lease 路径收敛为一条接收、排队、派发、结果收尾管线；校验只消费发现的 input schema 和应用策略，不新增诊断资源形状校验。
- 结果直接返回 Pi messages。必要来源必须在模型可见 `content` 内，而非仅在 `details`：实际 context、操作、必要 namespace、执行状态、适用时间和截断情况。
- 未派发明确标为未执行，不编造查询时间；已派发保留派发与收尾时间。namespace 省略说明由 server/context policy 决定，不声称覆盖全部 namespace。
- 来源封装与正文共用结果大小上限；派发前确认来源可以完整容纳，否则拒绝。不能通过截断/改写 context 身份满足上限。
- 结果管线直接承担脱敏、大小及截断处理，不依赖 EvidenceStore。继续强制 raw retention disabled；不落临时原始文件，不提供截断内容读取入口。
- 校验或迁移原 `domain` 中仍需要的参数类型、错误类型与校验逻辑到所属执行模块；不把领域 `OperationOutcome` 换名保留成调查记录。

**验收：**

- 成功、空结果、MCP/tool 失败、超时、取消、未派发拒绝和截断均有准确且一致的来源；失败不伪装成成功空结果。
- A/B 同名 Pod 的并发结果仍可在 content 中区分；后续改选不改写历史结果 context 和时间。
- 长 context、超小允许结果限额、namespace 省略及控制字符等边界不破坏身份表达或限额；敏感数据不进入日志、details、messages 或存储。
- server 附加字段正常接受；无 evidence ID、领域证据写入、原始响应保留或文件取回承诺。

Slice 4 交付（2026-11-03）：

- `src/mcp/request-tool-bridge.ts` 在 Slice 3 publication 的原连接接收入口之上提供一条工具执行管线，组合同步接收、请求队列、派发与结果呈现；cluster-dependent 与 inventory 工具均走同一请求计费入口。复用发现 schema 和应用只读策略，不检查诊断资源形状，不引入调查记录或领域 ID。
- 模型可见 `content` 包含完整准确 context、操作、namespace 或 server/context policy 说明、READ ONLY、执行状态、失败类别和截断标记。已派发结果保留客户端 dispatch/settlement UTC 时间，并明确不代表对象观测时间；未派发没有查询时间，context 仅表示请求目标。失败、空结果和取消保持区分。
- 来源、正文及紧凑 details 共用一个序列化结果字符限额；派发前预留最坏状态/错误/时间封装及截断提示。不能容纳完整身份时拒绝派发并说明身份未展示，不截断或改写身份。正文复用独立于 EvidenceStore 的 normalizer 完成脱敏、条目限制、binary omission 与截断；强制 raw retention disabled，无文件写入、原始数据 details 或读取入口。
- `src/execution/identity.ts` 将仍有用途的身份校验落在执行模块，检查 display-safe、UTF-8 上限及可原样安全呈现；敏感或带控制字符的身份拒绝执行。`src/execution/errors.ts` 提供请求预算、队列、连接、选择及关闭错误类别，结果呈现不读取 DomainError，也不把 OperationOutcome 改名保留。旧领域文件仍供旧生产路径使用，随 Slice 6 删除。
- `RequestToolResultBoundary` 由单一 Session 持有，跨连接/工具 publication 共用；Slice 6 须创建一次并注册 `message_end` hook。真实 Pi 会在 handler 与 `tool_result` 前产生 schema/abort 拒绝，且 schema 错误可含原参数；该 hook 在保存 transcript 和下一次模型请求前替换为受限的未执行说明，不转发原错误。不把无有效参数的拒绝伪装成具有实际 context 的查询；已呈现的旧连接结果不会被新工具 publication 误改写。
- `tests/unit/execution/request-tool-bridge.test.ts` 与真实 Pi fixture 组合覆盖并发同名资源的 A/B 来源、改选、空结果、MCP/tool/认证/授权错误、超时、活动/排队取消、连接替换、未派发预算拒绝、长/转义身份、最小 256 字符限额、条目限制、敏感数据及 binary omission。真实 Pi 验证 schema 拒绝不派发，安全结果同时进入 provider input、Session messages 与 transcript。
- 针对性离线测试 74/74 通过；`npm run verify` 全部通过（格式、lint、类型检查、50 个测试文件通过/1 跳过、751 个测试通过/7 跳过、构建通过）。生产 composition 保持旧路径；安装包、live 与视觉验收留到 Slice 7。

## 8. Slice 5 — 当前环境消息、TUI 与 Compaction 恢复

**依赖：** Slices 0、2–4。

**工作：**

- 从真实运行状态生成单一环境描述：当前 all/exact 选择、available targets、unavailable selected、MCP 状态、namespace policy 和实际只读 profile。UI 持续展示这些事实，每次工具调用显示准确 context，不再显示 effective/next investigation。
- 用户改选、inventory 增删、同名 context 指向变化、MCP 断开/恢复产生应用消息。变更检测和消息来自同一事实；相同刷新去重，default 元数据不改变选择或制造权限变化。
- 活动运行沿用 steering 交付；空闲时仅追加环境消息，不启动模型或新请求。不维护 environmentEvents 列表，也不持久化另一份“最近变更”调查状态。
- 手动和自动 compaction 后，在下一次模型请求前补充必要当前环境与目标变化提示；相同快照去重，覆盖压缩后直接续跑路径。
- 保留历史观察来源与时间。通知不暴露 server 地址、凭据或敏感原始数据；不将目标可用描述为认证成功、健康或已检查。
- 更新 prompt/guidance：以 messages 分析、修正判断和直接报告；缺少来源或压缩后事实不足时说明限制并按需重查，不从 transcript 恢复权限或领域状态。

**验收：**

- 自动 compaction 后直接发起的下一次模型请求包含当前环境；无需额外用户消息触发恢复。
- 环境消息不重置请求/迭代/dispatch 计数，不重复注入领域摘要，也不导致空闲模型自动运行。
- A/B 同名 Pod 经改选和目标指向变化后，模型输入能区分历史来源、目标变化和当前可查范围；不得把旧结果标成新目标当前事实。
- `/clusters`、picker 和状态栏对 exact unavailable 项、部分可用、全部不可用及恢复的表达一致；活动期间允许改选。

## 9. Slice 6 — 原子切换生产并删除调查体系

**依赖：** Slices 1–5 的组合测试通过。

**工作：**

- 在 application/runtime composition 中一次切换到请求执行状态、当前选择、统一 MCP 管线及环境消息；扩展只在启动初始化、退出释放。
- 删除调查 controller/service/store/archive、领域模型与仅服务它们的 observation adapter、生命周期 hooks、pending conclusion 和 `agent_end` 提交机制。
- 移除五个模型工具：`hypothesis_upsert`、`investigation_conclude`、`investigation_get`、`evidence_list`、`evidence_get`；移除 `/incident`、`/evidence` 及领域检查 UI。
- 移除 session→incident、binding/epoch、scope/selection/inventory 执行 revision、incident lease、work epoch、validatedSelection 混合状态、领域容量及 JSONL 归档流程。必要连接身份、调用跟踪、取消、超时和退出清理必须保留。
- 删除会话切换、分支恢复、reload/rebind 的应用兼容与状态重挂接路径及对应旧契约测试；不新增同义运行时绑定权限层。
- 逐项审查 `src/domain/` 的剩余调用者，先迁移必要校验再删除无用文件，不机械删除整个目录；不保留只为通过旧测试存在的领域壳。
- 将仍有价值的只读、context、结果、取消和重连断言迁移为新行为测试，再移除仅验证旧调查语义的测试和 fixtures。
- 同一交付更新 `AGENTS.md`、`README.md`、`docs/DESIGN.md`、当前配置模板及相关工具/schema/契约文档，明确新配置、无独立证据库和压缩取舍。旧 Phase 1–4 完成日期、结果与视觉验收待办保持历史事实；旧说明若保留，应明确已被取代，不重写历史结论。
- 对照 Phase 5 计划，确保其后续能力依赖当前选择与请求管线，不重建 incident authority。

**验收：**

- 生产 composition 中用户直接查询，无 Incident 自动创建或前置条件；回答后同一对话可再次查询。
- 模型可见工具、命令、prompt 和 results 不再要求领域 ID 或 conclude；没有双写、双授权路径、兼容开关或 transcript 恢复权限。
- 全仓依赖检查确认删除的机制不再承担生产执行；保留历史文件中的术语应可解释，不能用全仓零关键词匹配代替依赖检查。
- 单一 AgentSession、扩展初始化一次；MCP 恢复不重建扩展。正常取消、重连、订阅注销和退出清理仍有效。
- 对尚未关闭的 Pi 内置入口记录交付缺口，不为其保留恢复测试，也不把入口禁用列为本 slice 已完成项。

## 10. Slice 7 — 全路径回归与安装包验收

**依赖：** Slice 6。

使用真实 Pi + 确定性模型流 + recording fake MCP 验证生产组合，避免只测试新类而遗漏 hook 顺序、工具注册、结果 publication 和 UI 接线。新增 `docs/INVESTIGATION_CONTEXT_SIMPLIFICATION_ACCEPTANCE.md`，逐项记录离线、安装包、live 和视觉验收的结果与证据。

| 场景组       | 必须覆盖                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------ |
| 对话         | 直接查询、多轮追问、用户补充后修正、报告后继续；全程无需领域写工具                               |
| 请求限制     | 用户 steering/follow-up 独立额度；环境通知/重试/压缩/续跑/重连不重置；并发上限与无效调用循环停止 |
| 取消         | 活动与排队同时取消；旧结果不串入后续请求、不重复发布、不悬空                                     |
| 实时改选     | 改选前已接收 A 保留 A，改选后新 A 被拒绝；改选不影响原成功结果                                   |
| Exact / all  | 成员消失、恢复、全部不可用、新成员加入；启动未知名称失败，运行时 exact 意图保持                  |
| 连接替换     | 断线及 force 同时覆盖活动/排队；工具/schema/inventory 变化；发现/发布失败关闭 dispatch           |
| 恢复时机     | 活动请求恢复后沿用余额；空闲恢复不唤醒模型；下一条用户继续使用新额度                             |
| 来源与压缩   | A/B 同名资源、同名 context 指向变化、手动/自动压缩直接续跑、环境快照去重                         |
| 结果与安全   | 成功/空/失败/取消/未执行/截断来源；省略 namespace；敏感数据与超限；raw retention disabled        |
| 应用生命周期 | 单一 Session、扩展启动初始化一次、退出资源释放；不测试已删除的切换/reload 恢复能力               |

先运行受影响的窄测试，再运行仓库统一门禁：

```bash
npm run verify
```

需要修复格式时运行 `npm run format` 并检查 resulting diff。不得为了适配旧断言恢复已删除语义或降低安全检查。

安装包验收在 checkout 外验证：安全配置启动、直接诊断、改选、取消、`/mcp_restart`、状态与来源展示、无旧领域命令/工具、退出进程清理及 kubeconfig 未改变。Live 检查使用显式的一次性 kind 环境和测试 context，保持只读；覆盖 exact/all 恢复及同名资源来源，不要求访问生产集群或执行故障注入。实际 server/schema 契约测试按已有 `npm run test:contracts` 单独记录，不能把确定性 fixture 通过等同于 live 通过。

视觉终端检查单独记录当前选择、unavailable selected、每次调用 context、READ ONLY/MCP 状态及取消/恢复反馈。尚未执行的 live、安装包或视觉检查标为待验收，不以自动测试替代，也不挪用旧 Phase 4 验收结果。

## 11. 完成标准与独立后续交付

本次完成需要：生产不再依赖调查聚合；请求边界、两类限制和收尾正确；改选与连接替换语义分离；受限脱敏结果和环境消息足以支持对话诊断；压缩后继续执行具备当前环境；自动化门禁、安装包、只读 live 及视觉检查均有明确记录。

以下不作为本次完成条件，也不能在本次验收中宣称已交付：

- Pi 内置 `/new`、`/resume`、`/fork`、`/clone`、`/import`、`/tree`、`/reload` 及对应快捷键/程序入口统一禁用。
- 新的报告 schema、导出、原始结果读取或领域审计替代品。
- Phase 5 工具扩展、受控操作及其人工批准流程。

入口禁用后续应复用单一 Session 约束单独验收。若实施中发现需要调整本设计，先明确修改当前契约，不恢复历史附录中的 Incident、environmentEvents 或直接 conclude 中间方案。
