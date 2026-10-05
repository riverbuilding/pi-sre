import { McpConnectionClosedError, McpError, McpTimeoutError } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";

import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import {
  classifyToolFailure,
  normalizeMcpResult,
  normalizeToolFailure,
} from "../../../src/mcp/result-normalizer.js";

const policy = { ...DEFAULT_RESULT_POLICY, maxTextChars: 256, maxItems: 3 };
const textResult = (text: string) => ({ content: [{ type: "text", text }] });

describe("MCP result normalization", () => {
  it("preserves complete small text and multiple blocks", () => {
    expect(
      normalizeMcpResult({
        content: [
          { type: "text", text: "dev" },
          { type: "text", text: "prod" },
        ],
      }),
    ).toEqual({ text: "dev\nprod", status: "success", isError: false, truncated: false });
  });

  it("prefers valid structured content without duplicating text or raw details", () => {
    const structuredContent = { contexts: ["dev", "prod"], active: "dev" };
    const result = normalizeMcpResult({ ...textResult("duplicate"), structuredContent });
    expect(JSON.parse(result.text)).toEqual(structuredContent);
    expect(result).toMatchObject({ status: "success", isError: false, truncated: false });
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("falls back to content when structured content is invalid", () => {
    expect(normalizeMcpResult({ ...textResult("dev"), structuredContent: ["invalid"] }).text).toBe(
      "dev",
    );
  });

  it.each([{ content: [] }, textResult("")])("keeps empty success distinct from failure", (raw) => {
    expect(normalizeMcpResult(raw)).toMatchObject({
      text: "Tool completed successfully with no content.",
      status: "success",
      isError: false,
    });
  });

  it("bounds text including the visible truncation notice", () => {
    const result = normalizeMcpResult(textResult("x".repeat(20_000)), policy);
    expect(result.text.length).toBe(policy.maxTextChars);
    expect(result.text).toMatch(/\[Result truncated\]$/);
    expect(result.truncated).toBe(true);
    expect(normalizeMcpResult(textResult("x".repeat(256)), policy).truncated).toBe(false);
  });

  it("shares the structured item budget across nested objects and arrays", () => {
    const result = normalizeMcpResult(
      { content: [], structuredContent: { contexts: ["dev", "prod", "third"], ignored: "later" } },
      policy,
    );
    expect(result.text).toContain('{"contexts":["dev","prod"]}');
    expect(result.text).not.toContain("third");
    expect(result.text).toMatch(/\[Result truncated\]$/);
    expect(result.text.length).toBeLessThanOrEqual(policy.maxTextChars);
  });

  it("marks oversized structured strings and content item limits", () => {
    for (const raw of [
      { content: [], structuredContent: { text: "x".repeat(10_000) } },
      { content: [1, 2, 3, 4].map((n) => ({ type: "text", text: String(n) })) },
    ]) {
      const result = normalizeMcpResult(raw, policy);
      expect(result.truncated).toBe(true);
      expect(result.text).toMatch(/\[Result truncated\]$/);
      expect(result.text.length).toBeLessThanOrEqual(policy.maxTextChars);
    }
  });

  it("renders resources and image metadata without binary data or fetching links", () => {
    const result = normalizeMcpResult({
      content: [
        { type: "resource", resource: { uri: "mcp://contexts", text: "dev, prod" } },
        {
          type: "resource",
          resource: {
            uri: "mcp://blob",
            mimeType: "application/octet-stream",
            blob: "PRIVATE_BINARY",
          },
        },
        {
          type: "resource_link",
          name: "Contexts",
          uri: "mcp://contexts",
          description: "Configured contexts",
        },
        { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE" },
      ],
    });
    expect(result).toMatchObject({ status: "success", isError: false, truncated: false });
    expect(result.text).toContain("dev, prod");
    expect(result.text).toContain("Configured contexts");
    expect(result.text).toContain("Image: image/png");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it.each([
    {},
    { content: [{ type: "text", text: 1 }] },
    { content: [{ type: "resource", resource: { uri: "mcp://bad" } }] },
    { content: [{ type: "audio", data: "private" }] },
    { content: [], isError: "false" },
  ])("fails closed for malformed or unsupported results", (raw) => {
    expect(normalizeMcpResult(raw)).toMatchObject({ status: "invalid-result", isError: true });
  });

  it("never prefers successful structured observations over an MCP error", () => {
    const result = normalizeMcpResult({
      content: [{ type: "text", text: "403 Forbidden token=private" }],
      structuredContent: { contexts: ["fake"] },
      isError: true,
    });
    expect(result).toMatchObject({
      status: "tool-error",
      isError: true,
      failureCategory: "authorization-failed",
    });
    expect(result.text).not.toContain("private");
    expect(result.text).not.toContain("fake");
  });

  it("classifies structured error responses without exposing them", () => {
    const result = normalizeMcpResult({
      content: [],
      isError: true,
      structuredContent: { error: { code: 401, message: "Unauthorized", token: "PRIVATE" } },
    });
    expect(result).toMatchObject({ isError: true, failureCategory: "authentication-failed" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("rejects malformed structured-only observations", () => {
    expect(normalizeMcpResult({ content: [], structuredContent: [] })).toMatchObject({
      status: "invalid-result",
      isError: true,
    });
  });

  it("redacts structured credential fields recursively", () => {
    const result = normalizeMcpResult({
      content: [],
      structuredContent: {
        contexts: ["dev"],
        nested: {
          token: "PRIVATE_TOKEN",
          client_key_data: "PRIVATE_KEY",
          password: "PRIVATE_PASSWORD",
          apiKey: "PRIVATE_API",
        },
      },
    });
    expect(JSON.parse(result.text)).toMatchObject({
      contexts: ["dev"],
      nested: { token: "[REDACTED]", password: "[REDACTED]" },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it.each([
    "token=PRIVATE_TOKEN",
    "Authorization: Bearer PRIVATE_BEARER",
    "Authorization: Basic PRIVATE_BASIC",
    'password: "PRIVATE PASSWORD WITH SPACES"',
    '{"api_key":"PRIVATE_API"}',
    "client-key-data: PRIVATE_KEY_DATA",
    "client-key-data: |\n  PRIVATE_MULTILINE\n  PRIVATE_CONTINUATION\n",
    "https://user:PRIVATE_PASSWORD@example.com/?token=PRIVATE_QUERY",
    "-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_KEY\n-----END RSA PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    "sk-123456789012345678901234",
  ])("redacts known credential patterns in text/resource diagnostics: %s", (text) => {
    for (const raw of [
      textResult(text),
      { content: [{ type: "resource", resource: { uri: "mcp://diagnostic", text } }] },
    ]) {
      const result = normalizeMcpResult(raw);
      expect(result.text).toContain("[REDACTED");
      expect(result.text).not.toContain("PRIVATE_");
      expect(result.text).not.toContain("eyJhbGci");
      expect(result.text).not.toContain("sk-123");
    }
  });

  it("redacts before truncating, including a credential crossing the character budget", () => {
    const result = normalizeMcpResult(
      textResult("x".repeat(240) + ' token="PRIVATE_SECRET_AT_BOUNDARY"'),
      policy,
    );
    expect(result.text).not.toContain("PRIVATE");
    expect(result.text.length).toBeLessThanOrEqual(256);
  });

  it.each([
    [new McpConnectionClosedError(), "transport-unavailable"],
    [new Error("connection unavailable token=PRIVATE"), "transport-unavailable"],
    [new Error("401 Unauthorized token=PRIVATE"), "authentication-failed"],
    [new Error("403 Forbidden token=PRIVATE"), "authorization-failed"],
    [new McpError(-32602, "PRIVATE"), "invalid-arguments"],
    [new McpTimeoutError(10), "timeout"],
    [new Error("operation failed token=PRIVATE"), "tool-execution-failed"],
  ] as const)("classifies failures without relaying or retaining causes", (error, category) => {
    expect(classifyToolFailure(error)).toBe(category);
    const result = normalizeToolFailure(classifyToolFailure(error), policy);
    expect(result).toMatchObject({
      status: "tool-error",
      isError: true,
      failureCategory: category,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result).not.toHaveProperty("cause");
  });
});
