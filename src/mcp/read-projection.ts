import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { ResultPolicy } from "../config/schema.js";
import type { ResourceReadPolicy } from "../config/resource-policy.js";
import { isPresentableIdentity } from "../execution/identity.js";
import { redactDiagnosticText } from "./redaction.js";
import {
  normalizeMcpResult,
  normalizeToolFailure,
  type NormalizedMcpResult,
} from "./result-normalizer.js";
import { validateResourceRead, type ResourceReadTarget } from "./read-policy.js";

export class ReadPresentationError extends Error {
  constructor() {
    super(
      "Kubernetes MCP returned a resource or configuration result that cannot be safely presented.",
    );
    this.name = "ReadPresentationError";
  }
}

const identity = z
  .string()
  .refine((value) => isPresentableIdentity(value) && !/:\/\/|[?&#]/.test(value));
const text = z
  .string()
  .transform((value) =>
    redactDiagnosticText(
      value
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL withheld]"),
    ),
  );
const number = z.number().finite();
const conditions = z.array(
  z.object({
    type: identity.optional(),
    status: identity.optional(),
    reason: text.optional(),
    lastTransitionTime: text.optional(),
  }),
);
const reference = z.object({
  apiVersion: identity.optional(),
  kind: identity.optional(),
  name: identity.optional(),
  namespace: identity.optional(),
  uid: identity.optional(),
});
const metadata = z.object({
  name: identity,
  namespace: identity.optional(),
  uid: identity.optional(),
  resourceVersion: identity.optional(),
  generation: number.optional(),
  creationTimestamp: text.optional(),
  deletionTimestamp: text.nullable().optional(),
  ownerReferences: z
    .array(
      reference.extend({
        controller: z.boolean().optional(),
        blockOwnerDeletion: z.boolean().optional(),
      }),
    )
    .optional(),
});
const quantity = z.string().regex(/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+|[numkKMGTPE]i?)?$/);
const resources = z.object({
  cpu: quantity.optional(),
  memory: quantity.optional(),
  "ephemeral-storage": quantity.optional(),
});
const container = z.object({
  name: identity.optional(),
  resources: z.object({ requests: resources.optional(), limits: resources.optional() }).optional(),
});
const podSpec = z.object({
  nodeName: identity.optional(),
  schedulerName: identity.optional(),
  restartPolicy: identity.optional(),
  serviceAccountName: identity.optional(),
  containers: z.array(container).optional(),
  initContainers: z.array(container).optional(),
});
const workloadSpec = podSpec.extend({
  replicas: number.optional(),
  template: z.object({ spec: podSpec.optional() }).optional(),
  jobTemplate: z
    .object({
      spec: z.object({ template: z.object({ spec: podSpec.optional() }).optional() }).optional(),
    })
    .optional(),
  schedule: text.optional(),
  suspend: z.boolean().optional(),
  completions: number.optional(),
  parallelism: number.optional(),
});
const port = z.object({
  name: identity.optional(),
  port: number.optional(),
  targetPort: z.union([number, identity]).optional(),
  nodePort: number.optional(),
  protocol: identity.optional(),
});
const routingSpec = z.object({
  selector: z.record(identity, identity).optional(),
  type: identity.optional(),
  clusterIP: identity.optional(),
  clusterIPs: z.array(identity).optional(),
  ports: z.array(port).optional(),
  externalTrafficPolicy: identity.optional(),
  internalTrafficPolicy: identity.optional(),
});
const status = z.object({
  phase: identity.optional(),
  reason: text.optional(),
  conditions: conditions.optional(),
  replicas: number.optional(),
  readyReplicas: number.optional(),
  availableReplicas: number.optional(),
  updatedReplicas: number.optional(),
  currentReplicas: number.optional(),
  observedGeneration: number.optional(),
  succeeded: number.optional(),
  failed: number.optional(),
  active: number.optional(),
  podIP: identity.optional(),
  hostIP: identity.optional(),
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReadPresentationError();
  }
  return value as Record<string, unknown>;
}

