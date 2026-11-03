import { z } from "zod";

/** Staged request configuration; production switches atomically in Slice 6. */
export const executionLimitsSchema = z.strictObject({
  maxToolCalls: z.int().min(1).max(1_000).default(40),
  maxModelIterations: z.int().min(1).max(2_000).default(80),
});

export type ExecutionLimits = z.output<typeof executionLimitsSchema>;
