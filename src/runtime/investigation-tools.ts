import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Buffer } from "node:buffer";
import type { Evidence } from "../domain/evidence.js";
import { Value } from "typebox/value";
import type {
  InvestigationBinding,
  InvestigationController,
} from "../app/investigation-controller.js";
import { DomainError, requireDomain } from "../domain/errors.js";
import type { Conclusion } from "../domain/incident.js";
import { createInvestigationScopeDescription } from "./investigation-guidance.js";
import { CommandFeedback } from "../tui/command-feedback.js";

const LOCAL_RESULT_BYTES = 64 * 1024;
const PAGE_BYTES = LOCAL_RESULT_BYTES / 2 - 256;

const id = Type.String({ minLength: 1, maxLength: 128 });
const revision = Type.Integer({ minimum: 1 });
const references = Type.Array(id, { maxItems: 1000, uniqueItems: true });
const inspection = Type.Object(
  { hypothesisId: Type.Optional(id), executionId: Type.Optional(id) },
  { additionalProperties: false },
);
const page = Type.Object(
  {
    size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);
const get = Type.Object({ id }, { additionalProperties: false });
const hypothesis = Type.Object(
  {
    id: Type.Optional(id),
    expectedRevision: Type.Optional(revision),
    statement: Type.String({ minLength: 1, maxLength: 2000 }),
    status: Type.Union([
      Type.Literal("candidate"),
      Type.Literal("supported"),
      Type.Literal("rejected"),
    ]),
    supportingEvidence: references,
    contradictingEvidence: references,
    rationale: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  { additionalProperties: false },
);
const conclusion = Type.Object(
  {
    expectedRevision: revision,
    status: Type.Union([Type.Literal("resolved"), Type.Literal("inconclusive")]),
    explanation: Type.String({ minLength: 1, maxLength: 4000 }),
    hypothesisIds: references,
    evidenceIds: references,
  },
  { additionalProperties: false },
);

/** Preserve provenance while bounding only the free-text excerpt. */
function inspectEvidence(evidence: Evidence): Evidence {
  let excerpt = evidence.excerpt;
  while (
    Buffer.byteLength(JSON.stringify({ ...evidence, excerpt }), "utf8") > PAGE_BYTES - 1024 &&
    excerpt.length > 0
  ) {
    excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2));
  }
  return { ...evidence, excerpt, truncated: evidence.truncated || excerpt !== evidence.excerpt };
}

