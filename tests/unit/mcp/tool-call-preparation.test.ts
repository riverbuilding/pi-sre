import { describe, expect, it } from "vitest";
import { prepareMcpToolArguments } from "../../../src/runtime/tool-call-preparation.js";
import { allowsMcpToolExecution } from "../../../src/runtime/tool-execution-policy.js";

const logs = { name: "pods_log", clusterDependent: true };

describe("MCP call preparation and execution policy", () => {
  it("copies arguments, removes model context, and adds the application log default", () => {
    const args = { name: "api", context: "alpha" };
    const prepared = prepareMcpToolArguments(logs, args);
    expect(prepared).toEqual({ name: "api", tail: 100 });
    expect(args).toEqual({ name: "api", context: "alpha" });
    expect(prepareMcpToolArguments(logs, prepared)).toEqual(prepared);
    expect(allowsMcpToolExecution("pods_log", prepared ?? {})).toBe(true);
  });

  it("preserves explicit values and leaves execution limits to policy", () => {
    for (const tail of [0, 1001, null, "100"]) {
      const prepared = prepareMcpToolArguments(logs, { name: "api", tail });
      expect(prepared).toEqual({ name: "api", tail });
      expect(allowsMcpToolExecution("pods_log", prepared ?? {})).toBe(false);
    }
  });

  it("does not apply log defaults to other tools", () => {
    expect(prepareMcpToolArguments({ name: "pods_list", clusterDependent: true }, {})).toEqual({});
    expect(
      prepareMcpToolArguments({ name: "configuration_contexts_list", clusterDependent: false }, {}),
    ).toEqual({});
  });

  it.each([null, [], "api", 42])("rejects non-object arguments %j", (value) => {
    expect(prepareMcpToolArguments(logs, value)).toBeUndefined();
  });
});
