# 调查与 Context 状态简化 — Slice 7 验收

验收日期：2026-11-04（America/Toronto；工具结果 UTC 时间为 2026-11-05）。Slices 0–6 已交付；本轮完成离线回归、提取安装包运行、实际 TTY 交互、真实 server 契约及一次性 kind 只读检查。**视觉终端验收待完成，Slice 7 不标为全部完成。**

依据：[Implementation Slices](./INVESTIGATION_CONTEXT_SIMPLIFICATION_IMPLEMENTATION_SLICES.md) 第 10–11 节。Phase 1–4 的历史结果及 Phase 4 视觉待办保持不变。Pi 内置历史导航、会话替换与 reload 入口禁用是独立交付缺口。

## 1. 验证边界

- 应用组合：[application-lifecycle.test.ts](../tests/integration/application-lifecycle.test.ts) 使用生产 `SreApplication`、真实 Pi 0.99.0 Session/扩展/hooks、managed stdio MCP 和 recording fake server；只替换终端与模型网络 I/O。新增 gate fixture 控制响应释放，不靠固定延时争抢改选/取消/重连时机。
- 包：[package.test.ts](../tests/e2e/package.test.ts) 执行 `npm pack`，在 checkout 外提取，验证 CLI，并将同一应用组合测试的静态导入指向提取包 `dist` 后另起 Vitest 运行。复用锁定的 node_modules，不声称验证了干净网络安装或依赖下载。
- 实际交互：`npm run manual:clusters -- --offline-model` 运行提取包的真实 Pi InteractiveMode。仅模型响应由 loopback SSE fixture 提供，MCP 为独立 recording fake 子进程，不需要模型账号，不访问 Kubernetes。模型 fixture 只证明执行路径，不评价诊断质量。
- Live：[slice7-live.test.ts](../evals/slice7-live.test.ts) 通过显式环境变量启用，连接真实 Kubernetes MCP Server 0.0.67 和一次性 kind 集群。应用运行时代码、工具注册、结果边界和 Pi Session 保持真实，模型流确定化。

## 2. 离线验收矩阵

| 场景组                               | 结果 | 可复查证据                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直接查询、追问、用户补充及报告后继续 | 通过 | application lifecycle：repeated queries；user steering and queued follow-ups。四条用户消息逐条获得完整预算，各产生一次成功查询；只注册六个诊断工具和 clusters/mcp_restart 两个应用命令                                                                                                                                                                           |
| 请求双重限制                         | 通过 | application lifecycle：independent request limits、iteration ceiling、active request balance；[Pi boundaries](../tests/integration/pi-execution-boundaries.test.ts) 验证 retry、manual/overflow compaction、before-settle continuation、custom steering 均不重置；[RequestExecution](../tests/unit/execution/request-execution.test.ts) 验证并发计费与失败不退款 |
| 活动与排队取消                       | 通过 | application lifecycle 的 cancel/force/disconnect 三组：六调用同时接收，仅四个派发；六个原 ID 各返回一次错误；释放迟到响应后下一请求仍独立成功，历史结果不变                                                                                                                                                                                                      |
| 实时改选                             | 通过 | application lifecycle：六个已接收 alpha 调用（含两个排队）在改选 beta 后仍成功保留 alpha 来源；后续新 alpha 被拒绝，不进入 MCP                                                                                                                                                                                                                                   |
| exact/all、不可用及启动校验          | 通过 | [accept-mcp-call](../tests/unit/execution/accept-mcp-call.test.ts)、[context resolver](../tests/unit/cluster/context-resolver.test.ts)、[environment/picker](../tests/unit/tui/request-environment.test.ts)；生产组合另验证恢复后 exact beta 不可用；live 复核成员消失、恢复及新成员                                                                             |
| 连接替换与失败关闭                   | 通过 | application lifecycle 覆盖真实子进程 force/disconnect 和非只读恢复配置关闭工具；[controller](../tests/unit/execution/request-mcp-controller.test.ts) 覆盖工具/schema/inventory 变化、发现/撤下/发布失败、捕获旧 handler 和迟到成功                                                                                                                               |
| 恢复时机与余额                       | 通过 | application lifecycle：原已派发调用被中断后不退款，恢复 publication 完成再继续的新调用因预算耗尽拒绝；空闲 force 不增加模型次数，下一用户请求成功                                                                                                                                                                                                                |
| 来源与压缩                           | 通过 | Pi boundaries 覆盖 A/B 同名 Pod、同名 context 指向变化、历史来源不变、手动/自动压缩后直接模型调用恢复环境；application/package 验证生产 hook 接线和环境存在                                                                                                                                                                                                      |
| 结果与安全                           | 通过 | [request-tool-bridge](../tests/unit/execution/request-tool-bridge.test.ts)、[normalizer](../tests/unit/mcp/result-normalizer.test.ts) 覆盖成功/空/失败/取消/未执行/截断、namespace 省略、长身份、超小限额、敏感字段、binary omission；生产组合确认安全前置拒绝进入模型/会话/transcript，无独立领域 ID                                                            |
| 单一 Session 与退出                  | 通过 | application lifecycle：重连保持 Session 和命令注册、quit/信号/启动失败清理 MCP 子进程与信号订阅；包内重复相同断言。不恢复已删除的切换/reload 语义                                                                                                                                                                                                                |

重试/压缩等细项由真实 Pi 边界组合测试验证；没有声称每一细项都在真实终端或 live 环境重新执行。

## 3. 安装包与实际 TTY 记录

实际运行 workspace：`/var/folders/x_/d8pk5_915glcnx6kg3cgfzc40000gn/T/pi-sre-manual-clusters-kYZGG4`。在该目录运行提取包 `package/dist/main.js`，应用 home 为其 `app/`。使用安全 YAML 与 `read_only = true` TOML 启动。该路径为本机临时证据，不是持久化调查库。

