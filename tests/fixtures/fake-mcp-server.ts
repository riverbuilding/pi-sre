import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { scopedPodTool } from "./scoped-tool.js";
import captured from "./phase2-server-0.0.67.json" with { type: "json" };

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
  if (scenario === "diagnostic-evolved") {
    return {
      tools: captured.cases["multiple-default"].descriptors.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema:
          tool.name === "pods_get"
            ? {
                ...tool.inputSchema,
                properties: {
                  ...tool.inputSchema.properties,
                  view: { type: "string", enum: ["summary", "full"] },
                },
                required: ["name", "view"],
                additionalProperties: false,
              }
            : tool.inputSchema,
        outputSchema: { type: "object", properties: { marker: { type: "string" } } },
      })),
    };
  }
  if (scenario.startsWith("diagnostic-"))
    return { tools: captured.cases["multiple-default"].descriptors };
  if (scenario.startsWith("scoped-")) {
    return {
      tools: [
        {
          name: "configuration_contexts_list",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        scopedPodTool,
      ],
    };
  }
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

  // Other scenarios advertise a simple enumeration descriptor.
  return {
    tools: [
      {
        name: "configuration_contexts_list",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ],
  };
}

function callToolResult(scenario: string, params?: FixtureParams): Record<string, unknown> {
  if (scenario.startsWith("diagnostic-")) {
    if (params?.name === "configuration_contexts_list") {
      if (scenario === "diagnostic-empty")
        return { content: [], structuredContent: { contexts: [] } };
      return {
        content: [],
        structuredContent: {
          ...(scenario === "diagnostic-unbound" ? {} : { defaultContext: "alpha" }),
          contexts: VALID_CONTEXTS.filter(
            (entry) => scenario !== "diagnostic-alpha-only" || entry.name === "alpha",
          ).map((entry) => ({
            ...entry,
            default: scenario !== "diagnostic-unbound" && entry.default,
          })),
        },
      };
    }
    if (
      ["diagnostic-authentication", "diagnostic-authorization", "diagnostic-operation"].includes(
        scenario,
      )
    ) {
      return {
        content: [
          {
            type: "text",
            text:
              scenario === "diagnostic-authentication"
                ? "401 Unauthorized"
                : scenario === "diagnostic-authorization"
                  ? "403 Forbidden"
                  : "Resource operation failed",
          },
        ],
        isError: true,
      };
    }
    return {
      content: [],
      structuredContent: {
        marker: `${String(params?.arguments?.context)}-${String(params?.name)}`,
        token: "PRIVATE_FIXTURE",
      },
    };
  }
  if (scenario.startsWith("scoped-")) {
    if (params?.name === "configuration_contexts_list") {
      return {
        content: [],
        structuredContent: { defaultContext: "alpha", contexts: VALID_CONTEXTS },
      };
    }
    if (
      params?.name !== "pods_list" ||
      !["alpha", "beta"].includes(String(params.arguments?.context))
    ) {
      return { content: [{ type: "text", text: "Invalid arguments" }], isError: true };
    }
    if (scenario === "scoped-error") {
      return {
        content: [{ type: "text", text: "401 Unauthorized token=PRIVATE_FIXTURE" }],
        isError: true,
      };
    }
    if (scenario === "scoped-malformed") return { content: [{ type: "text", text: 1 }] };
    return {
      content: [],
      structuredContent: {
        pods:
          scenario === "scoped-empty"
            ? []
            : [{ name: `${String(params.arguments?.context)}-pod`, token: "PRIVATE_FIXTURE" }],
      },
    };
  }
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
      case "contexts-no-default":
        return {
          content: [],
          structuredContent: {
            contexts: VALID_CONTEXTS.map((entry) => ({ ...entry, default: false })),
          },
        };
      case "contexts-runtime":
        return {
          content: [],
          structuredContent: {
            defaultContext: "dev",
            contexts: ["dev", "prod"].map((name) => ({
              name,
              server: "https://example.invalid",
              default: name === "dev",
            })),
          },
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

let toolCalls = 0;
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
  if (method === "tools/call") {
    toolCalls++;
    if (process.argv[3]) appendFileSync(`${process.argv[3]}.calls`, `${JSON.stringify(params)}\n`);
  }
  if (method === "tools/call" && scenario === "contexts-call-timeout" && toolCalls > 1) {
    if (process.argv[3]) writeFileSync(`${process.argv[3]}.call`, "started");
    return;
  }
  if (method === "tools/call" && scenario === "scoped-timeout" && params?.name === "pods_list")
    return;
  if (
    method === "tools/call" &&
    scenario === "diagnostic-delayed" &&
    params?.name === "pods_list"
  ) {
    if (process.argv[3]) writeFileSync(`${process.argv[3]}.call`, "started");
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, result: callToolResult(scenario, params) })}\n`,
      );
    }, 200);
    return;
  }
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
