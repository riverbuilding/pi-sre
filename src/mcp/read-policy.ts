import {
  DEFAULT_RESOURCE_READ_POLICY,
  type ResourceReadPolicy,
} from "../config/resource-policy.js";

export class ResourceReadPolicyError extends Error {
  constructor() {
    super("Resource read is denied by the configured resource policy; call not executed.");
    this.name = "ResourceReadPolicyError";
  }
}

export interface ResourceReadTarget {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name?: string;
  readonly namespace?: string;
}

/**
 * Enforce the resource allowlist before transport using configuration validated at load time.
 * Discovered-schema validation and exact-context authorization remain mandatory at call acceptance.
 */
export function validateResourceRead(
  args: Readonly<Record<string, unknown>>,
  policy: ResourceReadPolicy = DEFAULT_RESOURCE_READ_POLICY,
): ResourceReadTarget {
  const allowedKind = policy.allowedReadKinds.find(
    (pair) => pair.apiVersion === args.apiVersion && pair.kind === args.kind,
  );
  if (allowedKind === undefined) {
    throw new ResourceReadPolicyError();
  }

  // Extract fields for result matching; argument constraints belong to the discovered schema.
  return {
    apiVersion: allowedKind.apiVersion,
    kind: allowedKind.kind,
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
  };
}
