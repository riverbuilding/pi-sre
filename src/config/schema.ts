import { z } from "zod";

const nonBlank = z.string().trim().min(1);

export const sreConfigSchema = z.strictObject({
  kubernetes: z.strictObject({
    defaultCluster: nonBlank.optional(),
    mcp: z.strictObject({
      transport: z.literal("stdio"),
      command: nonBlank,
      args: z.array(nonBlank).default([]),
      configFile: nonBlank,
      startupTimeoutMs: z.int().positive().default(15_000),
      toolCallTimeoutMs: z.int().positive().default(30_000),
    }),
  }),
  investigation: z.strictObject({
    defaultTimeRange: z.string().regex(/^\d+(?:ms|s|m|h|d)$/),
    maxToolCalls: z.int().positive(),
  }),
  safety: z.strictObject({
    mode: z.literal("read-only"),
  }),
});

export type SreConfigFile = z.input<typeof sreConfigSchema>;
export type ParsedSreConfig = z.output<typeof sreConfigSchema>;
