import type { Tool } from "@earendil-works/pi-mcp";
import { prepareMcpToolSchema, McpToolSchemaError } from "../runtime/tool-policy.js";
import type { McpConnection } from "./connection.js";

export type McpToolDescriptor = Readonly<
  Pick<Tool, "name" | "description" | "inputSchema" | "annotations" | "outputSchema">
>;

export type ToolDiscoveryDecision =
  | { readonly name: string; readonly status: "exposed" }
  | {
      readonly name?: string;
      readonly status: "rejected";
      readonly reason:
        "incompatible-schema" | "invalid-descriptor" | "duplicate-name" | "not-allowlisted";
    };

export interface ToolDiscoveryReport {
  readonly exposed: readonly McpToolDescriptor[];
  readonly decisions: readonly ToolDiscoveryDecision[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDescriptor(value: Tool): McpToolDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.name))
    return undefined;
  if (value.description !== undefined && typeof value.description !== "string") return undefined;
  // Read only the descriptor fields used by Pi SRE.
  if (!isRecord(value.inputSchema)) return undefined;
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    inputSchema: value.inputSchema,
    ...(value.annotations === undefined ? {} : { annotations: value.annotations }),
    ...(value.outputSchema === undefined ? {} : { outputSchema: value.outputSchema }),
  };
}

/** The MCP client handles protocol/pagination; Pi SRE selects supported capabilities. */
export async function discoverMcpTools(
  connection: Pick<McpConnection, "listTools">,
  signal?: AbortSignal,
): Promise<ToolDiscoveryReport> {
  const rawTools = await connection.listTools(signal);
  const parsed = rawTools.map(parseDescriptor);
  const nameCounts = new Map<string, number>();
  for (const raw of rawTools) {
    if (isRecord(raw) && typeof raw.name === "string") {
      nameCounts.set(raw.name, (nameCounts.get(raw.name) ?? 0) + 1);
    }
  }

  const entries = parsed.map((tool, index) => ({ tool, index }));
  entries.sort((a, b) => {
    const first = a.tool?.name ?? "";
    const second = b.tool?.name ?? "";
    return (first < second ? -1 : first > second ? 1 : 0) || a.index - b.index;
  });
  const exposed: McpToolDescriptor[] = [];
  const decisions: ToolDiscoveryDecision[] = [];
  for (const { tool } of entries) {
    if (!tool) {
      decisions.push({ status: "rejected", reason: "invalid-descriptor" });
      continue;
    }
    if ((nameCounts.get(tool.name) ?? 0) > 1) {
      decisions.push({ name: tool.name, status: "rejected", reason: "duplicate-name" });
      continue;
    }
    try {
      prepareMcpToolSchema(tool);
      decisions.push({ name: tool.name, status: "exposed" });
      exposed.push(tool);
    } catch (error) {
      if (!(error instanceof McpToolSchemaError)) throw error;
      decisions.push({
        name: tool.name,
        status: "rejected",
        reason: error.reason,
      });
    }
  }
  return { exposed, decisions };
}
