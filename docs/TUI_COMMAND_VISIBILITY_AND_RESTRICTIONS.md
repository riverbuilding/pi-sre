# TUI 内置命令的隐藏与禁用

本文记录基于当前安装的 Pi `0.99.0` 核实的会话操作行为，以及 Pi SRE 可以采用的命令控制方式。
目前 Pi SRE 尚未实现本文描述的会话命令隐藏或禁用策略；本文不改变现有功能。

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

Session 是 Pi 的对话抽象，Incident 是 Pi SRE 的调查领域对象。
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

如果产品需要禁用会话操作，应同时处理展示和执行；单纯隐藏只改变可见性。
具体禁用哪些功能仍需单独确定，本文不决定移除现有会话能力。

## 4. 使用公开扩展接口过滤补全

当前 Pi 提供 `ctx.ui.addAutocompleteProvider(factory)`。
factory 接收原有 `AutocompleteProvider`，返回包装后的 provider，因此 Pi SRE
可以在应用自有扩展中处理，不需要修改 Pi 源码或 `node_modules`。

实现时应：

1. 在 `session_start` 中注册包装器，使新建、切换及 reload 后重新生效。
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
- 被拒绝后当前 session ID、Incident、证据和预算保持不变。
- reload 和成功的会话替换后策略仍生效，不重复叠加包装器。
- 若允许部分会话操作，继续保留现有会话隔离和历史不授予权限的验收行为。

## 7. 核实入口

Pi 依赖内的文件路径以包根目录为基准：

- `@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`：内置命令分派、选择器、补全包装器。
- `@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js`：会话替换与可取消事件。
- `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`：`addAutocompleteProvider` 及生命周期事件的公开类型。
- `@earendil-works/pi-tui/dist/autocomplete.d.ts`：补全 provider 契约。
- [Pi SRE runtime 组装](../src/runtime/pi-runtime.ts)：应用自有扩展的注册入口。
- [Pi SRE investigation lifecycle](../src/runtime/investigation-lifecycle.ts)：绑定与解绑逻辑。

升级 Pi 时应重新核实这些接口和事件顺序。
