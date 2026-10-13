import { describe, expect, it } from "vitest";

import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";

function registry(defaultName?: string) {
  return new ClusterContextRegistry(
    ["alpha", "beta"].map((name) => ({
      name,
      server: "https://example.invalid",
      isDefault: name === defaultName,
    })),
  );
}

function start(manager: ClusterContextManager, defaultName?: string, configuredDefault?: string) {
  manager.acceptRegistry(manager.beginConnection(), registry(defaultName), configuredDefault);
}

describe("application-owned cluster authority", () => {
  it("owns startup intent, immutable scope and session isolation", () => {
    const intent = { cluster: "beta" };
    const manager = new ClusterContextManager(intent);
    const other = new ClusterContextManager();
    intent.cluster = "alpha";
    start(manager, "alpha", "alpha");
    start(other, "alpha");
    expect(manager.captureScope()).toMatchObject({
      context: "beta",
      source: "cli",
      namespace: "*",
      readOnly: true,
      connectionGeneration: 1,
      registryRevision: 1,
    });
    expect(other.captureScope()?.context).toBe("alpha");
    expect(Object.isFrozen(manager.state)).toBe(true);
    expect(Object.isFrozen(manager.captureScope())).toBe(true);
  });

  it("publishes distinct states and disposes subscriptions", () => {
    const manager = new ClusterContextManager({ cluster: "absent" });
    const states: string[] = [];
    const unsubscribe = manager.subscribe((state) => states.push(state.status));
    start(manager, "alpha");
    expect(manager.state).toMatchObject({
      status: "selection-error",
      source: "cli",
      requestedName: "absent",
    });
    expect(manager.captureScope()).toBeUndefined();
    manager.select("beta");
    const scope = manager.captureScope();
    manager.beginConnection();
    expect(scope && manager.isCurrent(scope)).toBe(false);
    manager.markUnavailable("Disconnected");
    expect(states).toEqual([
      "unavailable",
      "connecting",
      "selection-error",
      "bound",
      "connecting",
      "unavailable",
    ]);
    unsubscribe();
    manager.dispose();
    expect(states).toHaveLength(6);
  });

  it("guards active work and validates selections without losing valid scope", () => {
    const manager = new ClusterContextManager();
    start(manager, "alpha");
    const state = manager.state;
    expect(() => manager.select("missing")).toThrow("Unknown");
    manager.select("alpha");
    expect(manager.state).toBe(state);
    const release = manager.beginAgentWork();
    const releaseOther = manager.beginAgentWork();
    expect(() => manager.select("beta")).toThrow("active agent");
    release();
    release();
    expect(manager.isAgentActive).toBe(true);
    releaseOther();
    expect(manager.isAgentActive).toBe(false);
    manager.select("beta");
    expect(manager.captureScope()?.source).toBe("user");
    const selectedState = manager.state;
    expect(() => manager.select("alpha", state.registryRevision)).toThrow(
      "Cluster context state changed during selection. Retry /cluster.",
    );
    expect(manager.state).toBe(selectedState);
    manager.beginConnection();
    const connectingState = manager.state;
    expect(() => manager.select("alpha")).toThrow(
      "A current MCP context registry is required. Use /mcp_restart and retry /cluster.",
    );
    expect(manager.state).toBe(connectingState);
  });

  it("ignores stale enumeration and retains exact selection through replacement", () => {
    const manager = new ClusterContextManager();
    start(manager, "alpha");
    manager.select("beta");
    const old = manager.captureScope();
    const stale = manager.beginConnection();
    const generation = manager.beginConnection();
    manager.acceptRegistry(stale, registry("alpha"));
    expect(manager.state.status).toBe("connecting");
    manager.acceptRegistry(generation, registry("alpha"), "alpha");
    expect(manager.captureScope()).toMatchObject({
      context: "beta",
      source: "user",
      connectionGeneration: generation,
    });
    expect(old && manager.isCurrent(old)).toBe(false);
    manager.acceptRegistry(manager.beginConnection(), new ClusterContextRegistry([]));
    expect(manager.state.status).toBe("selection-error");
  });

  it("resolves pending startup after failure, but never applies new defaults to resolved unbound scope", () => {
    const manager = new ClusterContextManager();
    const generation = manager.beginConnection();
    manager.failEnumeration(generation, "invalid-response", "Invalid inventory");
    expect(manager.state.status).toBe("enumeration-failed");
    start(manager, "alpha", "beta");
    expect(manager.captureScope()).toMatchObject({ context: "beta", source: "config" });
    const unbound = new ClusterContextManager();
    start(unbound);
    expect(unbound.state.status).toBe("unbound");
    start(unbound, "alpha", "beta");
    expect(unbound.state.status).toBe("unbound");
    unbound.acceptRegistry(unbound.beginConnection(), new ClusterContextRegistry([]));
    expect(unbound.state.status).toBe("not-configured");
  });
});
