import captured from "./phase2-server-0.0.67.json" with { type: "json" };
import type { McpToolDescriptor } from "../../src/mcp/tool-discovery.js";

/** Real, sanitized descriptors frozen by the Slice 0 probe. */
export const diagnosticTools: readonly McpToolDescriptor[] = captured.cases[
  "multiple-default"
].descriptors.map((tool) => {
  if (tool.inputSchema.type !== "object") throw new Error("Invalid captured schema");
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
});
