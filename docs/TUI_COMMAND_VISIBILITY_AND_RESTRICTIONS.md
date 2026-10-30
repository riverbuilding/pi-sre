# TUI 内置命令的隐藏与禁用

本文记录基于当前安装的 Pi `0.99.0` 核实的会话操作行为，以及 Pi SRE 可以采用的命令控制方式。
目前 Pi SRE 尚未实现本文描述的会话命令隐藏或禁用策略；本文不改变现有功能。

2026-10-30 更新：架构现在即按单一 AgentSession、禁止历史导航及 reload/rebind 设计，直接移除相应兼容与恢复机制；只有命令、快捷键和程序入口禁用的实现作为后续功能交付。不因入口尚未关闭而维持会话切换或扩展重绑支持。正常请求取消、MCP 重连和退出清理仍保留；未完成入口拦截时不能宣称禁令已强制执行。最新执行边界见 [调查简化方案第 12 节](./INVESTIGATION_CONTEXT_SIMPLIFICATION.md#12-单一-session-架构与后续入口禁用)。

## 1. `/new`、`/fork`、`/resume` 如何切换会话

这些操作在同一个终端窗口、同一个 TUI 中切换当前会话，不会新开窗口。
旧会话保留已保存的历史，但不会作为后台 Agent 继续运行。

| 命令      | 行为                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `/new`    | 创建空白会话并切换过去                                                                                 |
| `/fork`   | 显示历史用户消息选择器；从选定消息之前的历史创建新会话，切换过去，并把选中的消息放回输入框供修改后发送 |
| `/resume` | 选择已保存的会话并切换过去                                                                             |
| `/clone`  | 从当前历史末端复制新会话并切换过去，底层使用 fork 路径                                                 |

Pi 的 `AgentSessionRuntime` 在替换当前会话时先中止并结算活动轮次，发送
`session_shutdown`，再 dispose 旧 `AgentSession`、创建新实例并重新绑定扩展。
TUI 继续使用同一个 runtime host。

需要两个 Agent 同时工作时，应分别启动两个应用进程，例如使用不同终端窗口或 tmux pane。

## 2. Pi SRE 的会话隔离

本节记录当前实现及 Phase 4 历史契约，不是调查模型移除后的设计。Session 是 Pi 的对话抽象，Incident 是当前 Pi SRE 的调查领域对象。
复制聊天历史不等于复制调查执行权限。

- 新建会话或 fork 使用新的会话身份，不自动继承原 Incident、证据、假设和预算。
- 在同一个应用进程内切回原会话，如果映射及调查仍保留，可以重新绑定并恢复访问。
- 切换会话不会自动把原 Incident 标为结束，但原绑定的执行权限会失效。
- 应用重启后，打开旧聊天文件不会从 transcript 重建调查状态或权限。

详细生命周期见 [Session 生命周期与扩展](./SESSION_LIFECYCLE_AND_EXTENSIONS.md)
和 [Investigation 生命周期与历史查询](./INVESTIGATION_LIFECYCLE_AND_HISTORY.md)。
相关全链路断言见 [Phase 4 acceptance](../tests/integration/phase4-acceptance.test.ts)。

## 3. 隐藏菜单与禁止操作是两层控制

这里的“菜单”指在编辑器输入 `/` 时出现的命令补全列表。

| 控制方式     | 效果                         | 边界                                             |
| ------------ | ---------------------------- | ------------------------------------------------ |
| 过滤命令补全 | 菜单不再显示指定命令         | 手动完整输入、快捷键或其他调用路径仍可能执行操作 |
| 生命周期否决 | 阻止实际创建、恢复或分叉会话 | 命令仍可能显示，选择器也可能先打开               |
| 两者结合     | 菜单隐藏，同时禁止相关操作   | 不等于从所有帮助文本和快捷键提示中删除命令       |

禁用会话操作需要同时处理展示和执行；单纯隐藏只改变可见性。
第 8 节记录后续功能的全运行期 AgentSession 切换禁令及其他命令建议；这些限制独立排期，本文尚未实施。

## 4. 使用公开扩展接口过滤补全

当前 Pi 提供 `ctx.ui.addAutocompleteProvider(factory)`。
factory 接收原有 `AutocompleteProvider`，返回包装后的 provider，因此 Pi SRE
可以在应用自有扩展中处理，不需要修改 Pi 源码或 `node_modules`。

实现时应：

1. 当前 Pi 可在 `session_start` 中注册包装器；Pi SRE 按单一 Session 架构仅在启动时初始化、退出时清理，不实现 reload 后重新注册或恢复。
2. 将 `getSuggestions()` 委托给原 provider，再从命令候选项中移除指定项。
3. 保留返回值的 `prefix`；没有候选结果时保持原有空结果语义。
4. 将 `applyCompletion()`、文件补全判断和触发字符等行为委托给原 provider。
5. 只过滤目标命令，保留参数补全、文件路径补全及其他扩展命令；使用当前安装版本实际返回的候选值匹配。

Pi 的 TUI 在创建基础补全器后按顺序应用这些包装器，也会在相关资源更新后重新组装补全器。
不需要替换整个编辑器，也不应通过注册同名扩展命令覆盖内置命令。

## 5. 使用生命周期钩子禁止操作

当前 Pi 在会话替换前提供可取消事件：

| 操作         | 事件                    | 判定                              |
| ------------ | ----------------------- | --------------------------------- |
| new          | `session_before_switch` | `event.reason === "new"`          |
| resume       | `session_before_switch` | `event.reason === "resume"`       |
| fork / clone | `session_before_fork`   | 如需区分，可检查 `event.position` |

处理器返回 `{ cancel: true }` 即可否决。下面仅为禁用全部上述操作的示例，尚未接入 Pi SRE：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerSessionRestrictions(pi: ExtensionAPI): void {
  pi.on("session_before_switch", (_event, ctx) => {
    ctx.ui.notify("Pi SRE 已禁用会话切换。", "warning");
    return { cancel: true };
  });

  pi.on("session_before_fork", (_event, ctx) => {
    ctx.ui.notify("Pi SRE 已禁用会话分叉。", "warning");
    return { cancel: true };
  });
}
```

这些事件在中止旧轮次和替换当前会话前执行。否决后不替换当前会话或 Investigation binding。
通过相同 runtime 路径触发的快捷键、扩展调用也会经过这些事件。
但 `/fork`、`/resume` 的选择器可能已经打开；钩子阻止的是最终操作。

普通 `pi.on("input")` 不适合拦截这些 TUI 内置命令：TUI 在把输入交给普通 prompt/input
处理前已经识别并执行内置命令。其他内置命令也不一定具有上述会话钩子，需要分别检查其执行路径。

## 6. 后续实现的验证范围

- 输入 `/` 或命令前缀时，目标命令不出现，其他补全保持可用。
- 手动输入被禁用命令、使用对应快捷键或 runtime 调用时，操作被拒绝且原因可见。
- 被拒绝后当前 session ID、消息历史和活动请求预算保持不变。
- `/reload` 及程序调用的扩展 reload/rebind 被拒绝，不触发扩展 shutdown/start 或重新绑定。
- 后续禁令交付后，普通回答结束也不解除 AgentSession 替换与扩展重绑禁令；追问直接通过 messages 延续。

## 7. 核实入口

Pi 依赖内的文件路径以包根目录为基准：

- `@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`：内置命令分派、选择器、补全包装器。
- `@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js`：会话替换与可取消事件。
- `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`：`addAutocompleteProvider` 及生命周期事件的公开类型。
- `@earendil-works/pi-tui/dist/autocomplete.d.ts`：补全 provider 契约。
- [Pi SRE runtime 组装](../src/runtime/pi-runtime.ts)：应用自有扩展的注册入口。
- [Pi SRE investigation lifecycle](../src/runtime/investigation-lifecycle.ts)：绑定与解绑逻辑。

升级 Pi 时应重新核实这些接口和事件顺序。

## 8. 调查简化方案下的命令审查（2026-10-29）

本节是设计建议，未实施。与 [调查与 Context 状态简化](./INVESTIGATION_CONTEXT_SIMPLIFICATION.md)
配套。本节于 2026-10-30 调整为独立后续功能，目标是收窄产品入口、统一会话操作体验。
前文第 2 节记录现有 session 隔离行为。架构现在即按相关能力已禁用设计；后续只交付入口拦截，不要求为了等待禁用而保留兼容机制。

后续目标是整个 Pi SRE 应用运行期间禁止切换 `AgentSession` 对象，也禁止同一对象内的历史导航及扩展 reload/rebind，包括对应快捷键和程序调用。普通回答结束不解除禁令。调查简化方案独立移除 Incident、`/incident` 和 `/evidence`，追问通过 messages 延续；context 使用单一当前选择，不再存在“下一次调查选择”。

核实依据为本地安装的 `@earendil-works/pi-coding-agent@0.99.0` 的实现、公开类型与包内文档。
尚未进行实际禁用后的 TUI 验收。

### 8.1 “彻底禁用”的三个层次

1. 补全隐藏：输入 `/` 时不显示。
2. 禁止操作：手动输入、快捷键、runtime 调用均不能完成对应操作。
3. 移除产品入口：不打开选择器，不执行命令前置逻辑，不在帮助里宣传该能力。

生命周期否决可以实现部分命令的第 2 层，但不等于第 3 层。例如 `/resume` 的选择器仍可能先打开，
其中还有重命名、删除保存会话的操作；最终否决 resume 不能关闭这些选择器功能。
`/import` 在否决切换前还会解析路径、检查文件存在性，并可能创建 session 目录。

当前 `InteractiveModeOptions` 没有统一的 built-in command allowlist/denylist，扩展事件也没有
通用的 `before_command` 钩子。内置命令在 TUI 的 `setupEditorSubmitHandler()` 中先行分派，
之后才进入普通 prompt/input，因此不能用普通 `input` 处理器全面阻止它们。

`noTools`、`excludeTools` 与资源加载选项不会关闭这些 TUI 内置命令。

### 8.2 建议优先关闭的命令

其中 `/reload`、替换 `AgentSession` 对象的 `/new`、`/resume`、`/fork`、`/clone`、`/import`，以及同一对象内历史导航的 `/tree`，作为后续功能在整个应用运行期间关闭；对应快捷键和程序调用同样禁止，本次调查简化不实施这些禁令。

| 命令      | 简化收益                                       | 当前公开接口可以做到什么                                         |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `/new`    | 收窄产品为单一对话；追问或换题通过用户消息表达 | `session_before_switch` 否决 `new`；补全与快捷键另行处理         |
| `/resume` | 收窄保存会话恢复入口                           | `session_before_switch` 否决 `resume`；不能阻止选择器先打开      |
| `/fork`   | 减少历史分叉的产品入口                         | `session_before_fork` 否决；不能阻止选择器先打开                 |
| `/clone`  | 避免复制当前历史并切换会话                     | 同样经过 `session_before_fork`，position 为 `at`                 |
| `/import` | 收窄外部历史导入入口                           | 经过 `session_before_switch`，reason 为 `resume`；存在前置逻辑   |
| `/tree`   | 提供连续对话体验，减少历史回退和分支入口       | `session_before_tree` 可以否决实际导航；树浏览器仍可能打开       |
| `/reload` | 后续关闭：扩展变更通过重启应用生效             | 未发现可取消的 reload 前置事件；需要命令与程序调用的操作边界禁止 |

`/tree` 禁用作为独立产品功能，后续在整个运行期禁止历史回退与分支切换；不能继续以已移除的调查证据库一致性作为理由。滚动和搜索已渲染历史继续保留。历史导航从简化架构的支持范围中移除，不再设计对应的活动请求迁移、恢复或兼容流程。

后续交付后，AgentSession 替换和运行时扩展重绑入口在整个进程内关闭，不根据模型是否已经回答而动态启用。调查简化不再提供 `/incident new`；用户直接追加消息继续诊断或切换话题。

### 8.3 可关闭的非调查功能

| 命令                             | 建议                           | 原因与接口边界                                                                            |
| -------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `/share`                         | 默认关闭                       | 上传聊天历史属于额外产品功能；无通用公开否决事件                                          |
| `/bug`                           | 产品入口关闭，开发排障另行处理 | 进入 Pi 上游报告流程，与调查流程无关；无通用公开否决事件                                  |
| `/trust`                         | 关闭                           | Pi SRE 使用固定 app home 与受控资源加载，不需要工作项目 trust 选择器                      |
| `/debug`                         | 产品入口关闭                   | 虽不在补全列表中，仍能手动调用；会写出渲染内容和 agent messages；还有 TUI 全局 debug 入口 |
| `/arminsayshi`、`/dementedelves` | 关闭                           | 源码中存在的隐藏彩蛋命令；无调查用途                                                      |
| `/changelog`                     | 可关闭                         | Pi 上游更新说明不属于调查主流程，但保留也不增加调查领域状态                               |
| `/export`                        | 待定                           | 只导出聊天历史，不等同导出调查证据和假设；若关闭，需命令策略入口                          |
| `/settings`                      | 待定，倾向收窄为 SRE 自有设置  | 不只包含显示选项，还可改变 autoCompact、模型及消息队列行为；无通用公开否决事件            |

这里的“关闭”是产品建议，不表示当前公开 API 已经提供关闭能力。
不应为了少量低影响菜单项引入大量终端输入拦截或维护自己的 TUI。

### 8.4 建议保留的命令

| 命令                                    | 理由                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| `/model`、`/thinking`、`/scoped-models` | 用户控制模型与推理配置，不改变执行范围或历史观察来源           |
| `/login`、`/logout`                     | 保留模型供应商认证入口；与 Kubernetes MCP 认证区分             |
| `/compact`                              | 长对话需要上下文管理；压缩后补充当前环境，不重置本轮预算       |
| `/copy`                                 | 复制回复，不引入调查生命周期分支                               |
| `/session`、`/name`                     | 统计与显示元数据；可以隐藏以精简菜单，但无须为它们建立调查状态 |
| `/hotkeys`                              | 保留可发现的快捷键帮助；目标设计应只展示实际允许的 actions     |
| `/quit`                                 | 正常退出与资源清理                                             |
| `/clusters`、`/mcp_restart`             | Pi SRE 自有入口，分别承担当前选择和 MCP 手动恢复               |

不建议为了简化而一并关闭自动 compaction。若产品只想禁止手动压缩，`session_before_compact`
可以按 `reason === "manual"` 区分；但上下文阈值和 overflow 恢复仍需保留，不能无差别 cancel。
当前环境重注入继续保留，且须覆盖自动压缩后的直接续跑。调查简化将移除 `/incident`、`/evidence` 和独立证据库，不承诺保留完整原始结果；这与禁用 Pi 内置命令分开交付。

### 8.5 不是 slash command 的相关入口

- `app.session.new/tree/fork/resume`：即使当前默认没有按键绑定，用户配置仍可启用，
  因此后续需要运行时操作否决或统一 action 策略兜底。Keybindings 配置的空数组仅禁用对应快捷键。
- `app.editor.external`：可以用空绑定取消默认外部编辑器入口；这只改变编辑输入方式，
  是否关闭对调查领域简化的收益有限。
- TUI 全局 debug handler：与 `/debug` 共用处理逻辑；仅拦截 slash 命令仍未关闭全部路径。
- `!`、`!!`：现有 `user_bash` guard 已阻止执行，模型内置 shell 工具也已排除；保持该边界。
  若要求连 shell 模式 UI 都不出现，需要更早的 TUI 输入策略。
- 自动发现的扩展、skills、prompt templates：当前资源加载已关闭；这与内置命令是不同机制。
  包内 slash 文档列出的 `/llama` 没有在当前 TUI 硬编码分派表中出现；属于扩展命令方向，
  不应仅凭通用文档认定 Pi SRE 已暴露。后续以实际加载的扩展命令清单核验。
- Escape 取消、退出、模型切换、消息 steering、滚动与搜索应继续保留。
  LLM 的环境变化消息需要 steering，不应因关闭 session 导航而误删。

### 8.6 推荐的实现边界

可以先通过现有公开接口实现的最小策略是：

1. 用 `session_before_switch`、`session_before_fork`、`session_before_tree` 否决会话替换与历史导航。
2. 过滤对应补全，并移除相关快捷键绑定。
3. 明确剩余限制：部分选择器仍能打开；`/reload` 等仍没有通用禁用接口。因此，这套最小策略不足以满足已确认的禁止运行时扩展重新绑定约束，不能作为完整交付方案。

若要求真正从产品中移除这些入口，建议给 Pi 增加一个小而统一的 command/action policy 能力，
由 Pi SRE 在构造 TUI 时配置。不新增调查领域 epoch 或权限层。
以下是期望接口语义，不是当前 Pi 已存在的 API：

- 同一份策略控制补全、帮助与执行；在打开选择器和产生前置副作用之前拒绝。
- 处理手动完整输入、带参数命令、快捷键，以及未在补全表中的隐藏命令。
- 内置命令使用显式 allowlist；SRE 自有扩展命令通过受控注册保留。
- 禁止的命令明确反馈，不回落成普通用户问题发给 LLM。
- 会话替换与导航仍在对应 runtime 操作边界拒绝，避免程序调用绕过 UI。
- reload/rebind 在命令与程序调用的操作边界均禁止；不能在 `session_shutdown` 后才尝试否决。扩展仅启动时初始化、退出时释放，变更扩展需要重启应用。
- 退出和取消始终可用。

不建议直接修改 `node_modules`、覆盖同名内置命令，或解析终端按键流模拟命令禁用。
自定义 editor 可以改变提交路径，但需要额外覆盖粘贴、快捷键、帮助与程序调用，不是统一策略的替代。
如果新增 Pi 接口，需要单独确定上游改动或受维护依赖版本的交付方式。

调查模型简化现在即以单一 Session、无历史导航和无 reload/rebind 为架构前提，删除 session 映射、领域 binding、epoch、会话/分支恢复、扩展重新绑定和状态重新挂接机制，不等待入口禁用交付，也不保留过渡兼容代码或测试。正常用户请求归属、取消、调用收尾和退出时的订阅/资源清理继续保留，不为不受支持的会话切换或 reload 重建权限层。

本功能需单独确定 Pi 接口及上游改动或受维护依赖版本的交付方式，落实架构已采用的禁令。尚未关闭的入口是交付缺口，不代表仍支持相应能力；不得宣称禁用已完成。Pi 自身的资源清理、compaction 和正常请求取消职责继续保留。

### 8.7 实施时验收

- 禁用命令不出现在补全和产品帮助中；手动输入及带参数形式明确拒绝。
- 快捷键与 runtime 会话调用不能完成禁止的操作。
- 整个应用运行期间不能替换当前 `AgentSession` 对象，普通回答结束后禁令保持。
- 整个应用运行期间不能通过 `/tree`、快捷键或程序调用回退历史或切换分支；普通回答结束后禁令保持，滚动和搜索已渲染历史仍可用。
- Context 选择仍可随时修改，新接收调用按新选择校验，不产生“下一次调查选择”；已接收调用按调查简化方案第 10、11 节处理。
- 不打开已禁用的 resume/tree/fork 选择器；不能从选择器删除保存会话。
- `/import`、`/reload`、`/share`、`/bug`、`/debug` 被拒绝时不执行其前置副作用。
- `/reload`、程序调用和会话替换均不能触发运行时扩展重新绑定；MCP reconnect 只更新连接与工具，不重新绑定扩展。
- 拒绝后不改变当前会话历史和活动请求预算，也不触发新一轮 LLM 调用。
- 保留命令、自动 compaction、LLM 环境事件 steering、取消与退出正常工作。
- 升级 Pi 时比较命令与 action 清单，检查是否新增了隐藏入口。

额外核实入口：

- `dist/core/slash-commands.js`：补全中的内置命令清单。
- `dist/modes/interactive/interactive-mode.js`：`setupEditorSubmitHandler()`、`setupKeyHandlers()`、
  `handleReloadCommand()`、`handleImportCommand()` 与 debug handler。
- `dist/modes/interactive/interactive-mode.d.ts`：当前 `InteractiveModeOptions`。
- `dist/core/agent-session-runtime.js`：new/resume/fork/import 的前置事件与操作顺序。
- `dist/core/agent-session.js`：`navigateTree()` 和 compaction 的前置事件。
- 包内 `docs/keybindings.md`、`dist/core/extensions/types.d.ts`：action 绑定与公开钩子。
