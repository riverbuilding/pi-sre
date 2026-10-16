import type { McpToolDescriptor } from "../../src/mcp/tool-discovery.js";
import captured from "./phase2-server-0.0.67.json" with { type: "json" };

const podTool = captured.cases["multiple-default"].descriptors.find(
  (tool) => tool.name === "pods_list",
);
if (!podTool) throw new Error("Missing captured pods_list descriptor");

/** Independent server capture, also usable by the lightweight stdio fixture process. */
export const scopedPodTool: McpToolDescriptor = {
  name: podTool.name,
  description: podTool.description,
  annotations: podTool.annotations,
  inputSchema: { ...podTool.inputSchema, type: "object" },
};
