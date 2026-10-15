import { describe, expect, it } from "vitest";

import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import {
  createClusterScopeDescription,
  createClusterStatusLines,
} from "../../../src/runtime/cluster-guidance.js";

describe("operational scope presentation", () => {
  it.each([false, true])("distinguishes unbound and empty registries (empty: %s)", (empty) => {
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
    expect(lines).toContain(empty ? "Cluster: NOT CONFIGURED" : "Cluster: NOT SELECTED");
    expect(lines[0]).toBe("READ ONLY");
    const description = createClusterScopeDescription(manager.state);
    expect(description).toContain("Cluster-dependent calls are blocked");
    expect(description).toContain("Namespace: *");
    expect(description).not.toMatch(/password|secret|example.invalid/);
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
