import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RESOURCE_READ_POLICY,
  REVIEWED_READ_KINDS,
  resourceReadPolicySchema,
} from "../../../src/config/resource-policy.js";
import { validateResourceRead, ResourceReadPolicyError } from "../../../src/mcp/read-policy.js";
import {
  normalizeSensitiveReadResult,
  projectConfiguration,
  projectResourceRead,
  ReadPresentationError,
} from "../../../src/mcp/read-projection.js";

const args = { context: "alpha", apiVersion: "v1", kind: "Pod", namespace: "app", name: "web" };
const privateValue = "UNMARKED_PRIVATE_VALUE_5492";
const pod = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "web",
    namespace: "app",
    annotations: { arbitrary: privateValue },
    managedFields: [privateValue],
    unknown: privateValue,
  },
  spec: {
    nodeName: "worker",
    containers: [
      {
        name: "web",
        env: [{ name: "VALUE", value: privateValue }],
        command: [privateValue],
        resources: { requests: { cpu: "100m", memory: "64Mi" }, extension: privateValue },
      },
    ],
    volumes: [{ secret: { secretName: privateValue } }],
    unknown: privateValue,
  },
  status: {
    phase: "Pending",
    conditions: [{ type: "Ready", status: "False", reason: "Pending", extension: privateValue }],
    extension: privateValue,
  },
  extension: privateValue,
};
const config = {
  contexts: [
    {
      name: "alpha",
      context: {
        cluster: "cluster",
        namespace: "app",
        user: privateValue,
        extensions: [privateValue],
      },
    },
  ],
  clusters: [
    {
      name: "cluster",
      cluster: {
        server: `https://user:${privateValue}@api.example:6443/path?key=${privateValue}#${privateValue}`,
        "certificate-authority-data": privateValue,
        "proxy-url": privateValue,
        extensions: [privateValue],
      },
    },
  ],
  users: [
    {
      name: privateValue,
      user: {
        token: privateValue,
        exec: { command: privateValue },
        "auth-provider": { config: { value: privateValue } },
      },
    },
  ],
  extensions: [privateValue],
  "current-context": privateValue,
};

function normalized(
  value: unknown,
  operation: "resources_get" | "resources_list" | "configuration_view" = "resources_get",
  parameters = args,
) {
  return normalizeSensitiveReadResult(operation, parameters, {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    extra: privateValue,
  });
}

