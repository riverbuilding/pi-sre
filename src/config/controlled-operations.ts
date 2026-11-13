import { z } from "zod";

export const CONTROLLED_TOOLS = [
  "pods_delete",
  "pods_run",
  "resources_create_or_update",
  "resources_delete",
  "resources_scale",
] as const;

export type ControlledOperation = (typeof CONTROLLED_TOOLS)[number];

export function isControlledOperation(name: string): name is ControlledOperation {
  return CONTROLLED_TOOLS.some((operation) => operation === name);
}

export const controlledOperationsSchema = z.strictObject({
  enabledTools: z
    .array(z.enum(CONTROLLED_TOOLS))
    .refine((tools) => new Set(tools).size === tools.length)
    .default([]),
  approvalTimeoutMs: z.int().positive().max(60_000).default(60_000),
  callTimeoutMs: z.int().positive().max(60_000).default(30_000),
  maxOperationsPerRequest: z.int().min(1).max(10).default(1),
});

export type ControlledOperationsConfig = z.output<typeof controlledOperationsSchema>;
export type ExecutionProfile = "read-only" | "controlled-operations";

export function executionProfileLabel(profile: ExecutionProfile = "read-only"): string {
  if (profile === "controlled-operations") {
    return "CONTROLLED OPERATIONS — APPROVAL REQUIRED";
  }

  return "READ ONLY";
}

export class SafetyProfileChangeError extends Error {
  constructor() {
    super("Safety profile or policy changed; restart pi-sre to apply it.");
    this.name = "SafetyProfileChangeError";
  }
}
