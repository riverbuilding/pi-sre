import type { ClusterContextRegistry } from "./context-registry.js";
import {
  createStartupSelection,
  type ClusterScopeRule,
  type StartupClusterIntent,
} from "./context-resolver.js";

/** Startup is strict; runtime availability never edits the user's exact intent. */
export class CurrentClusterSelection {
  #rule: ClusterScopeRule;
  #inventory: ClusterContextRegistry;
  #targets = new Map<string, object>();
  readonly #listeners = new Set<() => void>();

  observeChanges(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  constructor(
    inventory: ClusterContextRegistry,
    intent: StartupClusterIntent = {},
    configuredRule?: ClusterScopeRule,
  ) {
    this.#inventory = inventory;
    this.#rule = createStartupSelection(intent, configuredRule).rule;
    if (this.#rule.kind === "exact" && this.#rule.contexts.some((name) => !inventory.get(name)))
      throw new Error("Unknown startup MCP context; no fallback was applied.");
    this.updateInventory(inventory);
  }

  get rule(): ClusterScopeRule {
    return this.#rule;
  }

  get inventory(): ClusterContextRegistry {
    return this.#inventory;
  }

  get availability() {
    const names =
      this.#rule.kind === "all"
        ? this.#inventory.contexts.map((entry) => entry.name)
        : this.#rule.contexts;
    return {
      available: names.filter((name) => this.#inventory.get(name)),
      unavailable: names.filter((name) => !this.#inventory.get(name)),
    };
  }

  permits(context: string): boolean {
    return this.#rule.kind === "all" || this.#rule.contexts.includes(context);
  }

  /** Target tokens survive unrelated refreshes, but never removal or endpoint replacement. */
  updateInventory(inventory: ClusterContextRegistry): void {
    const targets = new Map<string, object>();
    for (const entry of inventory.contexts) {
      const previous = this.#inventory.get(entry.name);
      targets.set(
        entry.name,
        previous?.server === entry.server ? (this.#targets.get(entry.name) ?? {}) : {},
      );
    }
    this.#inventory = inventory;
    this.#targets = targets;
    this.changed();
  }

  target(context: string): object | undefined {
    return this.#targets.get(context);
  }

  select(rule: ClusterScopeRule): void {
    const candidate = createStartupSelection({ rule }).rule;
    if (
      candidate.kind === "exact" &&
      candidate.contexts.some(
        (name) =>
          !this.#inventory.get(name) &&
          !(this.#rule.kind === "exact" && this.#rule.contexts.includes(name)),
      )
    )
      throw new Error("Unknown MCP context; selection was not changed.");
    this.#rule = candidate;
    this.changed();
  }

  /** Only selection and inventory facts relevant to a picker draft are compared. */
  captureDraft(): { readonly rule: ClusterScopeRule; assertCurrent(): void } {
    const rule = this.#rule;
    const membership = JSON.stringify(
      this.#inventory.contexts.map(({ name, server }) => [name, server]),
    );
    return {
      rule,
      assertCurrent: () => {
        if (
          JSON.stringify(rule) !== JSON.stringify(this.#rule) ||
          membership !==
            JSON.stringify(this.#inventory.contexts.map(({ name, server }) => [name, server]))
        )
          throw new Error("Cluster selection or inventory changed; reopen /clusters.");
      },
    };
  }
}
