# 调查与 Context 状态简化 — 执行契约

状态：Slice 0 验证完成（2026-10-30），Slices 1–5 迁移部件及组合验证完成（2026-11-02/04）；生产仍采用 Phase 4 路径。本文冻结后续 slices 的执行契约，不声明迁移已接线。

依据：设计正文第 1–13 节及 Implementation Slices。历史附录不是实施要求。

## 已验证的 Pi 接口

依赖为安装的 `@earendil-works/pi-coding-agent` 0.99.0 及其嵌套 `pi-agent-core` 0.99.0。直接阅读 `dist/core/agent-session.js`、`extensions/types.d.ts`、`settings-manager.js`，以及嵌套 core 的 `dist/agent.js`、`agent-loop.js`。测试见 [真实 Pi fixture](../tests/integration/pi-execution-boundaries.test.ts)：真实 services/session、内存设置与 transcript、临时应用目录、确定性 stream，无模型网络请求；压缩使用公开 `session_before_compact` 返回确定性 summary，不 mock 压缩调度。

| 场景                  | 已验证顺序/行为                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| input 返回 handled    | 无 before_agent_start、用户 message_start 或模型请求                                                      |
| 空闲提问              | before_agent_start → agent_start → 用户 message_start → context → stream                                  |
| 用户 steering         | 本轮工具收尾后交付用户 message_start → context → stream；不重新 before_agent_start                        |
| 两条 follow-up        | 同一个 agent_start 内逐条 message_start → context → stream，直到 agent_end；仅一次 before_agent_start     |
| 429 自动重试          | agent_end → auto_retry_start → 新底层 loop/context/stream；没有新用户 message_start 或 before_agent_start |
| 手动压缩              | session_before_compact(manual) → 压缩；下一提问的 context 注入环境                                        |
| overflow 自动压缩续跑 | session_before_compact(overflow) → 直接重试 → context 注入环境；不再 before_agent_start                   |
| 无效工具循环          | 每次仍有 finishTurn；返回 action:end 可在固定次数停止；每个无效调用有匹配 toolResult                      |
| 显式取消              | abort → aborted 响应 → settled；下一用户提问正常开始                                                      |

`agent_before_settle` 在最终 settled 前仍可要求续跑。`agent_end` 不是最终清理点；最终清理使用 `agent_settled`。`finishTurn` 不是模型尝试总数：错误重试、压缩重试仍需计数。工具 handler 不是计数边界，无效工具名甚至不会到 handler。

## 请求身份与受维护适配方案

2026-11-03 简化约定：每条用户消息实际开始处理时统一创建新请求和完整额度，包括初始问题、steering 与 follow-up；不按文本或问题语义分类。Pi 的用户 `message_start` 在下一模型请求之前交付，可直接作为边界，无需区分队列来源。适配器不再包装 `agent.steer` / `agent.followUp`，也不再维护消息对象 WeakMap。

steering 与 follow-up 均固定 one-at-a-time，避免多条用户消息在一次模型调用前合并交付。适配器锁定 Session、settings 和 agent 公共属性的两个模式入口，不能仅启动时设置一次。排队本身不创建新身份或消耗额度；新用户消息不取消或接管旧工具调用，旧调用仍按原请求计费并完成收尾。

应用环境通知使用 custom 消息，即使通过 steering 交付也不创建请求；空闲通知只追加消息。工具循环、重试、压缩、自动续跑与 MCP 恢复没有新用户消息，不重置身份或额度。

组合测试覆盖重复文本、多个 steering/follow-up、各模式入口、取消清队列、消费输入及活动/空闲环境消息。直接低层 agent.prompt/continue 属于内部受控入口；生产接线仍留到 Slice 6。

## 模型迭代与停止

每次即将调用模型流计一次，包括无效工具循环、dispatch 耗尽后的循环、重试和压缩重试。环境 context hook 用于每次模型请求恢复当前环境；不以 before_agent_start 代替。模型迭代守卫应在实际流边界检查余额，在调用真实流前同步扣减；压缩 summary 的模型调用不属于诊断迭代，但保留 Pi 独立的重试限制。

