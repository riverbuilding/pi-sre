import { Buffer } from "node:buffer";

import { z } from "zod";

import { ClusterContextRegistry } from "../cluster/context-registry.js";
import type { McpConnection } from "./connection.js";
import { classifyToolFailure, type ToolFailureCategory } from "./result-normalizer.js";
import type { ToolDiscoveryReport } from "./tool-discovery.js";
import {
  CONFIGURATION_CONTEXTS_LIST_CONTRACT,
  validateMcpToolContract,
  McpToolContractError,
} from "../runtime/tool-policy.js";

export const CONTEXT_ENUMERATION_LIMITS = Object.freeze({
  resultBytes: 1_048_576,
  entries: 1_024,
  nameBytes: 1_024,
  serverBytes: 4_096,
});

export type ContextDiscoveryFailure = "incompatible-tool" | "invalid-response" | "tool-error";

export class ContextDiscoveryError extends Error {
  constructor(
    readonly kind: ContextDiscoveryFailure,
    readonly failureCategory?: ToolFailureCategory,
    options?: ErrorOptions,
  ) {
    super(
      kind === "incompatible-tool"
        ? "Kubernetes MCP context enumeration requires a compatible read-only configuration_contexts_list tool."
        : kind === "invalid-response"
          ? "Kubernetes MCP context enumeration returned an invalid or oversized inventory."
          : `Kubernetes MCP context enumeration failed (${failureCategory ?? "tool-execution-failed"}).`,
      options,
    );
    this.name = "ContextDiscoveryError";
  }
}

const TOOL_NAME = "configuration_contexts_list";
const EMPTY_TEXT = "No contexts found in kubeconfig";
// Names are opaque identifiers: reject terminal controls rather than rewrite identity.
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Enumeration supports the captured text blocks; other presentation formats confer no authority.
const envelope = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

function safeServer(value: string): string {
  try {
    const url = new URL(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "[endpoint withheld]";
    // Retain only origin: userinfo, paths, queries and fragments may contain credentials.
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[endpoint withheld]";
  }
}

/** Validate the complete raw result, independent of model presentation budgets. */
export function parseContextRegistry(raw: unknown): ClusterContextRegistry {
  try {
    const serialized = JSON.stringify(raw);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > CONTEXT_ENUMERATION_LIMITS.resultBytes
    ) {
      throw new ContextDiscoveryError("invalid-response");
    }
  } catch (error) {
    if (error instanceof ContextDiscoveryError) throw error;
    throw new ContextDiscoveryError("invalid-response");
  }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success || typeof raw !== "object" || raw === null)
    throw new ContextDiscoveryError("invalid-response");
  const result = parsed.data;
  if (result.isError) {
    throw new ContextDiscoveryError(
      "tool-error",
      classifyToolFailure(result.content.map((block) => block.text).join("\n")),
    );
  }
  if (!Object.hasOwn(raw, "structuredContent")) {
    if (result.content.length === 1 && result.content[0]?.text === EMPTY_TEXT) {
      return new ClusterContextRegistry([]);
    }
    throw new ContextDiscoveryError("invalid-response");
  }
  const structured = result.structuredContent;
  if (!CONFIGURATION_CONTEXTS_LIST_CONTRACT.validateOutput(structured))
    throw new ContextDiscoveryError("invalid-response");
  const { contexts, defaultContext } = structured;
  if (
    contexts.length > CONTEXT_ENUMERATION_LIMITS.entries ||
    (defaultContext !== undefined &&
      (Buffer.byteLength(defaultContext, "utf8") > CONTEXT_ENUMERATION_LIMITS.nameBytes ||
        controls.test(defaultContext))) ||
    contexts.some(
      (context) =>
        Buffer.byteLength(context.name, "utf8") > CONTEXT_ENUMERATION_LIMITS.nameBytes ||
        controls.test(context.name) ||
        Buffer.byteLength(context.server, "utf8") > CONTEXT_ENUMERATION_LIMITS.serverBytes,
    )
  ) {
    throw new ContextDiscoveryError("invalid-response");
  }
  const names = new Set(contexts.map((context) => context.name));
  const defaults = contexts.filter((context) => context.default);
  if (
    names.size !== contexts.length ||
    (defaultContext
      ? defaults.length !== 1 || defaults[0]?.name !== defaultContext
      : defaults.length !== 0)
  ) {
    throw new ContextDiscoveryError("invalid-response");
  }
  return new ClusterContextRegistry(
    contexts.map((context) => ({
      name: context.name,
      server: safeServer(context.server),
      isDefault: context.default,
    })),
  );
}

/** Use the existing descriptor discovery and managed connection; never start another client. */
export async function discoverClusterContexts(
  connection: Pick<McpConnection, "callTool" | "state">,
  report: ToolDiscoveryReport,
  signal?: AbortSignal,
): Promise<ClusterContextRegistry> {
  signal?.throwIfAborted();
  const candidates = report.exposed.filter((tool) => tool.name === TOOL_NAME);
  const tool = candidates[0];
  if (candidates.length !== 1 || !tool) throw new ContextDiscoveryError("incompatible-tool");
  try {
    validateMcpToolContract(tool);
  } catch (error) {
    if (!(error instanceof McpToolContractError)) throw error;
    throw new ContextDiscoveryError("incompatible-tool", undefined, { cause: error });
  }
  let raw: unknown;
  try {
    raw = await connection.callTool(TOOL_NAME, {}, signal);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw new ContextDiscoveryError(
      "tool-error",
      connection.state !== "ready" ? "transport-unavailable" : classifyToolFailure(error),
      { cause: error },
    );
  }
  signal?.throwIfAborted();
  return parseContextRegistry(raw);
}
