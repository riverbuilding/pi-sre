import { createServer } from "node:http";
import { z } from "zod";

const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
});

/** Local synthetic responses for manual terminal acceptance. No upstream model I/O. */
export async function startOfflineModelServer() {
  let sequence = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const { messages } = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const last = messages.at(-1);
      const user = messages.findLast(
        (message) =>
          message.role === "user" &&
          !JSON.stringify(message.content).includes("Application Kubernetes environment:"),
      );
      const text = JSON.stringify(user?.content);
      const queried =
        last?.role === "tool" ||
        (last?.role === "user" &&
          JSON.stringify(last.content).includes("Application Kubernetes environment:"));
      const contexts = text?.includes("compare")
        ? ["alpha", "beta"]
        : [text?.includes("beta") ? "beta" : "alpha"];
      const delta = queried
        ? {
            content:
              "Fixture report: observations retain their exact context and execution time. No remediation performed.",
          }
        : {
            tool_calls: contexts.map((context, index) => ({
              index,
              id: `manual-${++sequence}`,
              type: "function",
              function: {
                name: "pods_list",
                arguments: JSON.stringify({ context, namespace: "default" }),
              },
            })),
          };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: `response-${sequence}`, object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: queried ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
    })().catch(() => {
      response.writeHead(400);
      response.end("Invalid fixture request");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected local fixture port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
