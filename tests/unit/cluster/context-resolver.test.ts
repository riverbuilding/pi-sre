import { describe, expect, it } from "vitest";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import {
  createExactClusterRule,
  parseClusterRule,
  resolveStartupContext,
  resolveClusterSelection,
} from "../../../src/cluster/context-resolver.js";

function registry(names: readonly string[], defaultName?: string): ClusterContextRegistry {
  return new ClusterContextRegistry(
    names.map((name) => ({
      name,
      server: "https://shared.example.invalid",
      isDefault: name === defaultName,
    })),
  );
}

describe("startup rule resolution", () => {
  it.each([undefined, "alpha"])("defaults to live all despite MCP default %s", (defaultName) => {
    const result = resolveStartupContext(registry(["alpha", "beta"], defaultName));
    expect(result.selection).toEqual({
      rule: { kind: "all" },
      source: "default-all",
      selectionRevision: 1,
    });
    expect(result.resolution).toMatchObject({
      status: "resolved",
      available: [{ name: "alpha" }, { name: "beta" }],
      unavailable: [],
    });
  });

  it.each([["alpha"], []])("resolves default all over %j", (...names) => {
    expect(resolveStartupContext(registry(names)).resolution).toMatchObject({
      status: "resolved",
      available: names.map((name) => ({ name })),
      unavailable: [],
    });
  });

  it("gives explicit CLI sets/all precedence over config, even invalid config", () => {
    for (const rule of [createExactClusterRule(["beta", "alpha"]), { kind: "all" as const }]) {
      expect(
        resolveStartupContext(
          registry(["alpha", "beta"]),
          { rule },
          createExactClusterRule(["missing"]),
        ).selection,
      ).toMatchObject({ rule, source: "cli" });
    }
    expect(
      resolveStartupContext(
        registry(["alpha", "beta"], "alpha"),
        {},
        createExactClusterRule(["beta"]),
      ),
    ).toMatchObject({
      selection: { rule: { kind: "exact", contexts: ["beta"] }, source: "config" },
      resolution: { status: "resolved", available: [{ name: "beta" }] },
    });
  });

  it.each([["beta", "alpha"], ["*"]])("supports configured set/all rule %j", (...names) => {
    const rule = parseClusterRule(names);
    const result = resolveStartupContext(registry(["alpha", "beta"], "alpha"), {}, rule);
    expect(result.selection).toMatchObject({ rule, source: "config" });
    expect(result.resolution).toMatchObject({
      status: "resolved",
      available: [{ name: "alpha" }, { name: "beta" }],
    });
    expect(
      resolveStartupContext(
        registry(["alpha", "beta"]),
        { rule: createExactClusterRule(["alpha"]) },
        rule,
      ).selection,
    ).toMatchObject({ source: "cli", rule: { kind: "exact", contexts: ["alpha"] } });
  });

  it("rejects initial exact sets atomically without fallback, retaining pending rule", () => {
    const rule = createExactClusterRule(["alpha", "missing"]);
    for (const names of [["alpha", "beta"], []]) {
      expect(
        resolveStartupContext(
          registry(names, names[0]),
          { rule },
          createExactClusterRule(["beta"]),
        ),
      ).toMatchObject({
        selection: { rule, source: "cli" },
        resolution: { status: "blocked", reason: "invalid-selection" },
      });
    }
    expect(
      resolveStartupContext(registry(["alpha"], "alpha"), {}, createExactClusterRule(["missing"]))
        .resolution.status,
    ).toBe("blocked");
  });

  it("preserves identities, literal wildcard and pattern-like names", () => {
    const names = ["alpha", " alpha ", "*", "prod-*", "Alpha"];
    expect(resolveClusterSelection(registry(names), createExactClusterRule(names))).toMatchObject({
      status: "resolved",
      available: [...names].sort().map((name) => ({ name })),
      unavailable: [],
    });
    expect(
      resolveStartupContext(registry(["*"]), {}, parseClusterRule(["*"])).selection.rule,
    ).toEqual({
      kind: "all",
    });
  });

  it("canonicalizes and freezes private exact sets; rejects duplicates and invalid bounds", () => {
    const names = ["beta", "alpha"];
    const rule = createExactClusterRule(names);
    names[0] = "changed";
    expect(rule).toEqual({ kind: "exact", contexts: ["alpha", "beta"] });
    expect(Object.isFrozen(rule)).toBe(true);
    if (rule.kind === "exact") expect(Object.isFrozen(rule.contexts)).toBe(true);
    for (const invalid of [
      [],
      ["a", "a"],
      [" "],
      ["x\n"],
      ["é".repeat(513)],
      Array.from({ length: 1025 }, (_, i) => `${i}`),
    ]) {
      expect(() => createExactClusterRule(invalid)).toThrow();
    }
    expect(() =>
      createExactClusterRule(Array.from({ length: 1024 }, (_, i) => `${i}`)),
    ).not.toThrow();
  });
});
