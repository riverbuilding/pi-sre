import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { createRequestMcpToolBridge } from "../../../src/mcp/request-tool-bridge.js";
import { scopedPodTool } from "../../fixtures/scoped-tool.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ContextEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { RequestMcpPublication } from "../../../src/app/request-mcp-controller.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { CurrentClusterSelection } from "../../../src/cluster/current-selection.js";
import {
  captureEnvironment,
  environmentDescription,
  environmentChanges,
  environmentLines,
  createRequestSreSystemPrompt,
} from "../../../src/runtime/request-environment.js";
import { registerRequestEnvironment } from "../../../src/tui/request-environment-extension.js";

const inventory = (
  names: string[],
  server = "https://private.invalid/?token=secret",
  isDefault = false,
) =>
  new ClusterContextRegistry(
    names.map((name, i) => ({ name, server, isDefault: isDefault && i === 0 })),
  );
function setup() {
  const selection = new CurrentClusterSelection(inventory(["A", "B"]), {
    rule: { kind: "exact", contexts: ["A", "B"] },
  });
  const state = (status: RequestMcpPublication["status"] = "ready"): RequestMcpPublication => ({
    status,
    selection,
    tools: [],
    message: "password=untrusted",
  });
  const sendMessage = vi.fn();
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1];
  // Only the registration surface is faked; all selection/publisher behavior is real.
  const pi = {
    on: (name: string, handler: (event: never, ctx: never) => unknown) => {
      handlers.set(name, handler);
      return () => {
        handlers.delete(name);
      };
    },
    sendMessage,
    registerCommand: (_name: string, value: typeof command) => {
      command = value;
    },
  } as unknown as ExtensionAPI;
  const environment = registerRequestEnvironment(pi);
  const ui = { notify: vi.fn(), select: vi.fn(), setWidget: vi.fn() };
  const ctx = { ui, isIdle: () => false } as unknown as ExtensionCommandContext;
  const fire = (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event as never, ctx as never);
  fire("session_start");
  environment.publish(state());
  return { selection, state, environment, sendMessage, ui, fire, command: () => command, ctx };
}

