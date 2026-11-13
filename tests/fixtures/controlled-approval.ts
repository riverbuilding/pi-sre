import { vi } from "vitest";
import { CurrentClusterSelection } from "../../src/cluster/current-selection.js";
import { ClusterContextRegistry } from "../../src/cluster/context-registry.js";
import {
  controlledOperationsSchema,
  type ExecutionProfile,
} from "../../src/config/controlled-operations.js";
import {
  ControlledApprovalService,
  type ControlledCallReview,
} from "../../src/execution/controlled-approval.js";
import { RequestExecution } from "../../src/execution/request-execution.js";
import type { DiagnosticConnection } from "../../src/execution/accept-mcp-call.js";
import type { McpToolDescriptor } from "../../src/mcp/tool-discovery.js";

export function approvalInventory(names = ["A", "B"]) {
  return new ClusterContextRegistry(
    names.map((name) => ({ name, server: `https://${name}.invalid`, isDefault: false })),
  );
}

// Synthetic shared-policy seam only; this does not implement any Slice 5 operation policy.
export const syntheticReview: ControlledCallReview = (_operation, args) => {
  if (
    args.apiVersion !== "apps/v1" ||
    args.kind !== "Deployment" ||
    args.namespace !== "test" ||
    args.name !== "web" ||
    typeof args.scale !== "number"
  ) {
    throw new Error("PRIVATE_POLICY_ERROR");
  }
  return { apiVersion: "apps/v1", kind: "Deployment", namespace: "test", name: "web" };
};

export function approvalFixture(
  options: {
    profile?: ExecutionProfile;
    approvalTimeoutMs?: number;
    callTimeoutMs?: number;
    maxOperationsPerRequest?: number;
    maxToolCalls?: number;
    review?: ControlledCallReview;
  } = {},
) {
  const selection = new CurrentClusterSelection(approvalInventory());
  const request = new RequestExecution({
    maxToolCalls: options.maxToolCalls ?? 10,
    maxModelIterations: 10,
  });
  const retired = new AbortController();
  const authority = new AbortController();
  let descriptor: McpToolDescriptor = {
    name: "resources_scale",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        context: { type: "string" },
        apiVersion: { type: "string" },
        kind: { type: "string" },
        namespace: { type: "string" },
        name: { type: "string" },
        scale: { type: "integer", minimum: 0 },
        note: { type: "string" },
      },
      required: ["context", "apiVersion", "kind", "namespace", "name", "scale"],
    },
  };
  const callTool = vi.fn(
    async (
      _name: string,
      _args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<unknown> => {
      void _name;
      void _args;
      void _signal;
      return { content: [{ type: "text", text: "PRIVATE_SERVER_RESULT" }] };
    },
  );
  const connection: DiagnosticConnection = {
    ready: true,
    signal: retired.signal,
    getTool: () => descriptor,
    callTool,
  };
  const service = new ControlledApprovalService(
    options.profile ?? "controlled-operations",
    controlledOperationsSchema.parse({
      enabledTools: ["resources_scale"],
      approvalTimeoutMs: options.approvalTimeoutMs,
      callTimeoutMs: options.callTimeoutMs,
      maxOperationsPerRequest: options.maxOperationsPerRequest,
    }),
    options.review ?? syntheticReview,
  );
  const args = {
    context: "A",
    apiVersion: "apps/v1",
    kind: "Deployment",
    namespace: "test",
    name: "web",
    scale: 2,
  };
  const input = {
    request,
    selection,
    connection,
    operation: "resources_scale",
    toolCallId: "call-1",
    parameters: args,
    authoritySignal: authority.signal,
  };
  return {
    service,
    input,
    args,
    request,
    selection,
    retired,
    authority,
    callTool,
    replaceDescriptor() {
      descriptor = structuredClone(descriptor);
      authority.abort();
    },
  };
}