工具循环正常停止可用公开 `agent.finishTurn` 返回 `{action:"end"}`（保留原 hook）。达到全请求上限还必须设置终止标记、清理待续跑工作并调用 Session abort，使 post-run retry、before-settle continuation 也无法启动真实流；不能只返回 end 或拒绝工具。禁止在当前流/hook 内 await Session abort（它会等待当前运行）；应显式处理其 promise，在 settled/退出时等待清理。

Slice 0 证明 finishTurn 能停止无效工具循环和 abort 能 settled；全请求守卫、dispatch 耗尽、queued follow-up 与自动续跑的组合停止由 Slice 1 实现验证。不得把这些尚未实现的策略声称为 Pi 自带限制。

## 最小运行字段与配置迁移

请求仅含 `requestId`、取消信号、dispatch/model iteration 已用计数，以及 queued/active call 集合；不保存问题、假设、结论、Incident 或调查状态。调用保留 Pi `toolCallId`、`requestId`、操作名、原样准确 context、必要参数、原连接身份、取消信号和收尾标记；已派发时增加 dispatch/settlement 时间。调用 ID 按请求组合识别，不假定跨请求唯一。

Slice 1 冻结新配置为 `execution.maxToolCalls`（默认 40，上限 1000）、`execution.maxModelIterations`（默认 80，上限 2000），均为正安全整数。两者独立，不要求大小关系；允许先耗尽工具额度后用剩余迭代解释结果。旧 `investigation.maxToolCalls`、`defaultTimeRange` 删除，无别名。模板移除 investigation；证据库/领域容量随 Slice 6 删除，不转成另一套存储额度。Slice 1 在独立的 `requestSreConfigSchema` 验证新配置与拒绝旧字段，并提供 `config/pi-sre.request.example.yaml`；生产 schema、loader 和当前模板继续保留旧配置，直到 Slice 6 与执行管线一起原子替换。

实际诊断 MCP dispatch 前同步扣减工具额度：已派发失败、取消、超时不退款；入队、校验拒绝及派发前拒绝不计费。并行共享同一请求余额。启动/用户恢复过程中的工具及 context 发现不计诊断 dispatch，但仅由连接生命周期调用；不能把模型诊断转成“发现”绕过额度。模型可调用的 inventory 工具仍按诊断派发计费。

## 接收、收尾与发布

接收在一个无 await 的边界完成：参数/schema、当前选择、工具能力与目标可用性校验 → 固定来源与连接 → 登记调用。之后排队即已接收。改选不撤销它；派发前检查原请求、取消、原连接、原工具与原目标，不按新选择重新授权，不重路由。

正常完成先收尾全部已接收调用。取消停止队列、尝试 abort 活动调用，每个原 toolCallId 只产生一次取消/错误结果；迟到成功不得发布或归入新请求。排队取消标未执行，无查询时间；派发后保留派发及收尾时间，两者表示客户端执行区间，不冒充 Kubernetes 对象观测时间。结果来源必须在受限、脱敏的 content 内完整呈现；raw retention disabled。

选择器草稿仅校验其基于的当前选择和 inventory 是否仍适用；过期时刷新/重新确认，不以全局 execution revision 撤销已接收调用。exact 中消失项保留 unavailable selected，候选为 selected ∩ available；all 使用当前 inventory。

连接替换顺序：关闭 dispatch/撤工具 → 旧连接失效、旧调用收尾 → 新工具/schema/inventory 发现 → 按未变选择计算候选 → 发布匹配工具、环境与通知 → ready。任何发现或发布失败都保持关闭。旧调用不迁移、不重放；只保留一处连接身份保护。

## 检查记录

2026-10-30：窄测试 6/6 通过；`npm run verify` 通过（格式、lint、类型检查、46 个测试文件通过/1 跳过，676 个测试通过/7 跳过，构建通过）。跳过项包含既有 opt-in 检查，不以此声称 live server 验收。

## 交付边界

