import { z } from "zod";
import { isValidContextSelection } from "../cluster/context-name.js";

const nonBlank = z.string().trim().min(1);

export const resultPolicySchema = z.strictObject({
  maxTextChars: z.int().min(256).max(64_000).default(8_000),
  maxItems: z.int().positive().max(1_000).default(50),
  // Raw MCP payloads are never persisted or attached to Pi result details.
  rawRetention: z.literal("disabled").default("disabled"),
});

export const DEFAULT_RESULT_POLICY = resultPolicySchema.parse({});
export type ResultPolicy = z.output<typeof resultPolicySchema>;

export const sreConfigSchema = z.strictObject({
  results: resultPolicySchema.default(DEFAULT_RESULT_POLICY),
  kubernetes: z.strictObject({
    defaultCluster: z.string().refine(isValidContextSelection).optional(),
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
