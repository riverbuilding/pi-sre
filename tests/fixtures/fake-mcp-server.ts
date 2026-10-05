import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "success";
process.stderr.write("token=fixture-secret\n");
if (scenario === "large-stderr")
  process.stderr.write(`token=${"PRIVATE_FRAGMENT".repeat(1_000)}\n`);

if (scenario === "exit") process.exit(7);
if (scenario === "malformed") process.stdout.write("this is not json\n");

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (scenario === "timeout" || scenario === "malformed") return;
  const request: unknown = JSON.parse(line);
  if (!request || typeof request !== "object" || !("method" in request) || !("id" in request))
    return;
  const { method, id, params } = request as {
    method: string;
    id: number;
    params?: { cursor?: string; name?: string; arguments?: Record<string, unknown> };
  };
  if (method === "tools/call" && scenario === "call-timeout") return;
  const result =
    method === "initialize"
      ? {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-kubernetes-mcp", version: "0.0.1" },
        }
      : method === "tools/list"
        ? scenario === "paginated" && !params?.cursor
          ? {
              tools: [
                {
                  name: "configuration_view",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
              ],
              nextCursor: "page-2",
            }
          : {
              tools: [
                {
                  name: "configuration_contexts_list",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
        : method === "tools/call"
          ? scenario === "bridge-error"
            ? {
                content: [{ type: "text", text: "403 Forbidden token=PRIVATE_FIXTURE" }],
                isError: true,
              }
            : scenario === "bridge-large"
              ? {
                  content: [{ type: "text", text: "untrusted duplicate PRIVATE_FIXTURE" }],
                  structuredContent: {
                    contexts: Array.from({ length: 100 }, (_, i) => `dev-${i}`),
                    token: "PRIVATE_FIXTURE",
                  },
                }
              : scenario === "bridge"
                ? {
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
                  }
                : { content: [{ type: "text", text: "ok" }] }
          : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
});
