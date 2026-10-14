import type { McpToolDescriptor } from "../../src/mcp/tool-discovery.js";

/** Test-owned contract: explicit routing and selectors, without production exposure. */
export const scopedPodTool: McpToolDescriptor = {
  name: "pods_list",
  description: "List pods read-only in the selected context.",
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: "object",
    properties: {
      context: { type: "string", minLength: 1 },
      labelSelector: { type: "string", pattern: "^[a-z=]+$" },
    },
    required: ["context"],
    additionalProperties: false,
  },
};
