/** Admission is independent of transport and never grants scope authority. */
export type ExecutionAdmissionFailure =
  | "capacity-exceeded"
  | "timeout"
  | "stale-scope"
  | "transport-unavailable"
  | "scope-unavailable"
  | "invalid-arguments";

export type ExecutionAdmission =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly category: ExecutionAdmissionFailure };

interface Waiter {
  readonly check: () => ExecutionAdmissionFailure | undefined;
  readonly expiresAt: number;
  readonly finish: (result: ExecutionAdmission) => void;
  readonly cancel: () => void;
}

const MAX_ACTIVE = 4;
const MAX_WAITING = 32;
const WAIT_TIMEOUT_MS = 30_000;

export class ExecutionQueue {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  acquire(
    check: () => ExecutionAdmissionFailure | undefined,
    signal?: AbortSignal,
  ): ExecutionAdmission | Promise<ExecutionAdmission> {
    signal?.throwIfAborted();
    const category = check();
    if (category) return { ok: false, category };
    if (this.active < MAX_ACTIVE && this.waiting.length === 0) return this.reserve();
    if (this.waiting.length >= MAX_WAITING) return { ok: false, category: "capacity-exceeded" };
    return new Promise<ExecutionAdmission>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", waiter.cancel);
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
      };
      const waiter: Waiter = {
        check,
        expiresAt: performance.now() + WAIT_TIMEOUT_MS,
        finish: (result) => {
          if (settled) return;
          cleanup();
          resolve(result);
        },
        cancel: () => {
          if (settled) return;
          cleanup();
          reject(signal?.reason);
          this.refresh();
        },
      };
      const timer = setTimeout(() => {
        waiter.finish({ ok: false, category: "timeout" });
        this.refresh();
      }, WAIT_TIMEOUT_MS);
      this.waiting.push(waiter);
      signal?.addEventListener("abort", waiter.cancel, { once: true });
      if (signal?.aborted) waiter.cancel();
    });
  }

  /** Invalidate all affected waiters even when active transport calls do not settle. */
  refresh(): void {
    for (const waiter of [...this.waiting]) {
      const category =
        waiter.check() ?? (performance.now() >= waiter.expiresAt ? "timeout" : undefined);
      if (category) waiter.finish({ ok: false, category });
    }
    while (this.active < MAX_ACTIVE && this.waiting.length > 0) {
      const waiter = this.waiting[0]!;
      const category =
        waiter.check() ?? (performance.now() >= waiter.expiresAt ? "timeout" : undefined);
      waiter.finish(category ? { ok: false, category } : this.reserve());
    }
  }

  private reserve(): ExecutionAdmission {
    this.active++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.refresh();
      },
    };
  }
}
