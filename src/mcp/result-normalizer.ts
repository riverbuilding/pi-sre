import {
  JSON_RPC_ERROR_CODES,
  McpConnectionClosedError,
  McpError,
  McpTimeoutError,
} from "@earendil-works/pi-mcp";
import { z } from "zod";

import { DEFAULT_RESULT_POLICY, type ResultPolicy } from "../config/schema.js";
import { isSensitiveKey, redactDiagnosticText } from "./redaction.js";

export type ResultStatus = "success" | "tool-error" | "invalid-result";
export type ToolFailureCategory =
  | "transport-unavailable"
  | "authentication-failed"
  | "authorization-failed"
  | "invalid-arguments"
  | "tool-execution-failed"
  | "timeout";

export interface NormalizedMcpResult {
  readonly text: string;
  readonly status: ResultStatus;
  readonly isError: boolean;
  readonly truncated: boolean;
  readonly failureCategory?: ToolFailureCategory;
}

const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  z.object({
    type: z.literal("resource"),
    resource: z.union([
      z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() }),
      z.object({ uri: z.string(), mimeType: z.string().optional(), blob: z.string() }),
    ]),
  }),
  z.object({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  }),
]);
const CallResult = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});
const JsonValue = z.json();
type JsonValue = z.infer<typeof JsonValue>;
const StructuredContent = z.record(z.string(), JsonValue);
const TRUNCATION_NOTICE = "\n[Result truncated]";
const EMPTY_SUCCESS = "Tool completed successfully with no content.";

const FAILURE_MESSAGES: Record<ToolFailureCategory, string> = {
  "transport-unavailable":
    "Kubernetes MCP transport is unavailable. Check the MCP connection and restart pi-sre.",
  "authentication-failed": "Kubernetes authentication failed. Check the configured credentials.",
  "authorization-failed": "Kubernetes authorization failed. Check read-only RBAC permissions.",
  "invalid-arguments": "Invalid arguments for the Kubernetes MCP tool.",
  "tool-execution-failed": "Kubernetes MCP tool reported an execution error.",
  timeout: "Kubernetes MCP operation timed out. Check connectivity and the configured timeout.",
};

/** Classify privately; untrusted error messages are never relayed or retained. */
export function classifyToolFailure(value: unknown): ToolFailureCategory {
  if (value instanceof McpConnectionClosedError) return "transport-unavailable";
  if (value instanceof McpTimeoutError) return "timeout";
  if (value instanceof McpError && value.code === JSON_RPC_ERROR_CODES.invalidParams)
    return "invalid-arguments";
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  if (/\b403\b|forbidden|\bRBAC\b|cannot (?:get|list|watch)|permission denied/i.test(message))
    return "authorization-failed";
  if (
    /\b401\b|unauthorized|unauthenticated|authentication|provide credentials|credentials.*(?:expired|invalid|missing)/i.test(
      message,
    )
  )
    return "authentication-failed";
  if (/invalid (?:arguments?|params|parameters)|-32602/i.test(message)) return "invalid-arguments";
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  if (
    /connection.*(?:closed|unavailable|refused|lost)|transport|not connected|EPIPE|ECONNREFUSED|process exited/i.test(
      message,
    )
  )
    return "transport-unavailable";
  return "tool-execution-failed";
}

