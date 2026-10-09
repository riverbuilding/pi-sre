import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface FixtureParams {
  readonly cursor?: string;
  readonly name?: string;
  readonly arguments?: Record<string, unknown>;
}

const INITIALIZE_RESULT = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: {} },
  serverInfo: { name: "fake-kubernetes-mcp", version: "0.0.1" },
};

const VALID_CONTEXTS = [
  { name: "beta", server: "https://shared.example.invalid", default: false },
  { name: "alpha", server: "https://shared.example.invalid", default: true },
];

if (process.argv[3]) writeFileSync(process.argv[3], String(process.pid));

const scenario = process.argv[2] ?? "success";
process.stderr.write("token=fixture-secret\n");
if (scenario === "large-stderr")
  process.stderr.write(`token=${"PRIVATE_FRAGMENT".repeat(1_000)}\n`);

if (scenario === "exit") process.exit(7);
if (scenario === "malformed") process.stdout.write("this is not json\n");

function listToolsResult(scenario: string, params?: FixtureParams): Record<string, unknown> {
  if (scenario === "paginated" && !params?.cursor) {
    return {
      tools: [
        {
          name: "configuration_view",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
      nextCursor: "page-2",
    };
  }
  if (scenario === "empty-tools") return { tools: [] };

  // Context-discovery scenarios require the stricter descriptor contract.
  // Other scenarios retain their original minimal Phase 1 descriptors.
  const contextDiscovery = scenario.startsWith("contexts-");
  return {
    tools: [
      {
        name: "configuration_contexts_list",
        inputSchema: {
          type: "object",
          ...(contextDiscovery ? { properties: {} } : {}),
        },
        annotations: {
          readOnlyHint: true,
          ...(contextDiscovery ? { destructiveHint: false } : {}),
        },
      },
    ],
  };
}

function callToolResult(scenario: string, params?: FixtureParams): Record<string, unknown> {
  if (scenario.startsWith("contexts-")) {
    if (
      params?.name !== "configuration_contexts_list" ||
      JSON.stringify(params.arguments) !== "{}"
    ) {
      return { content: [{ type: "text", text: "Invalid arguments" }], isError: true };
    }
    switch (scenario) {
      case "contexts-empty":
        return { content: [{ type: "text", text: "No contexts found in kubeconfig" }] };
      case "contexts-error":
        return {
          content: [{ type: "text", text: "401 Unauthorized token=PRIVATE_FIXTURE" }],
          isError: true,
        };
      default:
        return {
          content: [{ type: "text", text: "untrusted presentation" }],
          structuredContent: {
            defaultContext: "alpha",
            contexts: scenario === "contexts-malformed" ? ["alpha"] : VALID_CONTEXTS,
          },
        };
    }
  }

  switch (scenario) {
    case "bridge-error":
      return {
        content: [{ type: "text", text: "403 Forbidden token=PRIVATE_FIXTURE" }],
        isError: true,
      };
    case "bridge-large":
      return {
        content: [{ type: "text", text: "untrusted duplicate PRIVATE_FIXTURE" }],
        structuredContent: {
          contexts: Array.from({ length: 100 }, (_, i) => `dev-${i}`),
          token: "PRIVATE_FIXTURE",
        },
      };
    case "bridge":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name: params?.name,
              arguments: params?.arguments,
              contexts: ["dev", "prod"],
            }),
          },
        ],
      };
    default:
      return { content: [{ type: "text", text: "ok" }] };
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (scenario === "timeout" || scenario === "malformed") return;
  const request: unknown = JSON.parse(line);
  if (!request || typeof request !== "object" || !("method" in request) || !("id" in request))
    return;
  const { method, id, params } = request as {
    method: string;
    id: number;
    params?: FixtureParams;
  };
  if (method === "tools/call" && (scenario === "call-timeout" || scenario === "contexts-timeout")) {
    if (process.argv[3]) writeFileSync(`${process.argv[3]}.call`, "started");
    return;
  }

  let result: Record<string, unknown>;
  switch (method) {
    case "initialize":
      result = INITIALIZE_RESULT;
      break;
    case "tools/list":
      result = listToolsResult(scenario, params);
      break;
    case "tools/call":
      result = callToolResult(scenario, params);
      break;
    default:
      result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
});
