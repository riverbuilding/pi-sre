import { executionProfileLabel, type ExecutionProfile } from "../config/controlled-operations.js";
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

/** Add provenance to the bounded normalized body. No raw data enters details. */
function present(
  source: Source,
  state: Presentation,
  text: string,
  truncated: boolean,
  profile?: ExecutionProfile,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Source: ${JSON.stringify({
          ...source,
          profile: executionProfileLabel(profile),
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
          truncated,
        })}\n${text}`,
      },
    ],
    details: {
      status: state.status,
      truncated,
      ...(state.failureCategory ? { failureCategory: state.failureCategory } : {}),
    },
    isError: state.status !== "success",
  };
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
  publication: Pick<RequestMcpPublication, "accept" | "resourceReadPolicy" | "profile">,
  currentRequest: () => RequestExecution | undefined,
  policy: ResultPolicy,
): ToolDefinition {
  const schema = prepareMcpToolSchema(descriptor);
  const operation = descriptor.name;
  let description = descriptor.description ?? operation;
  if (operation === "configuration_view") {
    description +=
      " Pi SRE returns only safe metadata: context/cluster names, namespaces and endpoint origins. minified refers to the server default context, not the current user selection. This does not change selection or refresh authoritative inventory.";
  }
  if (["pods_log", "nodes_log"].includes(operation)) {
    description +=
      " Pi SRE limits: log tail defaults to 100 lines; allowed range 1–1000; streaming is disabled.";
  }

  return {
    name: operation,
    label: operation,
    description,
    parameters: structuredClone(schema.parameters),
    executionMode: "parallel",
    renderCall(args) {
      const context: unknown =
        typeof args === "object" && args !== null && "context" in args ? args.context : undefined;
      return new Text(
        [
          `${operation} | ${executionProfileLabel(publication.profile)}`,
          schema.policy.clusterDependent
            ? `Requested context: ${isPresentableIdentity(context) ? JSON.stringify(context) : "missing or unsafe identity; withheld"}`
            : "Context: configuration metadata (not cluster dependent; does not change selection)",
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
      const render = (state: Presentation, text: string, truncated = false) =>
        present(source, state, text, truncated, publication.profile);
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
        } else if (schema.policy.clusterDependent && isPresentableIdentity(namespace)) {
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
          ...(schema.policy.clusterDependent && isPresentableIdentity(context) ? { context } : {}),
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
          operation === "resources_get" ||
          operation === "resources_list" ||
          operation === "configuration_view"
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
