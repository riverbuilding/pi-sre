import { describe, expect, it } from "vitest";

import { isSupportedInputSchema, isSupportedOutputSchema } from "../../../src/mcp/tool-schema.js";

describe("MCP schema documents", () => {
  it("accepts an empty input contract and a structured output contract", () => {
    expect(
      isSupportedInputSchema({ type: "object", properties: {}, additionalProperties: false }),
    ).toBe(true);
    expect(
      isSupportedOutputSchema({
        type: "object",
        properties: { contexts: { type: "array", items: { type: "string" } } },
        required: ["contexts"],
        additionalProperties: false,
      }),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    { namespace: "default" },
    { type: "string" },
    { type: "array", items: { type: "string" } },
    { type: "object", properties: {}, required: ["missing"] },
  ])("requires a supported object document for both input and output", (document) => {
    expect(isSupportedInputSchema(document)).toBe(false);
    expect(isSupportedOutputSchema(document)).toBe(false);
  });
});