Slice 0 不改变生产授权、预算、领域模型、配置或命令。Slices 1–5 的组合测试通过后在 Slice 6 一次切换。Pi 内置命令/快捷键/程序入口禁用仍为独立产品缺口，不因本文而视为已经强制实施。安装包、live cluster 和视觉终端验收留给 Slice 7；离线 fixture 不代表这些验收。

Slice 1 记录（2026-11-02）：请求状态、Pi 来源适配、模型流守卫与 staged 配置已实现。针对性离线测试 18/18 通过，覆盖请求身份与计数、并发/失败扣费、未派发拒绝、取消/迟到结果、正常完成、重复文本 follow-up、批处理模式锁定、重试、手动/自动压缩及 before-settle 自动续跑。`npm run verify` 通过：格式、lint、类型检查、47 个测试文件通过/1 跳过，688 个测试通过/7 跳过，构建通过。新部件尚未接入生产；配置名称迁移随 Slice 6 原子生效。

2026-11-03：按统一用户消息边界简化适配器，取代此前“用户 steering 沿用当前请求”与来源标记方案；两个消息队列均逐条交付。新增环境通知回归，验证 custom steering 不刷新额度，空闲通知不启动模型。

Slice 2 记录（2026-11-03）：单一当前选择、同步 MCP 调用接收及无 work epoch 的选择器已作为迁移部件实现，测试见 `tests/unit/execution/accept-mcp-call.test.ts`。启动严格校验名称，运行时 exact 取交集并保留 unavailable selected。已接收调用固定参数、原连接与局部目标身份；改选不撤销调用，无关 inventory/default 刷新不使其失效。原目标消失、指向变化或原工具失效时拒绝旧排队派发。RequestExecution 可合并单调用取消信号与请求信号，取消单个调用不取消整轮请求。连接接口要求同一对象只代表原连接，工具 descriptor 在有效期间保持稳定且不可变；连接撤销、主动中断与 ready 发布顺序由 Slice 3 的协调层负责，结果来源与失败呈现由 Slice 4 接入。生产接线仍留到 Slice 6。

Slice 2 验证：针对性测试 23/23 通过；`npm run verify` 全部通过（格式、lint、类型检查、48 个测试文件通过/1 跳过、706 个测试通过/7 跳过、构建通过）。未执行安装包、live 或视觉验收。

Slice 3 记录（2026-11-03）：`RequestMcpController` 通过注入连接工厂与发布回调协调生命周期，复用现有发现器；仅供迁移组合，生产仍未切换。发布回调必须完成工具安装、环境与通知，且支持撤下全部工具；发布失败时保持关闭。回调接收的 ready publication 是待安装内容，回调完成前其 accept 仍拒绝执行，controller.snapshot 仍非 ready；不应在发布回调里等待恢复命令或诊断调用成功。完成发布不等待模型确认。工具 descriptor/schema 在连接期内深度冻结，捕获的 handler 永远绑定原连接。

连接失效主动中断已接收调用，包括尚未派发的队列成员。连接取消独立于请求取消：前者返回 error，不关闭 RequestExecution；已派发保留时间且不退款，未派发无 dispatch 时间且不扣费。旧底层 transport 即使忽略 abort，其迟到结果也不能返回成功或重新派发；协调器等应用调用收尾后关闭旧连接，再发现替换连接。发现调用只走生命周期，不通过诊断 accept，不消耗请求额度。恢复本身没有 Pi 或模型入口，不创建请求、不改计数、不唤醒空闲模型、不重建扩展。

Slice 3 针对性验证：`tests/unit/execution/request-mcp-controller.test.ts`、`accept-mcp-call.test.ts`、`request-execution.test.ts` 共 38/38 通过。新增组合覆盖 active/queued、force/断线、异步 publication 屏障、工具/schema/inventory/发布失败、发布中断线、撤工具失败、新 schema、exact/all 和退出。认证及 Kubernetes 操作错误不把健康 transport 标为断线；结果的模型可见封装、脱敏与失败分类由 Slice 4 交付。未执行安装包、live 或视觉验收。

