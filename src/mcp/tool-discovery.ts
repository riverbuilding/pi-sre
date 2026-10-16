import { validateMcpToolContract, McpToolContractError } from "../runtime/tool-policy.js";
import type { McpConnection } from "./connection.js";

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<{
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  }>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export type ToolDiscoveryDecision =
  | { readonly name: string; readonly status: "exposed" }
  | {
      readonly name?: string;
      readonly status: "rejected";
      readonly contractPath?: string;
      readonly reason:
        | "incompatible-schema"
        | "invalid-descriptor"
        | "duplicate-name"
        | "not-allowlisted"
        | "not-read-only"
        | "destructive";
    };

export interface ToolDiscoveryReport {
  readonly exposed: readonly McpToolDescriptor[];
  readonly decisions: readonly ToolDiscoveryDecision[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validAnnotations(value: unknown): value is McpToolDescriptor["annotations"] {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  return ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every(
    (key) => value[key] === undefined || typeof value[key] === "boolean",
  );
}

function parseDescriptor(value: unknown): McpToolDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.name))
    return undefined;
  if (value.description !== undefined && typeof value.description !== "string") return undefined;
  // Envelope shape only: all input fields and constraints are checked by McpToolContract.
  if (!isRecord(value.inputSchema)) return undefined;
  if (!validAnnotations(value.annotations)) return undefined;
  // Schema compatibility belongs to the reviewed contract, just as for inputs.
  if (value.outputSchema !== undefined && !isRecord(value.outputSchema)) return undefined;
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    inputSchema: value.inputSchema,
    ...(value.annotations === undefined ? {} : { annotations: value.annotations }),
    ...(value.outputSchema === undefined ? {} : { outputSchema: value.outputSchema }),
  };
}

/** The MCP client handles pagination; this boundary validates its untrusted descriptors. */
export async function discoverMcpTools(
  connection: Pick<McpConnection, "listTools">,
  signal?: AbortSignal,
): Promise<ToolDiscoveryReport> {
  const rawTools: readonly unknown[] = await connection.listTools(signal);
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
      validateMcpToolContract(tool);
      decisions.push({ name: tool.name, status: "exposed" });
      exposed.push(tool);
    } catch (error) {
      if (!(error instanceof McpToolContractError)) throw error;
      decisions.push({
        name: tool.name,
        status: "rejected",
        reason: error.reason,
        ...(error.reason === "incompatible-schema" ? { contractPath: error.path } : {}),
      });
    }
  }
  return { exposed, decisions };
}