/** Parse only presentation fields, strip unknown fields at every selected level. */
function projectResource(value: unknown, target: ResourceReadTarget): unknown {
  const raw = record(value);
  if (raw.apiVersion !== target.apiVersion || raw.kind !== target.kind) {
    throw new ReadPresentationError();
  }
  const base = z.object({ apiVersion: identity, kind: identity, metadata }).parse(raw);
  if (
    (target.namespace !== undefined && base.metadata.namespace !== target.namespace) ||
    (target.name !== undefined && base.metadata.name !== target.name)
  ) {
    throw new ReadPresentationError();
  }
  if (target.kind === "ConfigMap") {
    const count = (value: unknown) => (value === undefined ? 0 : Object.keys(record(value)).length);
    return { ...base, keyCounts: { data: count(raw.data), binaryData: count(raw.binaryData) } };
  }
  let spec: unknown;
  if (target.kind === "Service") {
    spec = raw.spec === undefined ? undefined : routingSpec.parse(raw.spec);
  } else if (
    ["Pod", "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob"].includes(
      target.kind,
    )
  ) {
    spec = raw.spec === undefined ? undefined : workloadSpec.parse(raw.spec);
  }
  const routing = z.object({
    subsets: z
      .array(
        z.object({
          addresses: z
            .array(
              z.object({
                ip: identity,
                nodeName: identity.optional(),
                targetRef: reference.optional(),
              }),
            )
            .optional(),
          notReadyAddresses: z
            .array(
              z.object({
                ip: identity,
                nodeName: identity.optional(),
                targetRef: reference.optional(),
              }),
            )
            .optional(),
          ports: z.array(port).optional(),
        }),
      )
      .optional(),
    addressType: identity.optional(),
    endpoints: z
      .array(
        z.object({
          addresses: z.array(identity),
          nodeName: identity.optional(),
          targetRef: reference.optional(),
          conditions: z
            .object({
              ready: z.boolean().optional(),
              serving: z.boolean().optional(),
              terminating: z.boolean().optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    ports: z.array(port).optional(),
  });
  let extra: unknown = {};
  if (target.kind === "Endpoints" || target.kind === "EndpointSlice") {
    extra = routing.parse(raw);
  }
  return {
    ...base,
    ...record(extra),
    ...(spec === undefined ? {} : { spec }),
    ...(raw.status === undefined ? {} : { status: status.parse(raw.status) }),
  };
}

export function projectResourceRead(
  value: unknown,
  operation: "resources_get" | "resources_list",
  args: Readonly<Record<string, unknown>>,
  policy?: ResourceReadPolicy,
): unknown {
  const target = validateResourceRead(args, policy);
  try {
    if (operation === "resources_get") {
      return projectResource(value, target);
    }
    // Server YAML list output is a bare sequence; structured MCP uses { items }.
    const raw = Array.isArray(value) ? { items: value } : record(value);
    if (
      !Array.isArray(raw.items) ||
      (raw.kind !== undefined && raw.kind !== "List" && raw.kind !== `${target.kind}List`) ||
      (raw.apiVersion !== undefined &&
        raw.apiVersion !== "v1" &&
        raw.apiVersion !== target.apiVersion)
    ) {
      throw new ReadPresentationError();
    }
    return { items: raw.items.map((item) => projectResource(item, target)) };
  } catch {
    throw new ReadPresentationError();
  }
}

function endpoint(value: unknown): string {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    return "[endpoint withheld]";
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "[endpoint withheld]";
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[endpoint withheld]";
  }
}

/** No users, paths, extensions or raw YAML leave this projection. No inventory installation. */
export function projectConfiguration(value: unknown): unknown {
  try {
    const raw = record(value);
    const contexts = z
      .array(
        z.object({
          name: identity,
          context: z.object({ cluster: identity, namespace: identity.optional() }),
        }),
      )
      .parse(raw.contexts);
    const clusters = z
      .array(z.object({ name: identity, cluster: z.object({ server: z.unknown().optional() }) }))
      .parse(raw.clusters);
    return {
      contexts,
      clusters: clusters.map((item) => ({
        name: item.name,
        endpointOrigin: endpoint(item.cluster.server),
      })),
    };
  } catch {
    throw new ReadPresentationError();
  }
}

/** Foundation for Slices 2/3: withhold structurally before the existing bounded normalizer. */
export function normalizeSensitiveReadResult(
  operation: "resources_get" | "resources_list" | "configuration_view",
  args: Readonly<Record<string, unknown>>,
  raw: unknown,
  resultPolicy?: ResultPolicy,
  resourcePolicy?: ResourceReadPolicy,
): NormalizedMcpResult {
  // Policy denial is distinct from malformed presentation and MCP failure.
  if (operation !== "configuration_view") {
    validateResourceRead(args, resourcePolicy);
  }
  try {
    const envelope = record(raw);
    if (
      !Array.isArray(envelope.content) ||
      (envelope.isError !== undefined && typeof envelope.isError !== "boolean")
    ) {
      throw new ReadPresentationError();
    }
    if (envelope.isError === true) {
      return normalizeMcpResult(raw, resultPolicy);
    }
    if (envelope.content.length === 0 && envelope.structuredContent === undefined) {
      throw new ReadPresentationError();
    }
    const project = (value: unknown) =>
      operation === "configuration_view"
        ? projectConfiguration(value)
        : projectResourceRead(value, operation, args, resourcePolicy);
    // Prefer structured data and discard the unused channel. Projection failure must not fall back.
    if (envelope.structuredContent !== undefined) {
      return normalizeMcpResult(
        { content: [], structuredContent: project(envelope.structuredContent) },
        resultPolicy,
      );
    }

    // Text-only results must not forward prose, links, embedded resources or binary data.
    const content = envelope.content.map((block) => {
      const item = record(block);
      if (item.type !== "text" || typeof item.text !== "string") {
        throw new ReadPresentationError();
      }
      // Parsing stays in memory; parser diagnostics must never log source text.
      const value: unknown = parseYaml(item.text, {
        uniqueKeys: true,
        maxAliasCount: 0,
        logLevel: "silent",
      });
      return { type: "text", text: JSON.stringify(project(value)) };
    });
    return normalizeMcpResult({ content }, resultPolicy);
  } catch {
    return { ...normalizeToolFailure("invalid-result", resultPolicy), status: "invalid-result" };
  }
}