Slice 3 完整门禁：`npm run verify` 通过（格式、lint、类型检查、49 个测试文件通过/1 跳过、728 个测试通过/7 跳过、构建通过）。跳过项为既有 opt-in 检查，不代表 live server 验收。

Slice 4 记录（2026-11-03）：`createRequestMcpToolBridge` 消费 Slice 3 publication 的原连接 accept，结果直接供 Pi 使用，不经过 EvidenceStore。`content` 内来源包含操作、完整 context、namespace/省略说明、执行状态、适用时间和截断情况；details 仅含状态、截断及安全错误类别。未派发 context 是请求目标，没有查询时间；已派发时间为客户端执行区间，不表示 Kubernetes 对象的观测时间。正文、来源及 details 的完整序列化结果共用 `maxTextChars`，派发前预留最坏来源和截断提示；无法完整、安全地呈现身份时不派发，拒绝说明可隐藏身份但不改写它。raw retention 只允许 disabled；敏感正文脱敏，二进制省略，无临时原始文件、领域写入或取回入口。

身份与执行错误归属 `src/execution/identity.ts`、`errors.ts`，新路径不引用 domain validation/errors。只保留执行需要的 display-safe/UTF-8 身份校验、取消、预算和失败分类。旧生产路径及其领域代码保持到 Slice 6 原子删除。

Pi 0.99.0 的 `prepareToolCall` 会在 schema/abort 拒绝后跳过 handler 与 `afterToolCall`，不能仅用 `tool_result` 覆盖全部结果。`RequestToolResultBoundary.protectMessage` 必须在 Session 初始化时注册到 `message_end`；同一个 boundary 跨连接替换及工具 publication 共用。由 boundary 标记过的结果保持原来源；其余批准工具的 Pi 前置拒绝被替换为受限的未执行说明，原 schema 错误及参数不进入工具结果历史。真实 Pi fixture 验证替换先于 provider input 与 SessionManager persistence。模型自己生成的 assistant 工具参数不属于服务端响应脱敏范围。

Slice 4 针对性离线验证 74/74 通过；完整 `npm run verify` 通过（50 个测试文件通过/1 跳过、751 个测试通过/7 跳过、构建通过）。生产尚未接线；Slice 6 同时接入 bridge 与 message_end boundary。安装包、live 与视觉验收未执行。

Slice 5 记录（2026-11-04）：`registerRequestEnvironment` 必须随扩展在启动时注册一次；工具安装后调用其 `publish(publication)`，与工具发布共同位于 Slice 3 ready 屏障内；用户改选由新 `/clusters` 调用 `refresh()`。外部直接更改 selection/inventory 后也须 refresh/publish。生产接线及新 request prompt 的替换仍由 Slice 6 一次完成，不与旧环境扩展共同注册。

环境通知比较当前选择、inventory 名称/目标与 MCP 状态，不比较 default 元数据、工作状态或执行 revision。连接撤下时保留上次已验证 inventory 仅作恢复比较；available targets 仍为空，exact 项标 unavailable selected。MCP 恢复后按新 inventory 展示并通知 added/removed/target changed，不输出 endpoint。相同快照不再追加消息；custom steering 不创建请求，空闲不启动模型。

压缩恢复使用每次模型调用前的 `context`，而非 `before_agent_start`：当前环境缺失/过期才追加一份模型输入快照，已有最新快照时不重复。该恢复不写领域状态、不重建丢失历史，也不保留最近事件列表；统一提示历史 context/时间不变、同名目标可能改变，缺少必要来源或变化记录时应说明限制并重查。真实 Pi fixture 覆盖手动 compaction 以及 overflow compaction 后无额外用户消息的直接重试，并断言请求/计数保持。工具 call UI 显示请求 context；实际执行与时间仍以工具结果中的来源为准。

Slice 5 针对性离线验证 65/65 通过；安装包、live 与视觉终端未执行，生产仍保持旧路径。

Slice 5 完整门禁：`npm run verify` 通过（格式、lint、类型检查、51 个测试文件通过/1 跳过、761 个测试通过/7 跳过、构建通过）。跳过项为既有 opt-in 检查，不代表 live server 验收。
