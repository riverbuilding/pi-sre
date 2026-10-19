import { describe, expect, it } from "vitest";
import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { createExactClusterRule } from "../../../src/cluster/context-resolver.js";

function registry(names: readonly string[] = ["alpha", "beta"], defaultName?: string) {
  return new ClusterContextRegistry(
    names.map((name) => ({
      name,
      server: "https://shared.example.invalid",
      isDefault: name === defaultName,
    })),
  );
}
function start(manager: ClusterContextManager, names?: readonly string[], defaultName?: string) {
  manager.acceptRegistry(manager.beginConnection(), registry(names, defaultName));
}

describe("session rule authority", () => {
  it("owns immutable startup intent before connection and isolates sessions", () => {
    const contexts: [string, ...string[]] = ["beta", "alpha"];
    const manager = new ClusterContextManager(
      { rule: { kind: "exact", contexts } },
      createExactClusterRule(["missing"]),
    );
    const other = new ClusterContextManager();
    contexts[0] = "changed";
    expect(manager.state.selection).toEqual({
      rule: { kind: "exact", contexts: ["alpha", "beta"] },
      source: "cli",
      selectionRevision: 1,
    });
    expect(manager.state.resolution).toEqual({
      status: "blocked",
      reason: "inventory-unavailable",
    });
    start(manager);
    start(other, ["alpha", "beta"], "alpha");
    manager.select("beta");
    expect(other.state.selection.rule).toEqual({ kind: "all" });
    expect(Object.isFrozen(manager.state)).toBe(true);
    expect(Object.isFrozen(manager.state.selection)).toBe(true);
    expect(Object.isFrozen(manager.state.resolution)).toBe(true);
    if (other.state.resolution.status === "resolved")
      expect(Object.isFrozen(other.state.resolution.available)).toBe(true);
    expect(Object.isFrozen(manager.captureScope())).toBe(true);
  });

  it("keeps selection, inventory and generation revisions independent", () => {
    const manager = new ClusterContextManager({ rule: createExactClusterRule(["alpha"]) });
    expect(manager.state).toMatchObject({ inventoryRevision: 0, connectionGeneration: 0 });
    start(manager);
    const old = manager.captureScope();
    expect(old).toMatchObject({
      selectionRevision: 1,
      inventoryRevision: 1,
      connectionGeneration: 1,
    });
    manager.select("alpha");
    expect(manager.captureScope()).toBe(old);
    manager.selectRule(createExactClusterRule(["beta", "alpha"]));
    expect(manager.state).toMatchObject({
      selection: { selectionRevision: 2, source: "user" },
      inventoryRevision: 1,
      connectionGeneration: 1,
    });
    const state = manager.state;
    manager.selectRule(createExactClusterRule(["alpha", "beta"]));
    expect(manager.state).toBe(state);
    start(manager);
    expect(manager.state).toMatchObject({
      selection: { selectionRevision: 2 },
      inventoryRevision: 2,
      connectionGeneration: 2,
    });
    expect(old && manager.isCurrent(old)).toBe(false);
  });

  it("retains invalid initial exact rule until it validates completely, then permits partial availability", () => {
    const manager = new ClusterContextManager({ rule: createExactClusterRule(["alpha", "beta"]) });
    start(manager, ["alpha", "gamma"]);
    expect(manager.state.resolution).toEqual({ status: "blocked", reason: "invalid-selection" });
    expect(manager.captureScope()).toBeUndefined();
    start(manager);
    expect(manager.state.resolution).toMatchObject({
      status: "resolved",
      available: [{ name: "alpha" }, { name: "beta" }],
      unavailable: [],
    });
    start(manager, ["alpha", "gamma"]);
    expect(manager.state.resolution).toMatchObject({
      status: "resolved",
      available: [{ name: "alpha" }],
      unavailable: ["beta"],
    });
    expect(manager.state.selection.selectionRevision).toBe(1);
    const partial = manager.state;
    manager.selectRule(createExactClusterRule(["beta", "alpha"]));
    expect(manager.state).toBe(partial);
    start(manager, []);
    expect(manager.state.resolution).toEqual({
      status: "resolved",
      available: [],
      unavailable: ["alpha", "beta"],
    });
    start(manager);
    expect(manager.state.resolution).toMatchObject({ status: "resolved", unavailable: [] });
  });

  it("follows successful inventory with all, including empty, without accumulating removals", () => {
    const manager = new ClusterContextManager();
    start(manager);
    start(manager, ["alpha", "gamma"]);
    expect(manager.state.resolution).toMatchObject({
      status: "resolved",
      available: [{ name: "alpha" }, { name: "gamma" }],
      unavailable: [],
    });
    start(manager, []);
    expect(manager.state.resolution).toEqual({
      status: "resolved",
      available: [],
      unavailable: [],
    });
    expect(manager.state.selection).toMatchObject({ rule: { kind: "all" }, selectionRevision: 1 });
  });

  it("captures config before initial failure and ignores recovery defaults", () => {
    const manager = new ClusterContextManager({}, createExactClusterRule(["beta"]));
    const generation = manager.beginConnection();
    manager.failEnumeration(generation, "invalid-response", "Invalid inventory");
    expect(manager.state).toMatchObject({
      inventoryRevision: 0,
      selection: { source: "config", rule: { kind: "exact", contexts: ["beta"] } },
    });
    start(manager, ["alpha", "beta"], "alpha");
    expect(manager.captureScope()).toMatchObject({ context: "beta", source: "config" });
    const inventory = manager.state.inventory;
    manager.markUnavailable("Disconnected");
    expect(manager.state.inventory).toBe(inventory);
    expect(manager.state.resolution).toEqual({
      status: "blocked",
      reason: "inventory-unavailable",
    });
    expect(manager.state.inventoryRevision).toBe(1);
    const retry = manager.beginConnection();
    manager.failEnumeration(retry, "tool-error", "Failed");
    expect(manager.state.inventory).toBe(inventory);
    expect(manager.state.inventoryRevision).toBe(1);
    start(manager, ["alpha", "beta"], "alpha");
    expect(manager.state.selection.selectionRevision).toBe(1);
  });

  it("privately captures configured sets before failure and preserves them through recovery", () => {
    const contexts: [string, ...string[]] = ["beta", "alpha"];
    const manager = new ClusterContextManager({}, { kind: "exact", contexts });
    contexts[0] = "changed";
    manager.markUnavailable("Startup failed");
    start(manager);
    expect(manager.state.selection).toMatchObject({
      source: "config",
      rule: { kind: "exact", contexts: ["alpha", "beta"] },
    });
    expect(manager.state.resolution).toMatchObject({
      status: "resolved",
      available: [{ name: "alpha" }, { name: "beta" }],
    });
    const all = new ClusterContextManager({}, { kind: "all" });
    start(all);
    start(all, ["alpha", "gamma"]);
    expect(all.state.selection).toMatchObject({
      source: "config",
      rule: { kind: "all" },
      selectionRevision: 1,
    });
    expect(all.state.resolution).toMatchObject({
      available: [{ name: "alpha" }, { name: "gamma" }],
    });
  });

  it("atomically refuses invalid replacements, stale revisions and active work", () => {
    const manager = new ClusterContextManager();
    start(manager);
    const initial = manager.state;
    expect(() => manager.selectRule(createExactClusterRule(["alpha", "missing"]))).toThrow(
      "Unknown",
    );
    expect(manager.state).toBe(initial);
    const workEpoch = manager.workEpoch;
    const release = manager.beginAgentWork();
    expect(manager.workEpoch).toBe(workEpoch + 1);
    const releaseOther = manager.beginAgentWork();
    expect(() => manager.select("alpha")).toThrow("active agent");
    release();
    release();
    expect(manager.isAgentActive).toBe(true);
    releaseOther();
    expect(manager.workEpoch).toBe(workEpoch + 2);
    manager.select("beta");
    expect(() =>
      manager.select("alpha", initial.inventoryRevision, initial.selection.selectionRevision),
    ).toThrow("state changed");
    const selected = manager.state;
    start(manager);
    expect(() => manager.select("alpha", selected.inventoryRevision)).toThrow("state changed");
    manager.beginConnection();
    expect(() => manager.select("alpha")).toThrow("current MCP context registry");
    manager.acceptRegistry(manager.state.connectionGeneration, registry([]));
    expect(() => manager.selectRule({ kind: "all" })).toThrow("current MCP context registry");
  });

  it("ignores stale/duplicate discovery and disposes listeners and work", () => {
    const manager = new ClusterContextManager();
    const states: string[] = [];
    const unsubscribe = manager.subscribe((state) => states.push(state.status));
    const stale = manager.beginConnection();
    const generation = manager.beginConnection();
    manager.acceptRegistry(stale, registry());
    manager.failEnumeration(stale, "tool-error", "stale");
    expect(manager.state.status).toBe("connecting");
    manager.acceptRegistry(generation, registry());
    manager.acceptRegistry(generation, registry([]));
    expect(manager.state.inventoryRevision).toBe(1);
    unsubscribe();
    manager.beginAgentWork();
    manager.dispose();
    expect(manager.isAgentActive).toBe(false);
    expect(states).toEqual(["unavailable", "connecting", "connecting", "resolved"]);
    expect(manager.captureScope()).toBeUndefined();
  });
});
