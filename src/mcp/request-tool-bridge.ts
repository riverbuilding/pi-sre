import { Text } from "@earendil-works/pi-tui";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { RequestMcpPublication } from "../app/request-mcp-controller.js";
import type { ResultPolicy } from "../config/schema.js";
import { ExecutionError, type ExecutionFailureCategory } from "../execution/errors.js";
import { isPresentableIdentity } from "../execution/identity.js";
import type { CallResult, RequestExecution } from "../execution/request-execution.js";
import { prepareMcpToolArguments } from "../runtime/tool-call-preparation.js";
import { allowsMcpToolExecution } from "../runtime/tool-execution-policy.js";
import { McpToolSchemaError, prepareMcpToolSchema } from "../runtime/tool-policy.js";
import {
  classifyToolFailure,
  normalizeMcpResult,
  normalizeToolFailure,
  type ToolFailureCategory,
} from "./result-normalizer.js";
import type { McpToolDescriptor } from "./tool-discovery.js";

import { ResourceReadPolicyError } from "./read-policy.js";
import { normalizeSensitiveReadResult } from "./read-projection.js";

type FailureCategory = ToolFailureCategory | ExecutionFailureCategory | "cancelled";
type Status = "success" | "error" | "invalid-result" | "cancelled" | "not-executed";

interface Source {
  readonly operation: string;
  /** Only dispatched results assert execution against this context. */
  readonly context?: string;
  readonly namespace?: string;
  readonly namespacePolicy?: string;
}

interface Presentation {
  readonly status: Status;
  readonly failureCategory?: FailureCategory;
  readonly dispatchedAt?: number;
  readonly settledAt?: number;
}

const NOTICE = "\n[Result truncated]";

function presentationRefused() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Not executed: source cannot fit the result limit. Identity withheld; no query time. [presentation-refused]",
      },
    ],
    details: { status: "not-executed" as const, truncated: false },
    isError: true,
  };
}

/** Whole serialized public result shares one budget. No raw data enters details. */
function present(
  source: Source,
  state: Presentation,
  text: string,
  truncated: boolean,
  maxChars: number,
) {
  const build = (excerpt: string, cut: boolean) => ({
    content: [
      {
        type: "text" as const,
        text: `Source: ${JSON.stringify({
          ...source,
          profile: "READ ONLY",
          status: state.status,
          execution: state.dispatchedAt === undefined ? "not-executed" : "dispatched",
          ...(state.failureCategory ? { failureCategory: state.failureCategory } : {}),
          ...(state.dispatchedAt === undefined
            ? {}
            : {
                timeBasis: "client execution interval; not object observation time",
                dispatchedAt: new Date(state.dispatchedAt).toISOString(),
                settledAt: new Date(state.settledAt!).toISOString(),
              }),
          truncated: cut,
        })}\n${excerpt}`,
      },
    ],
    details: {
      status: state.status,
      truncated: cut,
      ...(state.failureCategory ? { failureCategory: state.failureCategory } : {}),
    },
    isError: state.status !== "success",
  });
  const fits = (excerpt: string, cut: boolean) =>
    JSON.stringify(build(excerpt, cut)).length <= maxChars;
  if (fits(text, truncated)) return build(text, truncated);
  if (!fits(NOTICE, true)) return undefined;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, mid) + NOTICE, true)) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(text[low - 1]!)) low--;
  return build(text.slice(0, low) + NOTICE, true);
}

function failureCategory(error: unknown): FailureCategory {
  if (error instanceof ResourceReadPolicyError) {
    return "resource-policy-denied";
  }
  if (error instanceof ExecutionError) return error.category;
  if (error instanceof McpToolSchemaError)
    return error.reason === "not-allowlisted" ? "tool-not-approved" : "incompatible-schema";
  return classifyToolFailure(error);
}

function failureText(category: FailureCategory): string {
  switch (category) {
    case "budget-refused":
      return "Request tool dispatch limit reached. Explain the available findings and limits.";
    case "request-closed":
      return "User request is closed; call not executed.";
    case "cancelled":
      return "Call cancelled; no valid result obtained.";
    case "transport-unavailable":
      return "Kubernetes MCP connection is unavailable or interrupted; no valid result obtained. Use /mcp_restart to retry.";
    default:
      return normalizeToolFailure(category).text;
  }
}

