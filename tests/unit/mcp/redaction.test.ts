import { describe, expect, it } from "vitest";

import { isSensitiveKey, redactDiagnosticText } from "../../../src/mcp/redaction.js";

describe("redactDiagnosticText", () => {
  it.each([
    [
      "unquoted assignment",
      "token=fixture-token namespace=demo",
      "token=[REDACTED] namespace=demo",
    ],
    ["case and whitespace", "PASSWORD = fixture-password", "PASSWORD = [REDACTED]"],
    [
      "double-quoted value with spaces",
      'password: "fixture password with spaces"',
      'password: "[REDACTED]"',
    ],
    ["single-quoted value", "secret='fixture secret'", "secret='[REDACTED]'"],
    [
      "JSON field",
      '{"api_key":"fixture-key","context":"dev"}',
      '{"api_key":"[REDACTED]","context":"dev"}',
    ],
    [
      "escaped JSON quotes",
      '{"password":"fixture \\"quoted\\" password"}',
      '{"password":"[REDACTED]"}',
    ],
    ["kubeconfig key data", "client-key-data: fixture-key-data", "client-key-data: [REDACTED]"],
    [
      "OAuth refresh token",
      "refresh_token=fixture-refresh; context=dev",
      "refresh_token=[REDACTED]; context=dev",
    ],
    [
      "AWS secret assignment",
      "aws_secret_access_key=fixture-secret",
      "aws_secret_access_key=[REDACTED]",
    ],
    ["bearer authorization", "Authorization: Bearer fixture-bearer", "Authorization: [REDACTED]"],
    [
      "basic authorization",
      "Authorization: Basic Zml4dHVyZTpwYXNzd29yZA==",
      "Authorization: [REDACTED]",
    ],
    ["standalone bearer credential", "Bearer fixture-bearer", "[REDACTED AUTHORIZATION]"],
    ["JWT", "jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "jwt: [REDACTED TOKEN]"],
    ["API key pattern", "key: sk-123456789012345678901234", "key: [REDACTED KEY]"],
    ["AWS access key pattern", "key: AKIA1234567890123456", "key: [REDACTED KEY]"],
    [
      "URL credentials and query token",
      "https://user:fixture-password@example.com/contexts?token=fixture-token&namespace=demo",
      "https://[REDACTED]@example.com/contexts?token=[REDACTED]&namespace=demo",
    ],
    [
      "PEM private key",
      "before\n-----BEGIN RSA PRIVATE KEY-----\nfixture-key\n-----END RSA PRIVATE KEY-----\nafter",
      "before\n[REDACTED PRIVATE KEY]\nafter",
    ],
    [
      "incomplete PEM private key",
      "-----BEGIN PRIVATE KEY-----\nfixture-key",
      "[REDACTED PRIVATE KEY]",
    ],
    [
      "YAML literal block",
      "client-key-data: |\n  fixture-key\n  fixture-continuation\ncontext: dev\n",
      "client-key-data: [REDACTED]\ncontext: dev\n",
    ],
    [
      "YAML folded block",
      "token: >-\n  fixture-token\ncontext: dev\n",
      "token: [REDACTED]\ncontext: dev\n",
    ],
  ])("redacts %s while preserving surrounding diagnostics", (_example, input, expected) => {
    expect(redactDiagnosticText(input)).toBe(expected);
    expect(redactDiagnosticText(expected)).toBe(expected);
  });

  it.each([
    "",
    "Cluster dev: pod api-123 is Pending in namespace demo.",
    '{"context":"dev","namespace":"demo","count":2}',
  ])("preserves ordinary diagnostic text: %s", (text) => {
    expect(redactDiagnosticText(text)).toBe(text);
  });
});

describe("isSensitiveKey", () => {
  it.each([
    "authorization",
    "Authorization",
    "token",
    "access_token",
    "refresh-token",
    "serviceAccountToken",
    "password",
    "passwd",
    "secret",
    "apiKey",
    "api_key",
    "provider-api-key",
    "credential",
    "client-key-data",
    "clientSecret",
    "aws_secret_access_key",
    "kubeconfig",
    "private_key",
  ])("marks credential field %s for whole-value redaction", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["context", "namespace", "name", "message", "tokenCount", "secretName", "publicKey"])(
    "preserves diagnostic field %s",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});
