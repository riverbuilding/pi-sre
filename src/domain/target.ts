import { identity } from "./validation.js";

export interface Target {
  readonly context: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly apiVersion?: string;
  readonly uid?: string;
}

export function createTarget(input: Target): Target {
  return Object.freeze({
    context: identity(input.context),
    kind: identity(input.kind),
    name: identity(input.name),
    ...(input.namespace !== undefined ? { namespace: identity(input.namespace) } : {}),
    ...(input.apiVersion !== undefined ? { apiVersion: identity(input.apiVersion) } : {}),
    ...(input.uid !== undefined ? { uid: identity(input.uid) } : {}),
  });
}

/** Full tuple, including absent fields; encoding cannot collide on delimiters. */
export function targetIdentity(input: Target): string {
  const target = createTarget(input);
  return JSON.stringify([
    target.context,
    target.kind,
    target.name,
    target.namespace ?? null,
    target.apiVersion ?? null,
    target.uid ?? null,
  ]);
}