describe("Slice 5 environment and current cluster UI", () => {
  it("shares exact partial/empty/recovered facts across command, widget, model and picker during active work", async () => {
    const f = setup();
    for (const names of [["A", "C"], ["C"], ["A", "B", "C"]]) {
      f.selection.updateInventory(inventory(names));
      f.environment.publish(f.state());
      await f.command().handler("--status", f.ctx);
      const text = f.ui.notify.mock.calls.at(-1)![0];
      expect(text).toBe(environmentLines(captureEnvironment(f.state()), true).join("\n"));
      expect(text).not.toContain('"C"');
      expect(text).toContain(
        names.length === 1
          ? "Availability: blocked"
          : names.length === 2
            ? "Availability: partial"
            : "Availability: available",
      );
      const widget = f.ui.setWidget.mock.calls.at(-1)![1];
      expect(widget).toEqual(environmentLines(captureEnvironment(f.state())));
    }
    f.selection.updateInventory(inventory(["A"]));
    f.environment.refresh();
    f.ui.select.mockImplementation(async (_title, rows: string[]) => {
      expect(rows).toContain('[x] "B" (unavailable)');
      return "Apply selection";
    });
    await f.command().handler("", f.ctx);
    expect(f.selection.rule).toEqual({ kind: "exact", contexts: ["A", "B"] });
    f.ui.select
      .mockResolvedValueOnce('[x] "B" (unavailable)')
      .mockResolvedValueOnce("Apply selection");
    await f.command().handler("", f.ctx);
    expect(f.selection.rule).toEqual({ kind: "exact", contexts: ["A"] });
    await f.command().handler("--all", f.ctx);
    expect(f.selection.rule).toEqual({ kind: "all" });
    f.environment.dispose();
  });

  it("deduplicates refreshes/default metadata and emits safe target changes across a withdrawal", () => {
    const f = setup();
    f.environment.publish(f.state());
    f.selection.updateInventory(inventory(["B", "A"], undefined, true));
    f.environment.refresh();
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    f.selection.updateInventory(inventory([]));
    f.environment.publish(f.state("connecting"));
    expect(JSON.stringify(f.sendMessage.mock.calls.at(-1))).toContain("Available targets: 0");
    f.selection.updateInventory(inventory(["A", "B"], "https://new-private.invalid"));
    f.environment.publish(f.state());
    const notice = f.sendMessage.mock.calls.at(-1)![0].content;
    expect(notice).toContain('Inventory target changed: 2 ["A", "B"]');
    expect(notice).not.toMatch(/private|secret|untrusted|https:/);
    expect(f.sendMessage.mock.calls.at(-1)![1]).toEqual({ deliverAs: "steer" });
    f.environment.dispose();
  });

  it("restores only absent/outdated environment without replaying history or changing it", () => {
    const f = setup();
    const message = f.sendMessage.mock.calls[0]![0];
    const event: ContextEvent = {
      type: "context",
      messages: [{ ...message, role: "custom", timestamp: 1 }],
    };
    expect(f.fire("context", event)).toBeUndefined();
    const missing: ContextEvent = { type: "context", messages: [] };
    const restored = f.fire("context", missing) as { messages: ContextEvent["messages"] };
    expect(restored.messages).toHaveLength(1);
    expect(missing.messages).toEqual([]);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.fire("context", { ...missing, messages: restored.messages })).toBeUndefined();
    f.environment.dispose();
    expect(f.ui.setWidget.mock.calls.at(-1)![1]).toBeUndefined();
    expect(f.fire("context", missing)).toBeUndefined();
    expect(() => f.environment.publish(f.state())).toThrow("closed");
  });

  it("refuses stale picker drafts and prevents a shutdown-time commit", async () => {
    const f = setup();
    f.ui.select.mockImplementationOnce(async () => {
      f.selection.updateInventory(inventory(["B"]));
      return "Apply selection";
    });
    await f.command().handler("", f.ctx);
    expect(f.ui.notify.mock.calls.at(-1)![0]).toContain("Selection refused");
    f.ui.select.mockImplementationOnce(async () => {
      f.fire("session_shutdown");
      return "Apply selection";
    });
    await f.command().handler("", f.ctx);
    expect(f.selection.rule).toEqual({ kind: "exact", contexts: ["A", "B"] });
  });

  it("bounds names, suppresses unsafe identities and ignores endpoint/default data in descriptions", () => {
    const selection = new CurrentClusterSelection(
      inventory([
        "password=hidden",
        "control\u001b",
        ...Array.from({ length: 24 }, (_, i) => `${i}-${"x".repeat(900)}`),
      ]),
    );
    const facts = captureEnvironment({
      status: "ready",
      selection,
      tools: [],
      message: "token=hidden",
    });
    const text = environmentDescription(facts);
    expect(text.length).toBeLessThan(8000);
    expect(text).not.toMatch(/hidden|private.invalid/);
    expect(text).not.toContain("\u001b");
    expect(text).toContain("names omitted");
    expect(environmentChanges(facts, facts)).toEqual([]);
    expect(createRequestSreSystemPrompt()).toContain("report directly");
    expect(createRequestSreSystemPrompt()).not.toMatch(
      /investigation_get|evidence_get|hypothesis_upsert|investigation_conclude/,
    );
  });
});

it("shows the exact requested context on each tool call without relaying sensitive arguments", () => {
  const bridge = createRequestMcpToolBridge(
    scopedPodTool,
    {},
    () => undefined,
    DEFAULT_RESULT_POLICY,
  );
  const render = bridge.renderCall!;
  const text = render({ context: "A", labelSelector: "password=hidden" }, {} as never, {} as never)
    .render(80)
    .join("\n");
  expect(text).toContain('Requested context: "A"');
  expect(text).toContain("READ ONLY");
  expect(text).not.toContain("hidden");
  const unsafe = render({ context: "password=hidden" }, {} as never, {} as never)
    .render(80)
    .join("\n");
  expect(unsafe).toContain("withheld");
  expect(unsafe).not.toContain("hidden");
});

it("retries a failed notification rather than treating it as a published snapshot", () => {
  const f = setup();
  f.selection.select({ kind: "exact", contexts: ["A"] });
  f.sendMessage.mockImplementationOnce(() => {
    throw new Error("publication failed");
  });
  expect(() => f.environment.refresh()).toThrow("publication failed");
  f.environment.refresh();
  expect(f.sendMessage).toHaveBeenCalledTimes(3);
  expect(f.sendMessage.mock.calls.at(-1)![0].content).toContain("Selection changed");
  f.environment.dispose();
});
