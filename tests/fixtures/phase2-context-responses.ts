/** Synthetic adapter acceptance cases, derived from the 0.0.67 structured wire shape.
 * These are not live captures. Slice 1 must enforce every declared outcome.
 */
const alpha = { name: "alpha", server: "https://alpha.example.invalid", default: true };
const beta = { name: "beta", server: "https://beta.example.invalid", default: false };

export const phase2ContextResponses = [
  {
    name: "default",
    outcome: "bound",
    response: {
      structuredContent: { defaultContext: "alpha", contexts: [alpha, beta] },
      content: [],
    },
  },
  {
    name: "no-default",
    outcome: "unbound",
    response: {
      structuredContent: { contexts: [{ ...alpha, default: false }, beta] },
      content: [],
    },
  },
  {
    name: "single-no-default",
    outcome: "unbound",
    response: { structuredContent: { contexts: [beta] }, content: [] },
  },
  {
    name: "empty-structured",
    outcome: "empty",
    response: { structuredContent: { defaultContext: "", contexts: [] }, content: [] },
  },
  {
    name: "empty-text",
    outcome: "empty",
    response: { content: [{ type: "text", text: "No contexts found in kubeconfig" }] },
  },
  {
    name: "malformed",
    outcome: "invalid-response",
    response: { structuredContent: { contexts: ["alpha"] }, content: [] },
  },
  {
    name: "duplicate",
    outcome: "invalid-response",
    response: {
      structuredContent: { defaultContext: "alpha", contexts: [alpha, alpha] },
      content: [],
    },
  },
  {
    name: "contradictory-default",
    outcome: "invalid-response",
    response: {
      structuredContent: { defaultContext: "beta", contexts: [alpha, beta] },
      content: [],
    },
  },
  {
    name: "multiple-defaults",
    outcome: "invalid-response",
    response: {
      structuredContent: { defaultContext: "alpha", contexts: [alpha, { ...beta, default: true }] },
      content: [],
    },
  },
  {
    name: "absent-default-name",
    outcome: "invalid-response",
    response: { structuredContent: { defaultContext: "gamma", contexts: [beta] }, content: [] },
  },
  {
    name: "missing-default-name",
    outcome: "invalid-response",
    response: { structuredContent: { contexts: [alpha, beta] }, content: [] },
  },
  {
    name: "missing-default-flag",
    outcome: "invalid-response",
    response: {
      structuredContent: {
        defaultContext: "alpha",
        contexts: [{ name: "alpha", server: alpha.server }],
      },
      content: [],
    },
  },
  {
    name: "failed",
    outcome: "tool-error",
    response: {
      isError: true,
      content: [{ type: "text", text: "failed to list contexts: synthetic failure" }],
    },
  },
  {
    name: "error-with-structured-data",
    outcome: "tool-error",
    response: {
      isError: true,
      structuredContent: { defaultContext: "alpha", contexts: [alpha] },
      content: [],
    },
  },
  {
    name: "prose-only",
    outcome: "invalid-response",
    response: { content: [{ type: "text", text: "There are two contexts: alpha and beta." }] },
  },
  {
    name: "malformed-structured-with-empty-text",
    outcome: "invalid-response",
    response: {
      structuredContent: { contexts: null },
      content: [{ type: "text", text: "No contexts found in kubeconfig" }],
    },
  },
] as const;