function bounded(
  text: string,
  truncated: boolean,
  policy: ResultPolicy,
): { text: string; truncated: boolean } {
  const safe = redactDiagnosticText(text);
  const cut = truncated || safe.length > policy.maxTextChars;
  return {
    text: cut
      ? safe.slice(0, policy.maxTextChars - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE
      : safe,
    truncated: cut,
  };
}

export function normalizeToolFailure(
  category: ToolFailureCategory,
  policy: ResultPolicy = DEFAULT_RESULT_POLICY,
): NormalizedMcpResult {
  return {
    ...bounded(FAILURE_MESSAGES[category], false, policy),
    status: "tool-error",
    isError: true,
    failureCategory: category,
  };
}

/** Shared item budget across all arrays/object fields; no raw object enters details. */
function renderStructured(
  value: Record<string, JsonValue>,
  policy: ResultPolicy,
): { text: string; truncated: boolean } {
  let remaining = policy.maxItems;
  let truncated = false;
  function reduce(value: JsonValue, depth: number): JsonValue {
    if (typeof value === "string") {
      const text = redactDiagnosticText(value);
      if (text.length > policy.maxTextChars) truncated = true;
      return text.slice(0, policy.maxTextChars);
    }
    if (value === null || typeof value !== "object") return value;
    if (depth >= 32) {
      truncated = true;
      return "[Result truncated]";
    }
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const item of value) {
        if (remaining-- <= 0) {
          truncated = true;
          break;
        }
        result.push(reduce(item, depth + 1));
      }
      return result;
    }
    const entries: [string, JsonValue][] = [];
    for (const [key, item] of Object.entries(value)) {
      if (remaining-- <= 0) {
        truncated = true;
        break;
      }
      const safeKey = redactDiagnosticText(key);
      if (safeKey.length > policy.maxTextChars) truncated = true;
      entries.push([
        safeKey.slice(0, policy.maxTextChars),
        isSensitiveKey(key) ? "[REDACTED]" : reduce(item, depth + 1),
      ]);
    }
    return Object.fromEntries(entries);
  }
  return { text: JSON.stringify(reduce(value, 0)), truncated };
}

/** Raw retention is disabled: binary content is described, never decoded, fetched, or persisted. */
export function normalizeMcpResult(
  raw: unknown,
  policy: ResultPolicy = DEFAULT_RESULT_POLICY,
): NormalizedMcpResult {
  const result = CallResult.safeParse(raw);
  if (!result.success)
    return {
      ...bounded("Kubernetes MCP returned an unsupported or invalid tool result.", false, policy),
      status: "invalid-result",
      isError: true,
    };
  const structured = StructuredContent.safeParse(result.data.structuredContent);
  if (result.data.isError) {
    const messages = result.data.content.flatMap((block) => {
      const parsed = ContentBlock.safeParse(block);
      return parsed.success && parsed.data.type === "text" ? [parsed.data.text] : [];
    });
    if (structured.success) messages.push(JSON.stringify(structured.data));
    return normalizeToolFailure(classifyToolFailure(messages.join("\n")), policy);
  }
  if (structured.success) {
    const rendered = renderStructured(structured.data, policy);
    return {
      ...bounded(rendered.text, rendered.truncated, policy),
      status: "success",
      isError: false,
    };
  }
  if (result.data.structuredContent !== undefined && result.data.content.length === 0) {
    return {
      ...bounded("Kubernetes MCP returned an unsupported or invalid tool result.", false, policy),
      status: "invalid-result",
      isError: true,
    };
  }
  const texts: string[] = [];
  let truncated = result.data.content.length > policy.maxItems;
  for (const rawBlock of result.data.content.slice(0, policy.maxItems)) {
    const parsed = ContentBlock.safeParse(rawBlock);
    if (!parsed.success)
      return {
        ...bounded("Kubernetes MCP returned an unsupported or invalid tool result.", false, policy),
        status: "invalid-result",
        isError: true,
      };
    const block = parsed.data;
    let text: string;
    switch (block.type) {
      case "text":
        text = block.text;
        break;
      case "image":
        text = `[Image: ${block.mimeType}; binary payload omitted]`;
        break;
      case "resource":
        text =
          "text" in block.resource
            ? `Resource ${block.resource.uri}\n${block.resource.text}`
            : `Resource ${block.resource.uri} (${block.resource.mimeType ?? "binary"}); binary payload omitted`;
        break;
      case "resource_link":
        text = `Resource link: ${block.name} (${block.uri})${block.description ? `\n${block.description}` : ""}`;
        break;
    }
    texts.push(redactDiagnosticText(text));
    if (texts.join("\n").length > policy.maxTextChars) {
      truncated = true;
      break;
    }
  }
  return {
    ...bounded(texts.join("\n") || EMPTY_SUCCESS, truncated, policy),
    status: "success",
    isError: false,
  };
}
