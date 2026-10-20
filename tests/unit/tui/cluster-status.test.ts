import { describe, expect, it } from "vitest";

import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import {
  createClusterScopeDescription,
  createClusterStatusLines,
} from "../../../src/runtime/cluster-guidance.js";

describe("operational scope presentation", () => {
  it.each([false, true])(
    "distinguishes default-all singleton and empty registries (empty: %s)",
    (empty) => {
      const manager = new ClusterContextManager();
      manager.acceptRegistry(
        manager.beginConnection(),
        new ClusterContextRegistry(
          empty
            ? []
            : [
                {
                  name: "alpha",
                  server: "https://user:password@example.invalid/?token=secret",
                  isDefault: false,
                },
              ],
        ),
      );
      const lines = createClusterStatusLines(manager.state);
      expect(lines).toContain(empty ? "Cluster: NOT CONFIGURED" : 'Cluster: "alpha" (live *)');
      expect(lines[0]).toBe("READ ONLY");
      const description = createClusterScopeDescription(manager.state);
      expect(description).toContain(
        empty ? "Cluster-dependent calls are blocked" : "selection source: default-all",
      );
      expect(description).toContain("Namespace: *");
      expect(description).not.toMatch(/password|secret|example.invalid/);
    },
  );

  it("keeps live all visible as inventory grows from one context to several", () => {
    const manager = new ClusterContextManager();
    for (const names of [["alpha"], ["alpha", "beta"]]) {
      manager.acceptRegistry(
        manager.beginConnection(),
        new ClusterContextRegistry(
          names.map((name) => ({ name, server: "https://example.invalid", isDefault: false })),
        ),
      );
      expect(manager.state.status).toBe("resolved");
      expect(manager.state.selection.rule).toEqual({ kind: "all" });
      const description = createClusterScopeDescription(manager.state);
      expect(description).toContain("Selection rule: live *");
      expect(description).toContain(`Resolution: ${names.length} available, 0 unavailable`);
      expect(description).toContain("Supply one exact context on every diagnostic call.");
    }
  });

  it("shows missing members when an exact set has one available context", () => {
    const manager = new ClusterContextManager({
      rule: { kind: "exact", contexts: ["alpha", "beta"] },
    });
    for (const names of [["alpha", "beta"], ["alpha"]]) {
      manager.acceptRegistry(
        manager.beginConnection(),
        new ClusterContextRegistry(
          names.map((name) => ({ name, server: "https://example.invalid", isDefault: false })),
        ),
      );
    }
    expect(manager.state.status).toBe("resolved");
    expect(createClusterStatusLines(manager.state)).toContain('Cluster: "alpha"');
    expect(createClusterScopeDescription(manager.state)).toContain(
      "Resolution: 1 available, 1 unavailable",
    );
  });

  it("bounds reconnect notices and omits endpoint metadata", () => {
    const manager = new ClusterContextManager();
    manager.acceptRegistry(manager.beginConnection(), new ClusterContextRegistry([]));
    manager.acceptRegistry(
      manager.beginConnection(),
      new ClusterContextRegistry(
        Array.from({ length: 1024 }, (_, index) => ({
          name: `${index}-${"x".repeat(900)}`,
          server: "https://private.invalid",
          isDefault: false,
        })),
      ),
    );
    const description = createClusterScopeDescription(manager.state);
    expect(description).toContain("added: 1024");
    expect(description).toContain("1023 more");
    expect(description).toContain("Added contexts are not checked");
    expect(description.length).toBeLessThan(3000);
    expect(description).not.toContain("private.invalid");
  });

  it("does not render terminal controls or credential diagnostics", () => {
    const manager = new ClusterContextManager();
    manager.markUnavailable("Failure\u001b[2J\nAuthorization: Bearer supersecret\u202e");
    const description = createClusterScopeDescription(manager.state);
    expect(description).not.toContain("supersecret");
    expect(description).not.toContain("\u001b");
    expect(description).not.toContain("\u202e");
    expect(description).toContain("REDACTED");
  });
});
