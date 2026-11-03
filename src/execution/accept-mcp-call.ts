import type { CurrentClusterSelection } from "../cluster/current-selection.js";
import type { McpToolDescriptor } from "../mcp/tool-discovery.js";
import { prepareMcpToolArguments } from "../runtime/tool-call-preparation.js";
import { allowsMcpToolExecution } from "../runtime/tool-execution-policy.js";
import { prepareMcpToolSchema } from "../runtime/tool-policy.js";
import type { CallResult, RequestExecution } from "./request-execution.js";

/** One original connection, never a proxy that routes calls to a replacement. */
export interface DiagnosticConnection {
  readonly ready: boolean;
  getTool(name: string): McpToolDescriptor | undefined;
  callTool(
    name: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** Synchronous validation and registration precede RequestExecution's first queue await. */
export function acceptMcpCall(
  request: RequestExecution,
  selection: CurrentClusterSelection,
  connection: DiagnosticConnection,
  toolCallId: string,
  operation: string,
  parameters: unknown,
  signal?: AbortSignal,
): Promise<CallResult<unknown>> {
  if (!connection.ready) throw new Error("Kubernetes MCP is unavailable; call not executed.");
  const descriptor = connection.getTool(operation);
  if (!descriptor || descriptor.name !== operation)
    throw new Error("Kubernetes MCP tool is unavailable; call not executed.");
  const schema = prepareMcpToolSchema(descriptor);
  const args = prepareMcpToolArguments(schema.policy, parameters);
  if (!args || !schema.validateArguments(args) || !allowsMcpToolExecution(operation, args))
    throw new Error("Invalid Kubernetes MCP arguments; call not executed.");
  const context = schema.policy.clusterDependent ? args.context : undefined;
  if (
    schema.policy.clusterDependent &&
    (typeof context !== "string" || !selection.permits(context))
  )
    throw new Error("Context is outside the current selection; call not executed.");
  const exactContext = typeof context === "string" ? context : undefined;
  const target = exactContext === undefined ? undefined : selection.target(exactContext);
  if (exactContext !== undefined && !target)
    throw new Error("Selected context is unavailable; call not executed.");

  const check = () => {
    if (!connection.ready) throw new Error("Original MCP connection is unavailable.");
    if (connection.getTool(operation) !== descriptor)
      throw new Error("Original MCP tool is unavailable.");
    if (exactContext !== undefined && selection.target(exactContext) !== target)
      throw new Error("Original MCP target is unavailable or changed.");
  };
  return request.accept(
    {
      toolCallId,
      operation,
      ...(exactContext === undefined ? {} : { context: exactContext }),
      parameters: args,
      connection,
    },
    check,
    async (signal) => {
      const value = await connection.callTool(operation, args, signal);
      check();
      return value;
    },
    signal,
  );
}