/** Local tools never dispatch MCP or accept incident identity/scope from the model. */
export function registerInvestigationTools(
  pi: ExtensionAPI,
  controller: InvestigationController,
  feedback = new CommandFeedback(),
): void {
  let pending:
    | {
        binding: InvestigationBinding;
        expectedRevision: number;
        status: "resolved" | "inconclusive";
        conclusion: Omit<Conclusion, "concludedAt">;
      }
    | undefined;
  const binding = (ctx: ExtensionContext) =>
    controller.bindingFor(ctx.sessionManager.getSessionId());
  const result = (value: unknown) => {
    const text = JSON.stringify(value);
    const response = { content: [{ type: "text" as const, text }], details: {} };
    requireDomain(
      Buffer.byteLength(JSON.stringify(response), "utf8") <= LOCAL_RESULT_BYTES,
      "Inspection exceeds the response budget; request a smaller page.",
    );
    return response;
  };
  function register<
    Schema extends
      typeof inspection | typeof page | typeof get | typeof hypothesis | typeof conclusion,
  >(
    name: string,
    description: string,
    parameters: Schema,
    run: (args: Static<Schema>, ctx: ExtensionContext) => unknown,
  ): void {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters,
      async execute(_callId, args, signal, _update, ctx) {
        signal?.throwIfAborted();
        try {
          requireDomain(Value.Check(parameters, args), "Invalid investigation tool arguments.");
          binding(ctx);
          return result(run(args, ctx));
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          return {
            ...result({ error: error.failure.kind, message: error.message }),
            isError: true,
          };
        }
      },
    });
  }
  register(
    "investigation_get",
    "Inspect the bound current or most recently concluded investigation; optionally inspect one hypothesisId or executionId. No Kubernetes calls.",
    inspection,
    (args, ctx) => {
      const state = controller.inspect(binding(ctx));
      requireDomain(state !== undefined, "No in-memory investigation is bound to this session.");
      requireDomain(
        args.hypothesisId === undefined || args.executionId === undefined,
        "Inspect one reference at a time.",
      );
      if (args.executionId !== undefined) {
        const found = state.outcomes.find((item) => item.executionId === args.executionId);
        requireDomain(found !== undefined, "Execution outcome must exist in this incident.");
        return found;
      }
      if (args.hypothesisId !== undefined) {
        const found = state.hypotheses.find((item) => item.id === args.hypothesisId);
        requireDomain(found !== undefined, "Hypothesis must exist in this incident.");
        return found;
      }
      return {
        summary: createInvestigationScopeDescription(controller),
        revision: state.revision,
        status: state.incident.status,
        question: state.incident.question,
        focus: state.focus,
        conclusion: state.incident.conclusion,
      };
    },
  );
  register(
    "evidence_list",
    "List bounded whole evidence records; continue with the returned cursor. No Kubernetes calls.",
    page,
    (args, ctx) => controller.evidenceList(binding(ctx), { ...args, maxBytes: PAGE_BYTES }),
  );
  register(
    "evidence_get",
    "Inspect one stored evidence ID in this session's investigation. No Kubernetes calls.",
    get,
    (args, ctx) => inspectEvidence(controller.evidenceGet(binding(ctx), args.id)),
  );
  register(
    "hypothesis_upsert",
    "Record interpretation linked to stored evidence IDs. Updates require id and expectedRevision; omit both to create.",
    hypothesis,
    (args, ctx) => {
      requireDomain(
        (args.id === undefined) === (args.expectedRevision === undefined),
        "Hypothesis updates require both id and expectedRevision.",
      );
      const { id, expectedRevision, ...fields } = args;
      const saved = controller.upsertHypothesis(
        binding(ctx),
        id !== undefined && expectedRevision !== undefined
          ? { ...fields, id, expectedRevision }
          : fields,
      );
      return { id: saved.id, revision: saved.revision, status: saved.status };
    },
  );
  register(
    "investigation_conclude",
    "Validate and queue a conclusion for the idle end of this turn. Resolved means explained, not repaired; requires a cited supported hypothesis. Later changes invalidate the proposal. Inspect after the turn to confirm.",
    conclusion,
    (args, ctx) => {
      const { expectedRevision, status, ...value } = args;
      const owner = binding(ctx);
      pending = undefined;
      const safe = controller.validateConclusion(owner, expectedRevision, status, value);
      pending = {
        binding: owner,
        expectedRevision,
        status,
        conclusion: {
          explanation: safe.explanation,
          hypothesisIds: safe.hypothesisIds,
          evidenceIds: safe.evidenceIds,
        },
      };
      return {
        status: "pending",
        message:
          "Validated; commits only after active work ends if binding and revision remain current.",
      };
    },
  );
  pi.on("agent_end", (event, ctx) => {
    const proposal = pending;
    pending = undefined;
    if (!proposal) return;
    const last = event.messages.findLast((message) => message.role === "assistant");
    if (
      last?.role === "assistant" &&
      (last.stopReason === "aborted" || last.stopReason === "error")
    ) {
      ctx.ui.notify("Conclusion not committed: agent work was interrupted.", "warning");
      return;
    }
    try {
      controller.conclude(
        proposal.binding,
        proposal.expectedRevision,
        proposal.status,
        proposal.conclusion,
      );
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      ctx.ui.notify(`Conclusion not committed: ${error.message}`, "warning");
    }
  });
  pi.on("session_shutdown", () => {
    pending = undefined;
  });
  pi.registerCommand("incident", {
    description: "Inspect investigation or explicitly replace it: /incident new <question>",
    handler: async (args, ctx) => {
      const report = feedback.begin("/incident", ctx.ui);
      try {
        const owner = binding(ctx);
        if (args === "") {
          report(createInvestigationScopeDescription(controller));
          return;
        }
        requireDomain(args.startsWith("new "), "Usage: /incident [new <question>]");
        requireDomain(ctx.isIdle(), "Wait for active work before starting an incident.");
        controller.start(owner, args.slice(4));
        report(createInvestigationScopeDescription(controller));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        report(error.message, "warning");
      }
    },
  });
  pi.registerCommand("evidence", {
    description: "Inspect evidence: /evidence [<id> | --cursor <cursor>]",
    handler: async (args, ctx) => {
      const report = feedback.begin("/evidence", ctx.ui);
      try {
        const owner = binding(ctx);
        const value =
          args === "" || args.startsWith("--cursor ")
            ? controller.evidenceList(owner, {
                ...(args ? { cursor: args.slice(9) } : {}),
                maxBytes: PAGE_BYTES,
              })
            : inspectEvidence(controller.evidenceGet(owner, args));
        report(result(value).content[0]!.text);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        report(error.message, "warning");
      }
    },
  });
}
