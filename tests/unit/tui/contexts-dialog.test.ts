import { describe, expect, it, vi } from "vitest";

import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { showContextsDialog } from "../../../src/tui/contexts-dialog.js";

function install(manager: ClusterContextManager, names: readonly string[]): void {
  manager.acceptRegistry(
    manager.beginConnection(),
    new ClusterContextRegistry(
      names.map((name) => ({
        name,
        server: "https://private.invalid",
        isDefault: false,
      })),
    ),
  );
}

describe("read-only scope status inspection", () => {
  it("paginates every exact identity in groups of 20 without mutation, including action-like names", async () => {
    const manager = new ClusterContextManager();
    const names = [
      ...Array.from({ length: 40 }, (_, index) => `context-${index.toString().padStart(2, "0")}`),
      "Next page",
      " spaced ",
    ];
    install(manager, names);
    const state = manager.state;
    const release = manager.beginAgentWork();
    const pages: string[][] = [];
    const select = vi.fn(async (_title: string, options: string[]) => {
      pages.push(options.filter((row) => /^\d+\./u.test(row)));
      return options.includes("Next page") ? "Next page" : "Close status";
    });
    try {
      await showContextsDialog({ select, notify: vi.fn() }, state, () => true);
    } finally {
      release();
    }
    expect(pages.map((page) => page.length)).toEqual([20, 20, 2]);
    const rendered = pages.flat().join("\n");
    for (const name of names) expect(rendered).toContain(JSON.stringify(name));
    expect(rendered).toContain("permitted, available; health not checked");
    expect(rendered).not.toContain("private.invalid");
    expect(manager.state).toBe(state);
  });

  it("distinguishes partial exact permission, outside inventory, and retained outage inventory", async () => {
    const manager = new ClusterContextManager({
      rule: { kind: "exact", contexts: ["alpha", "beta"] },
    });
    install(manager, ["alpha", "beta"]);
    install(manager, ["alpha", "gamma"]);
    const select = vi.fn().mockResolvedValue(undefined);
    await showContextsDialog({ select, notify: vi.fn() }, manager.state, () => true);
    expect(select.mock.calls[0]?.[1]).toEqual([
      '1. "alpha" — permitted, available; health not checked',
      '2. "beta" — selected, unavailable',
      '3. "gamma" — outside exact selection',
      "Close status",
    ]);
    manager.markUnavailable("Connection lost");
    await showContextsDialog({ select, notify: vi.fn() }, manager.state, () => true);
    expect(select.mock.calls[1]?.[1]).toEqual([
      '1. "alpha" — in selection; dispatch blocked; last successful inventory',
      '2. "beta" — in selection; dispatch blocked',
      '3. "gamma" — outside exact selection; last successful inventory',
      "Close status",
    ]);
  });

  it("shows an entire long name on inspection, supports backwards navigation, and closes on Escape", async () => {
    const manager = new ClusterContextManager();
    const name = "x".repeat(1024);
    install(manager, [...Array.from({ length: 20 }, (_, i) => `a-${i}`), name]);
    const notify = vi.fn();
    const select = vi
      .fn()
      .mockResolvedValueOnce("Next page")
      .mockImplementationOnce(async (_title: string, options: string[]) => options[0])
      .mockResolvedValueOnce("Previous page")
      .mockResolvedValueOnce(undefined);
    await showContextsDialog({ select, notify }, manager.state, () => true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(name)), "info");
    expect(select.mock.calls[3]?.[0]).toContain("page 1/2");
  });

  it("closes a stale view after refresh or lifecycle change without changing selection", async () => {
    const manager = new ClusterContextManager();
    install(manager, ["alpha"]);
    const state = manager.state;
    const choice = Promise.withResolvers<string | undefined>();
    const select = vi.fn(() => choice.promise);
    const notify = vi.fn();
    const pending = showContextsDialog({ select, notify }, state, () => state === manager.state);
    install(manager, ["beta"]);
    choice.resolve("Next page");
    await pending;
    expect(select).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("scope changed"), "info");
    expect(manager.state.selection).toBe(state.selection);
  });
});