describe("Phase 5 Slice 1 read policy foundations (tools remain disabled)", () => {
  it("defaults to all 19 reviewed canonical pairs and allows only narrowing", () => {
    expect(DEFAULT_RESOURCE_READ_POLICY.allowedReadKinds).toHaveLength(19);
    expect(resourceReadPolicySchema.parse({ allowedReadKinds: [] })).toEqual({
      allowedReadKinds: [],
    });
    for (const resourceKind of REVIEWED_READ_KINDS) {
      expect(
        resourceReadPolicySchema.parse({ allowedReadKinds: [resourceKind] }).allowedReadKinds,
      ).toEqual([resourceKind]);
      expect(validateResourceRead({ context: "alpha", ...resourceKind })).toEqual(resourceKind);
    }
    expect(() =>
      resourceReadPolicySchema.parse({
        allowedReadKinds: [REVIEWED_READ_KINDS[0], REVIEWED_READ_KINDS[0]],
      }),
    ).toThrow();
  });

  it.each([
    { allowedReadKinds: [{ apiVersion: "v1", kind: "Secret" }] },
    {
      allowedReadKinds: [
        { apiVersion: "v1", kind: "Pod" },
        { apiVersion: "v1", kind: "Pod" },
      ],
    },
  ])("rejects invalid policy at the configuration boundary: %j", (policy) => {
    expect(() => resourceReadPolicySchema.parse(policy)).toThrow();
  });

  it.each([
    { kind: "Secret" },
    { kind: "secret" },
    { kind: "secrets" },
    { kind: "List" },
    { kind: "PodList" },
    { kind: "*" },
    { kind: "pods" },
    { kind: "Pod/status" },
    { apiVersion: "v1/" },
    { apiVersion: "apps" },
    { apiVersion: "example.org/v1", kind: "Widget" },
    { apiVersion: "apps/v1", kind: "Pod" },
  ])("denies unsafe request before a transport callback can run: %j", (override) => {
    const transport = vi.fn();
    expect(() => {
      validateResourceRead({ ...args, ...override });
      transport();
    }).toThrow(ResourceReadPolicyError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves target fields and namespace omission without inventing all/default", () => {
    expect(validateResourceRead(args)).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      name: "web",
      namespace: "app",
    });
    expect(validateResourceRead({ apiVersion: "v1", kind: "Pod" })).toEqual({
      apiVersion: "v1",
      kind: "Pod",
    });
  });

  it("leaves argument and resource-scope constraints to schema validation and the server", () => {
    expect(validateResourceRead({ ...args, kind: "Node" })).toMatchObject({
      kind: "Node",
      namespace: "app",
    });
    expect(validateResourceRead({ ...args, name: undefined })).not.toHaveProperty("name");
    expect(
      validateResourceRead({ ...args, namespace: "*", name: "web/status", context: undefined }),
    ).toMatchObject({ namespace: "*", name: "web/status" });
  });

  it("enforces configured narrowing, including an empty allowlist", () => {
    const policy = resourceReadPolicySchema.parse({
      allowedReadKinds: [{ apiVersion: "v1", kind: "Service" }],
    });
    expect(() => validateResourceRead(args, policy)).toThrow(ResourceReadPolicyError);
    expect(validateResourceRead({ ...args, kind: "Service" }, policy)).toMatchObject({
      kind: "Service",
    });
    expect(() => validateResourceRead(args, { allowedReadKinds: [] })).toThrow(
      ResourceReadPolicyError,
    );
  });

  it("projects safe nested resource fields from both channels and drops arbitrary extensions", () => {
    const result = normalized(pod);
    expect(result.status).toBe("success");
    expect(result.text).toContain('"cpu":"100m"');
    expect(result.text).toContain('"nodeName":"worker"');
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(projectResourceRead(pod, "resources_get", args)).toMatchObject({
      metadata: { name: "web" },
      status: { phase: "Pending" },
    });
  });

  it("withholds ConfigMap keys and values, retaining only metadata and counts", () => {
    const value = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "web", namespace: "app" },
      data: { [privateValue]: privateValue },
      binaryData: { [privateValue]: privateValue },
      status: { phase: privateValue },
    };
    const result = normalized(value, "resources_get", { ...args, kind: "ConfigMap" });
    expect(result.status).toBe("success");
    expect(result.text).toContain('"keyCounts":{"data":1,"binaryData":1}');
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it("retains service routing without annotations, environment, arbitrary data or URLs", () => {
    const value = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "web", namespace: "app" },
      spec: {
        selector: { app: "web" },
        clusterIP: "10.0.0.1",
        ports: [{ port: 80, targetPort: 8080, protocol: "TCP", extension: privateValue }],
        externalName: `https://${privateValue}`,
        extension: privateValue,
      },
    };
    const result = normalized(value, "resources_get", { ...args, kind: "Service" });
    expect(result.status).toBe("success");
    expect(result.text).toContain('"targetPort":8080');
    expect(result.text).toContain('"app":"web"');
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it.each(["text", "structured", "both"])(
    "sanitizes configuration %s, including URL credentials and nested auth",
    (channel) => {
      const result = normalizeSensitiveReadResult(
        "configuration_view",
        { minified: true },
        {
          content: channel === "structured" ? [] : [{ type: "text", text: JSON.stringify(config) }],
          ...(channel === "text" ? {} : { structuredContent: config }),
        },
      );
      expect(result.status).toBe("success");
      expect(result.text).toContain("https://api.example:6443");
      expect(result.text).toContain('"namespace":"app"');
      expect(JSON.stringify(result)).not.toMatch(
        /UNMARKED_PRIVATE|certificate|users|exec|auth-provider|current-context|proxy|extensions/,
      );
    },
  );

  it.each(["file:///private/path", "not a URL", "https://api.example\n.invalid", "data:secret"])(
    "withholds unsafe endpoint %s",
    (server) => {
      const value = { ...config, clusters: [{ name: "cluster", cluster: { server } }] };
      expect(JSON.stringify(projectConfiguration(value))).toContain("[endpoint withheld]");
    },
  );

  it("accepts YAML presentation, but rejects duplicate keys, aliases and multiple docs safely", () => {
    const yaml = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\n  namespace: app\n";
    expect(
      normalizeSensitiveReadResult("resources_get", args, {
        content: [{ type: "text", text: yaml }],
      }).status,
    ).toBe("success");
    for (const text of [
      `${yaml}kind: Secret\n`,
      `${yaml}---\n${privateValue}`,
      `contexts: &ctx []\nclusters: *ctx`,
      privateValue,
    ]) {
      const result = normalizeSensitiveReadResult(
        "configuration_view",
        {},
        { content: [{ type: "text", text }] },
      );
      expect(result.status).toBe("invalid-result");
      expect(JSON.stringify(result)).not.toContain(privateValue);
    }
  });

  it.each([
    { ...pod, kind: "Secret" },
    { ...pod, metadata: { name: "another", namespace: "app" } },
    { ...pod, metadata: { name: "web", namespace: "other" } },
    { ...pod, metadata: { name: "web\u001b", namespace: "app" } },
    { ...pod, spec: { containers: "invalid" } },
  ])("rejects malformed/mismatched projection without echoing payload", (value) => {
    const result = normalized(value);
    expect(result.status).toBe("invalid-result");
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(() => projectResourceRead(value, "resources_get", args)).toThrow(ReadPresentationError);
  });

  it("neutralizes terminal controls and withholds credential-bearing URLs in selected text", () => {
    const value = {
      ...pod,
      status: { reason: `Pending\u001b[31m https://api/path?value=${privateValue}` },
    };
    const result = normalized(value);
    expect(result.status).toBe("success");
    expect(result.text).not.toMatch(/UNMARKED_PRIVATE|\\u001b/);
    expect(result.text).toContain("[URL withheld]");
  });

  it("keeps empty lists, policy denial, malformed results and MCP failures distinct", () => {
    expect(
      normalized({ apiVersion: "v1", kind: "PodList", items: [] }, "resources_list").status,
    ).toBe("success");
    expect(() => normalized({}, "resources_get", { ...args, kind: "Secret" })).toThrow(
      ResourceReadPolicyError,
    );
    expect(normalized({}, "resources_list").status).toBe("invalid-result");
    const result = normalizeSensitiveReadResult("resources_get", args, {
      content: [{ type: "text", text: `403 forbidden ${privateValue}` }],
      isError: true,
    });
    expect(result).toMatchObject({ status: "tool-error", failureCategory: "authorization-failed" });
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it("rejects a sensitive or malformed secondary channel even with safe structured data", () => {
    for (const content of [
      [{ type: "text", text: privateValue }],
      [{ type: "resource_link", uri: privateValue }],
    ]) {
      const result = normalizeSensitiveReadResult("resources_get", args, {
        content,
        structuredContent: pod,
      });
      expect(result.status).toBe("invalid-result");
      expect(JSON.stringify(result)).not.toContain(privateValue);
    }
  });

  it("applies existing item/text budgets after projection and retains no raw details", () => {
    const result = normalizeSensitiveReadResult(
      "resources_list",
      args,
      { content: [], structuredContent: { items: Array.from({ length: 20 }, () => pod) } },
      { maxTextChars: 256, maxItems: 5, rawRetention: "disabled" },
    );
    expect(result).toMatchObject({ status: "success", truncated: true });
    expect(result.text.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(result).not.toHaveProperty("raw");
    expect(result).not.toHaveProperty("details");
  });
});
