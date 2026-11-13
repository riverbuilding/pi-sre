import { randomUUID } from "node:crypto";

import { RequestExecution } from "../../../src/execution/request-execution.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPROVE_CALL,
  ControlledApprovalService,
  DENY_CALL,
} from "../../../src/execution/controlled-approval.js";
import { acceptMcpCall } from "../../../src/execution/accept-mcp-call.js";
import {
  controlledOperationsSchema,
  CONTROLLED_TOOLS,
} from "../../../src/config/controlled-operations.js";
import { createRequestMcpToolBridge } from "../../../src/mcp/request-tool-bridge.js";
import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { approvalFixture, approvalInventory } from "../../fixtures/controlled-approval.js";

vi.mock("node:crypto", { spy: true });

function pendingDialog(f: ReturnType<typeof approvalFixture>) {
  const opened = Promise.withResolvers<AbortSignal>();
  const response = Promise.withResolvers<string | undefined>();
  const requestApproval = vi.fn(async (_preview: string, signal: AbortSignal, timeout: number) => {
    void timeout;
    opened.resolve(signal);
    return response.promise;
  });
  f.service.setChannel({ requestApproval });
  f.service.enableInteractiveTerminal();
  const call = f.service.execute(f.input);
  return { opened: opened.promise, response, requestApproval, call };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("controlled approval infrastructure (synthetic policy; no enabled production writes)", () => {
  it("freezes exact final arguments, consumes both budgets once and retains only a safe receipt", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(now);
    vi.mocked(randomUUID)
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");

    const f = approvalFixture();
    const d = pendingDialog(f);
    const approvalSignal = await d.opened;
    expect(d.requestApproval.mock.calls).toStrictEqual([
      [
        `resources_scale
Context: "A"
Final arguments: {"apiVersion":"apps/v1","context":"A","kind":"Deployment","name":"web","namespace":"test","scale":2}`,
        approvalSignal,
        60_000,
      ],
    ]);
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.request.counts.dispatches).toBe(0);
    expect(f.request.controlledDispatches).toBe(0);

    d.response.resolve(APPROVE_CALL);
    const receipt = await d.call;
    const expectedReceipt = {
      operationId: "00000000-0000-4000-8000-000000000002",
      requestId: "00000000-0000-4000-8000-000000000001",
      toolCallId: "call-1",
      operation: "resources_scale",
      profile: "controlled-operations",
      context: "A",
      resource: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        namespace: "test",
        name: "web",
      },
      proposedAt: now,
      approvedAt: now,
      approvedSummary: "resources_scale: one exact call",
      dispatchedAt: now,
      settledAt: now,
      notice:
        "Server acknowledgement does not establish recovery or health. Verification requires a fresh read.",
      outcome: "server-reported-success",
      reason: "completed",
    };
    expect(receipt).toStrictEqual(expectedReceipt);
    expect(f.service.receipts).toStrictEqual([expectedReceipt]);
    expect(f.request.counts.dispatches).toBe(1);
    expect(f.request.controlledDispatches).toBe(1);
    expect(f.callTool.mock.calls).toStrictEqual([
      [
        "resources_scale",
        {
          context: "A",
          apiVersion: "apps/v1",
          kind: "Deployment",
          namespace: "test",
          name: "web",
          scale: 2,
        },
        expect.any(AbortSignal),
      ],
    ]);
    expect(f.callTool.mock.calls[0]?.[1]).not.toBe(f.args);
    expect(Object.isFrozen(f.callTool.mock.calls[0]?.[1])).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt?.resource)).toBe(true);
    await f.request.finish();
  });

  it.each([DENY_CALL, undefined, "Yes", "approve"])(
    "refuses non-exact approval %s for free",
    async (answer) => {
      const f = approvalFixture();
      const d = pendingDialog(f);
      await d.opened;
      d.response.resolve(answer);
      expect(await d.call).toMatchObject({ outcome: "not-executed", reason: "denied" });
      expect(f.callTool).not.toHaveBeenCalled();
      expect(f.request.counts.dispatches).toBe(0);
      expect(f.request.controlledDispatches).toBe(0);
    },
  );

  it.each([
    "selection ABA",
    "target ABA",
    "descriptor",
    "connection",
    "policy",
    "arguments",
    "cancel",
    "finish",
    "close",
    "channel",
  ])("invalidates pending approval on %s, including late approval", async (change) => {
    const f = approvalFixture();
    const d = pendingDialog(f);
    const signal = await d.opened;
    if (change === "selection ABA") {
      f.selection.select({ kind: "exact", contexts: ["B"] });
      f.selection.select({ kind: "all" });
    } else if (change === "target ABA") {
      f.selection.updateInventory(approvalInventory(["B"]));
      f.selection.updateInventory(approvalInventory());
    } else if (change === "descriptor") {
      f.replaceDescriptor();
    } else if (change === "connection") {
      f.retired.abort();
    } else if (change === "policy") {
      f.authority.abort();
    } else if (change === "arguments") {
      f.args.scale = 3;
    } else if (change === "cancel") {
      f.request.cancel();
    } else if (change === "finish") {
      void f.request.finish();
    } else if (change === "channel") {
      f.service.setChannel(undefined);
      f.service.setChannel({ requestApproval: async () => APPROVE_CALL });
    } else {
      f.service.close();
    }
    if (change !== "arguments") {
      expect(signal.aborted).toBe(true);
    }
    d.response.resolve(APPROVE_CALL);
    expect(await d.call).toMatchObject({ outcome: "not-executed", reason: "invalidated" });
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.request.counts.dispatches).toBe(0);
    expect(f.request.controlledDispatches).toBe(0);
  });

  it.each(["request", "connection", "call ID", "operation", "arguments"])(
    "cannot redirect an approval by replacing the caller's %s",
    async (field) => {
      const f = approvalFixture();
      const d = pendingDialog(f);
      await d.opened;
      if (field === "request") {
        f.input.request = new RequestExecution({ maxToolCalls: 10, maxModelIterations: 10 });
      } else if (field === "connection") {
        f.input.connection = { ...f.input.connection };
      } else if (field === "call ID") {
        f.input.toolCallId = "replacement";
      } else if (field === "operation") {
        f.input.operation = "pods_run";
      } else {
        f.input.parameters = { ...f.args, scale: 3 };
      }
      d.response.resolve(APPROVE_CALL);
      expect(await d.call).toMatchObject({
        requestId: f.request.requestId,
        toolCallId: "call-1",
        outcome: "not-executed",
      });
      expect(f.callTool).not.toHaveBeenCalled();
      expect(f.request.counts.dispatches).toBe(0);
      expect(f.input.request.controlledDispatches).toBe(0);
    },
  );

  it("preserves same-value rules, unrelated inventory and live-* additions", async () => {
    const f = approvalFixture();
    const d = pendingDialog(f);
    const signal = await d.opened;
    f.selection.select({ kind: "all" });
    f.selection.updateInventory(approvalInventory(["A", "B", "C"]));
    expect(signal.aborted).toBe(false);
    d.response.resolve(APPROVE_CALL);
    expect(await d.call).toMatchObject({ outcome: "server-reported-success", context: "A" });
    expect(f.callTool.mock.calls[0]?.[1].context).toBe("A");
  });

  it("expires an uncooperative dialog, removes listeners and ignores late success", async () => {
    vi.useFakeTimers();
    const f = approvalFixture({ approvalTimeoutMs: 25 });
    const observeChanges = f.selection.observeChanges.bind(f.selection);
    const stopped = vi.fn();
    const observe = vi.spyOn(f.selection, "observeChanges").mockImplementation((listener) => {
      const remove = observeChanges(listener);
      return () => {
        stopped();
        remove();
      };
    });
    const d = pendingDialog(f);
    const signal = await d.opened;
    await vi.advanceTimersByTimeAsync(25);
    expect(await d.call).toMatchObject({ reason: "expired", outcome: "not-executed" });
    expect(signal.aborted).toBe(true);
    d.response.resolve(APPROVE_CALL);
    await Promise.resolve();
    expect(f.callTool).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes proposals through terminal settlement and does not renew queued expiry", async () => {
    vi.useFakeTimers();
    const f = approvalFixture({ approvalTimeoutMs: 50, maxOperationsPerRequest: 10 });
    const finish = Promise.withResolvers<unknown>();
    f.callTool.mockImplementation(() => finish.promise);
    const d = pendingDialog(f);
    await d.opened;
    d.response.resolve(APPROVE_CALL);
    await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledOnce(), { interval: 1 });
    const next = f.service.execute({ ...f.input, toolCallId: "call-2" });
    await vi.advanceTimersByTimeAsync(50);
    expect(await next).toMatchObject({ reason: "expired", outcome: "not-executed" });
    expect(d.requestApproval).toHaveBeenCalledOnce();
    finish.resolve({ content: [] });
    expect(await d.call).toMatchObject({ outcome: "server-reported-success" });
    expect(f.request.controlledDispatches).toBe(1);
    f.callTool.mockResolvedValue({ content: [] });
    expect(await f.service.execute({ ...f.input, toolCallId: "after-expiry" })).toMatchObject({
      outcome: "server-reported-success",
    });
    expect(d.requestApproval).toHaveBeenCalledTimes(2);
    expect(f.callTool).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires before acquiring request queue capacity without opening a dialog", async () => {
    vi.useFakeTimers();
    const f = approvalFixture({ approvalTimeoutMs: 25 });
    const finish = Promise.withResolvers<unknown>();
    const reads = Array.from({ length: 4 }, (_, i) =>
      f.request.accept(
        { toolCallId: `read-${i}`, operation: "pods_list", parameters: {}, connection: {} },
        () => {},
        () => finish.promise,
      ),
    );
    await vi.waitFor(() => expect(f.request.counts.active).toBe(4), { interval: 1 });
    const requestApproval = vi.fn(async () => APPROVE_CALL);
    f.service.setChannel({ requestApproval });
    f.service.enableInteractiveTerminal();
    const call = f.service.execute(f.input);
    await vi.advanceTimersByTimeAsync(25);
    expect(await call).toMatchObject({ outcome: "not-executed", reason: "expired" });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.request.controlledDispatches).toBe(0);
    finish.resolve({});
    await Promise.all(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["tool", "operation"])(
    "refuses exhausted %s budget without consuming the other",
    async (budget) => {
      const f = approvalFixture({ maxToolCalls: budget === "tool" ? 1 : 10 });
      f.service.enableInteractiveTerminal();
      f.service.setChannel({ requestApproval: async () => APPROVE_CALL });
      if (budget === "tool") {
        await f.request.accept(
          { toolCallId: "read", operation: "pods_list", parameters: {}, connection: {} },
          () => {},
          async () => ({}),
        );
      } else {
        await f.service.execute(f.input);
      }
      const count = f.callTool.mock.calls.length;
      const receipt = await f.service.execute({ ...f.input, toolCallId: "new" });
      expect(receipt).toMatchObject({ outcome: "not-executed", reason: "budget-refused" });
      expect(f.callTool).toHaveBeenCalledTimes(count);
      expect(f.request.controlledDispatches).toBe(budget === "tool" ? 0 : 1);
    },
  );

  it.each(["timeout", "transport", "cancel", "server error", "malformed"])(
    "records %s after dispatch without refund, replay or raw output",
    async (failure) => {
      vi.useFakeTimers();
      const f = approvalFixture({ callTimeoutMs: 20 });
      if (failure === "server error") {
        f.callTool.mockResolvedValue({
          isError: true,
          content: [{ type: "text", text: "PRIVATE_ERROR" }],
        });
      } else if (failure === "transport") {
        f.callTool.mockRejectedValue(new Error("PRIVATE_TRANSPORT_ERROR"));
      } else if (failure === "malformed") {
        f.callTool.mockResolvedValue("PRIVATE_MALFORMED_RESULT");
      } else {
        f.callTool.mockImplementation(() => new Promise(() => {}));
      }
      const d = pendingDialog(f);
      await d.opened;
      d.response.resolve(APPROVE_CALL);
      await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledOnce(), { interval: 1 });
      if (failure === "cancel") {
        f.request.cancel();
      } else if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(20);
      }
      const receipt = await d.call;
      expect(receipt?.outcome).toBe(
        failure === "server error" ? "server-reported-failure" : "outcome-unknown",
      );
      expect(f.request.counts.dispatches).toBe(1);
      expect(f.request.controlledDispatches).toBe(1);
      expect(f.callTool).toHaveBeenCalledOnce();
      expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["read-only", "no UI", "no terminal", "no policy", "sensitive preview"])(
    "refuses %s before approval or dispatch",
    async (mode) => {
      const f = approvalFixture({
        profile: mode === "read-only" ? "read-only" : "controlled-operations",
      });
      const service =
        mode === "no policy"
          ? new ControlledApprovalService(
              "controlled-operations",
              controlledOperationsSchema.parse({ enabledTools: ["resources_scale"] }),
            )
          : f.service;
      const requestApproval = vi.fn(async () => APPROVE_CALL);
      if (mode !== "no UI") {
        service.setChannel({ requestApproval });
      }
      if (mode !== "no terminal") {
        service.enableInteractiveTerminal();
      }
      if (mode === "sensitive preview") {
        Object.assign(f.args, { note: "password=PRIVATE_PASSWORD" });
      }
      expect(await service.execute(f.input)).toMatchObject({
        outcome: "not-executed",
        reason: "refused",
      });
      expect(requestApproval).not.toHaveBeenCalled();
      expect(f.callTool).not.toHaveBeenCalled();
    },
  );

  it("denies Exec in every profile and production direct admission/bridge cannot expose controlled tools", async () => {
    for (const profile of ["read-only", "controlled-operations"] as const) {
      const f = approvalFixture({ profile });
      expect(await f.service.execute({ ...f.input, operation: "pods_exec" })).toBeUndefined();
      const original = f.input.connection.getTool("resources_scale");
      if (!original) {
        throw new Error("Missing synthetic descriptor.");
      }
      for (const operation of [...CONTROLLED_TOOLS, "pods_exec"]) {
        const descriptor = { ...original, name: operation };
        const connection = { ...f.input.connection, getTool: () => descriptor };
        expect(() =>
          acceptMcpCall(f.request, f.selection, connection, "direct", operation, f.args),
        ).toThrow("not approved");
        expect(() =>
          createRequestMcpToolBridge(
            descriptor,
            { profile },
            () => f.request,
            DEFAULT_RESULT_POLICY,
          ),
        ).toThrow("not approved");
      }
      expect(f.callTool).not.toHaveBeenCalled();
    }
  });

  it("bounds receipts to 100 FIFO entries without retaining caller error data", async () => {
    const f = approvalFixture();
    for (let i = 0; i < 105; i++) {
      await f.service.execute({ ...f.input, toolCallId: `call-${i}` });
    }
    expect(f.service.receipts).toHaveLength(100);
    expect(f.service.receipts[0]?.toolCallId).toBe("call-5");
    expect(JSON.stringify(f.service.receipts)).not.toMatch(/parameters|PRIVATE/);
  });
});
