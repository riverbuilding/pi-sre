import { describe, expect, it } from "vitest";

import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { resolveStartupContext } from "../../../src/cluster/context-resolver.js";

function registry(names: readonly string[], defaultName?: string): ClusterContextRegistry {
  return new ClusterContextRegistry(
    names.map((name) => ({
      name,
      server: "https://example.invalid",
      isDefault: name === defaultName,
    })),
  );
}

describe("startup context resolution", () => {
  it.each([
    { cluster: "alpha", config: "beta", status: "bound", name: "alpha", source: "cli" },
    { cluster: "alpha", config: "missing", status: "bound", name: "alpha", source: "cli" },
    {
      cluster: "missing",
      config: "beta",
      status: "selection-error",
      name: "missing",
      source: "cli",
    },
    { cluster: undefined, config: "beta", status: "bound", name: "beta", source: "config" },
    {
      cluster: undefined,
      config: "missing",
      status: "selection-error",
      name: "missing",
      source: "config",
    },
    {
      cluster: undefined,
      config: undefined,
      status: "bound",
      name: "gamma",
      source: "mcp-default",
    },
  ])("resolves $source request $name as $status", ({ cluster, config, status, name, source }) => {
    const result = resolveStartupContext(
      registry(["alpha", "beta", "gamma"], "gamma"),
      cluster === undefined ? {} : { cluster },
      config,
    );
    expect(result).toMatchObject({ status, source, requestedName: name });
    if (result.status === "bound") expect(result.context.name).toBe(name);
    if (result.status === "selection-error") expect(result.message).toContain("/cluster");
  });

  it.each([["alpha"], ["alpha", "beta"], []])(
    "does not infer a default from inventory %j",
    (...names) => {
      expect(resolveStartupContext(registry(names))).toEqual({
        status: "unbound",
        reason: names.length === 0 ? "not-configured" : "not-selected",
      });
    },
  );

  it("retains unknown selection intent even with an empty inventory", () => {
    expect(resolveStartupContext(registry([]), { cluster: "alpha" }, "beta")).toMatchObject({
      status: "selection-error",
      source: "cli",
      requestedName: "alpha",
    });
  });

  it("uses exact identifiers rather than trimming, case folding or endpoint matching", () => {
    const contexts = registry(["alpha", " alpha ", "beta"], "alpha");
    expect(resolveStartupContext(contexts, { cluster: " alpha " })).toMatchObject({
      status: "bound",
      requestedName: " alpha ",
      context: { name: " alpha " },
    });
    expect(resolveStartupContext(contexts, { cluster: "Alpha" })).toMatchObject({
      status: "selection-error",
      requestedName: "Alpha",
    });
  });
});
