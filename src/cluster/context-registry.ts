import type { ClusterContext } from "./cluster-context.js";

/** Complete validated inventory; construction belongs to the MCP adapter. */
export class ClusterContextRegistry {
  readonly contexts: readonly ClusterContext[];
  readonly defaultContext: ClusterContext | undefined;
  readonly #byName: ReadonlyMap<string, ClusterContext>;

  constructor(contexts: readonly ClusterContext[]) {
    const entries = contexts.map((context) => Object.freeze({ ...context }));
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const byName = new Map(entries.map((context) => [context.name, context]));
    const defaults = entries.filter((context) => context.isDefault);
    if (byName.size !== entries.length || defaults.length > 1) {
      throw new Error("Invalid cluster context registry: duplicate names or defaults.");
    }
    this.contexts = Object.freeze(entries);
    this.defaultContext = defaults[0];
    this.#byName = byName;
    Object.freeze(this);
  }

  get(name: string): ClusterContext | undefined {
    return this.#byName.get(name);
  }
}
