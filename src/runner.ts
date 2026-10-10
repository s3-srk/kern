import { randomBytes } from "node:crypto";
import type { Agent } from "./agent.js";
import type { ModelAdapter } from "./messages.js";
import { type RunStore, JsonlRunStore } from "./store.js";
import type { ContextStrategy } from "./context.js";
import type { KernEvent } from "./events.js";
import { deriveState, type RunState } from "./state.js";
import { runLoop } from "./loop.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";

function generateRunId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const randomPart = randomBytes(2).toString("hex");

  return `run-${year}${month}${day}-${hours}${minutes}${seconds}-${randomPart}`;
}

export interface RunnerOptions {
  store?: RunStore;
  runsDir?: string;
  models?: ModelAdapter[];
  context?: ContextStrategy;
}

export class Runner {
  private store: RunStore;
  private models: Map<string, ModelAdapter>;
  private context?: ContextStrategy;

  constructor(options?: RunnerOptions) {
    // Validate: can't provide both store and runsDir
    if (options?.store && options?.runsDir) {
      throw new Error(
        "Cannot provide both store and runsDir; provide one or neither"
      );
    }

    // Set up store
    if (options?.store) {
      this.store = options.store;
    } else {
      const runsDir = options?.runsDir ?? "runs";
      this.store = new JsonlRunStore(runsDir);
    }

    // Set up models map and check for duplicates
    this.models = new Map();
    if (options?.models) {
      for (const model of options.models) {
        if (this.models.has(model.provider)) {
          throw new Error(
            `Duplicate model adapter for provider "${model.provider}"`
          );
        }
        this.models.set(model.provider, model);
      }
    } else {
      // Register default adapters when models is omitted
      this.models.set("anthropic", new AnthropicAdapter());
    }

    this.context = options?.context;
  }

  async *stream(
    agent: Agent,
    input: string,
    opts?: { runId?: string; signal?: AbortSignal }
  ): AsyncGenerator<KernEvent> {
    // Extract provider from agent.model (format: "provider:id")
    const [provider] = agent.model.split(":");

    // Resolve the adapter
    const model = this.models.get(provider);
    if (!model) {
      throw new Error(
        `No model adapter registered for provider "${provider}"`
      );
    }

    // Generate or validate runId
    const runId = opts?.runId ?? generateRunId();

    // Check if run already exists
    let existingEvents: KernEvent[] = [];
    try {
      existingEvents = await this.store.read(runId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Run not found")
      ) {
        // Good - this is a new run
      } else {
        throw new Error("Failed to check for existing run", { cause: error });
      }
    }

    if (existingEvents.length > 0) {
      throw new Error(
        `Run ${runId} already exists; resuming is not yet supported`
      );
    }

    // Delegate to runLoop and re-yield events unchanged
    yield* runLoop({
      agent,
      model,
      store: this.store,
      runId,
      input,
      context: this.context,
      signal: opts?.signal,
    });
  }

  async run(
    agent: Agent,
    input: string,
    opts?: { runId?: string; signal?: AbortSignal }
  ): Promise<RunState> {
    const events: KernEvent[] = [];
    for await (const event of this.stream(agent, input, opts)) {
      events.push(event);
    }
    return deriveState(events);
  }
}