/** Unified pipeline capturing one original connection publication. */
export function createRequestMcpToolBridge(
  descriptor: McpToolDescriptor,
  publication: Pick<RequestMcpPublication, "accept" | "resourceReadPolicy">,
  currentRequest: () => RequestExecution | undefined,
  policy: ResultPolicy,
): ToolDefinition {
  const schema = prepareMcpToolSchema(descriptor);
  const operation = descriptor.name;
  return {
    name: operation,
    label: operation,
    description: `${descriptor.description ?? operation}${["pods_log", "nodes_log"].includes(operation) ? " Pi SRE limits: log tail defaults to 100 lines; allowed range 1–1000; streaming is disabled." : ""}`,
    parameters: structuredClone(schema.parameters),
    executionMode: "parallel",
    renderCall(args) {
      const context: unknown =
        typeof args === "object" && args !== null && "context" in args ? args.context : undefined;
      return new Text(
        [
          `${operation} | READ ONLY`,
          schema.policy.clusterDependent
            ? `Requested context: ${isPresentableIdentity(context) ? JSON.stringify(context) : "missing or unsafe identity; withheld"}`
            : "Context: inventory operation (not cluster dependent)",
        ].join("\n"),
        0,
        0,
      );
    },
    prepareArguments(args: unknown) {
      return prepareMcpToolArguments(schema.policy, args) ?? args;
    },
    // Repeat validation at the execution boundary, including direct programmatic calls.
    async execute(toolCallId, parameters, signal) {
      let source: Source = { operation };
      const render = (state: Presentation, text: string, truncated = false) => {
        const result = present(source, state, text, truncated, policy.maxTextChars);
        // The pre-dispatch reservation guarantees this for all execution outcomes.
        if (!result) return presentationRefused();
        return result;
      };
      const fail = (category: FailureCategory, result?: CallResult<unknown>) =>
        render(
          {
            status:
              result?.dispatchedAt === undefined
                ? "not-executed"
                : category === "cancelled"
                  ? "cancelled"
                  : "error",
            failureCategory: category,
            ...(result?.dispatchedAt === undefined
              ? {}
              : { dispatchedAt: result.dispatchedAt, settledAt: result.settledAt }),
          },
          failureText(category),
        );
      try {
        const args = prepareMcpToolArguments(schema.policy, parameters);
        // Never include malformed or sensitive identities, even on a validation failure.
        const context = args?.context;
        const namespace = args?.namespace;
        const allPodMetrics = operation === "pods_top" && args?.all_namespaces !== false;
        let namespaceSource: Pick<Source, "namespace" | "namespacePolicy"> = {};
        if (allPodMetrics) {
          namespaceSource = {
            namespacePolicy:
              "all namespaces requested (all_namespaces defaults to true), subject to server policy; namespace argument does not narrow this call",
          };
        } else if (isPresentableIdentity(namespace)) {
          namespaceSource = { namespace };
        } else if (schema.policy.clusterDependent) {
          let namespacePolicy = "server/context policy (not all namespaces)";
          if (operation === "resources_list") {
            namespacePolicy =
              "namespace omitted; all namespaces for namespaced kinds requested, subject to server policy";
          }
          namespaceSource = { namespacePolicy };
        }
        source = {
          operation,
          ...(isPresentableIdentity(context) ? { context } : {}),
          ...namespaceSource,
        };
        if (
          !args ||
          !schema.validateArguments(args) ||
          !allowsMcpToolExecution(operation, args, publication.resourceReadPolicy)
        ) {
          return fail("invalid-arguments");
        }
        for (const field of ["context", "namespace", "container"]) {
          if (args[field] !== undefined && !isPresentableIdentity(args[field]))
            return fail("invalid-arguments");
        }
        // Reserve the largest envelope before synchronous acceptance/registration. Both
        // timestamps are fixed-width ISO UTC; the longest failure category is reserved.
        if (
          !present(
            source,
            {
              status: "invalid-result",
              failureCategory: "authentication-failed",
              dispatchedAt: 0,
              settledAt: 0,
            },
            NOTICE,
            true,
            policy.maxTextChars,
          )
        )
          return presentationRefused();
        const request = currentRequest();
        if (!request) return fail("request-closed");
        if (!publication.accept) return fail("transport-unavailable");
        let result: CallResult<unknown>;
        try {
          result = await publication.accept(request, toolCallId, operation, args, signal);
        } catch (error) {
          return fail(
            request.signal.aborted || signal?.aborted ? "cancelled" : failureCategory(error),
          );
        }
        if (result.status !== "success")
          return fail(
            result.status === "cancelled" ? "cancelled" : failureCategory(result.error),
            result,
          );
        const normalized =
          operation === "resources_get" || operation === "resources_list"
            ? normalizeSensitiveReadResult(
                operation,
                args,
                result.value,
                policy,
                publication.resourceReadPolicy,
              )
            : normalizeMcpResult(result.value, policy);
        return render(
          {
            status:
              normalized.status === "success"
                ? "success"
                : normalized.status === "invalid-result"
                  ? "invalid-result"
                  : "error",
            ...(normalized.failureCategory
              ? { failureCategory: normalized.failureCategory }
              : normalized.status === "invalid-result"
                ? { failureCategory: "invalid-result" }
                : {}),
            dispatchedAt: result.dispatchedAt,
            settledAt: result.settledAt,
          },
          normalized.text,
          normalized.truncated,
        );
      } catch (error) {
        return fail(failureCategory(error));
      }
    },
  };
}