| 操作                                              | 实际 TTY / transcript 结果                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 启动                                              | READ ONLY；All (*)；available alpha/beta；unavailable 0；MCP ready；namespace 省略策略明确                                              |
| `compare alpha beta`                              | 两次 pods_list 各显示准确 requested context；结果各含完整 context、default namespace、执行时间、success 和 redacted token；随后直接报告 |
| `/clusters beta`                                  | 立即显示 Exact beta，available 1，unavailable 0                                                                                         |
| `/mcp_restart --force`                            | 保留 Exact beta，恢复后 ready；未自动启动模型                                                                                           |
| `inspect beta` 后 Escape                          | 已派发调用返回 cancelled、准确 beta 和时间；不发布成功；回到输入状态                                                                    |
| 将 fixture inventory 改为 alpha-only，再 force    | Exact beta 保留，available 0，unavailable beta，availability blocked；MCP 仍 ready，与集群认证/操作失败区分                             |
| 再次 `inspect beta`                               | not-executed / scope-unavailable，无 dispatch 时间；无 MCP 诊断派发                                                                     |
| fixture 恢复 alpha/beta，再 force、`inspect beta` | beta 自动恢复为候选；下一用户请求成功，保留原错误与取消历史                                                                             |
| `/quit`                                           | 进程正常退出，最后一个 fixture PID 已不存在                                                                                             |

Transcript：`app/sessions/2026-11-05T03-37-57-441Z_01a1a9c8-e3c0-75e6-8c25-1732c031ddd5.jsonl`。五个工具结果按 ID `manual-1` 至 `manual-5` 分别为 success、success、cancelled、not-executed(scope-unavailable)、success。记录仅保留正常受限工具结果；未导出原始 MCP 响应。fixture call log 位于 `app/fixture.pid.calls`，只有合成参数。测试用 inventory/延时在该临时 workspace 中修改；复验可直接使用下列已纳入仓库的命令。

```bash
npm run manual:clusters -- --offline-model
```

此命令自动启动本地确定性模型和 3 秒延时 MCP fixture，便于按 Escape；退出关闭本地模型服务。需要测试 unavailable 时，编辑输出配置中的场景参数为 `diagnostic-alpha-only`，再 force；恢复用 `diagnostic-success`。合成 MCP 不读取 kubeconfig；真实 kubeconfig 不变的断言另见 live 检查。

## 4. 实际 server 与只读 live

`npm run test:contracts`：**7/7 通过**。使用安装的 server 0.0.67，验证冻结 schema/inventory/启动失败和 mock API 显式 context routing。这是 server 契约检查，不等于 live Kubernetes 查询。

一次性集群 `pi-sre-slice7`，kind node `v1.37.0`；创建时显式 `--kubeconfig /tmp/pi-sre-slice7-kubeconfig`。未使用默认 current context。应用的 Kubernetes 查询仅经 MCP 的 approved pods_list；没有通过 shell/kubectl 绕开策略，没有故障注入、资源写入或受控操作。

```bash
kind create cluster --name pi-sre-slice7 --kubeconfig /tmp/pi-sre-slice7-kubeconfig --wait 60s
PI_SRE_SLICE7_KUBECONFIG=/tmp/pi-sre-slice7-kubeconfig npx vitest run evals/slice7-live.test.ts
kind delete cluster --name pi-sre-slice7
```

Live **2/2 通过**（exact/all 各一组）。测试只接受上述唯一命名的测试 context，将其复制到临时私有 kubeconfig 并赋予 alpha/beta/gamma 别名；输入文件逐字节比较不变。查询 kube-system 实际 Pod，alpha/beta 结果均包含同名 coredns 对象且带各自来源。重连删除 beta、加入 gamma，再恢复 beta：exact 保留 beta unavailable、不接纳 gamma，all 跟随 inventory；恢复不唤醒模型，后续用户查询成功，历史结果不改写。临时 kubeconfig 与 Session 在 finally 清理；验收后已删除 kind 集群。

本轮 alpha/beta 是同一物理 kind 集群的不同 context，证明显式路由、同名对象来源及成员恢复；不声称验证了两个独立物理集群故障隔离或只读 RBAC 的负向拒绝；本轮使用 kind 测试凭据，操作受应用 allowlist 和 MCP read_only 限制。独立目标/失败隔离由 recording fixture 覆盖。应用查询为只读；kind 创建/销毁和临时 kubeconfig 编辑仅属测试环境管理。

初次 sandbox 执行无法访问 loopback Kubernetes API，结果为失败；取得执行权限后重跑 2/2 通过。没有以初次失败伪装成空结果。

## 5. 视觉终端待验收

Computer Use 返回：`Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.` 因而本轮未获取或检查终端截图。实际 TTY 的文本输出与 transcript 已检查，但不能据此声明布局、裁切、颜色或 picker 视觉验收通过。

待在允许的真实终端中复验：当前 exact/all、完整 unavailable selected、每次调用 context、READ ONLY/MCP/namespace 状态、取消/恢复反馈，以及 picker 的 unavailable 行和 Apply/Cancel。使用上节离线命令即可复现，无需生产集群或模型账号。完成后在本文件追加日期、终端尺寸、截图证据及结果，再关闭 Slice 7。

## 6. 门禁

针对性应用组合测试 **18/18 通过**；包测试在统一门禁中再次执行同一组 18 项。`npm run verify` 全部通过：格式、lint、TypeScript、25 个测试文件通过/2 跳过、400 个测试通过/9 跳过、构建通过。正常 `npm test` 跳过 7 项显式 server 契约和 2 项 live；它们本轮已分别 opt-in 通过，不能将 skip 本身记为通过。
