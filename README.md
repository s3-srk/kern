# Kern

Kern is a small TypeScript framework for building tool-using AI agents that you can **audit, pause and resume**.

Each run is stored as an append-only log of typed events. Everything else comes from that log: the run state, the trace you read, the prompt sent to the model, and the point where a paused run continues. Because there is one source of truth, a run can stop to wait for human approval, exit the process, and resume hours later from its file on disk. The log then shows exactly what the model asked for, what policy decided, whether a person approved or rejected it, and what each tool returned.

The kernel stays small on purpose. Model providers, storage, context building and policy each sit behind a narrow interface. Each design choice is written up as an Architecture Decision Record (ADR).

## What Kern gives you

- **Event-sourced runs.** Every step is an immutable event, persisted before it is acted on; run state is derived from the log.
- **Human-in-the-loop approval.** Runs pause before sensitive tool calls and resume as the same run after approval or rejection.
- **Safe handling of interrupted tool calls.** A tool call with no recorded result is never blindly retried.
- **Policy hooks.** Allow, ask or deny tool calls by name pattern; failing hooks deny, and every decision is logged.
- **Typed tools.** Zod-validated tool inputs, with validation errors returned to the model.
- **Provider-agnostic core.** Internal message types with an Anthropic adapter and a deterministic `FakeModel`.
- **Context as a view of the log.** Large tool outputs are truncated in the prompt, never in the log.
- **Inspectable storage.** One JSONL file per run behind a small `RunStore` interface.
- **Plain-loop control flow.** No graph DSL; workflows across runs are ordinary TypeScript.
- **Trace printer and CLI.** run, approve, reject, resume, list and trace commands to start, continue and inspect runs.

## Quickstart

Requires Node 22+.

```bash
npm install
npm test
```

**The test suite does not need an API key and makes no network calls.** The 76 tests cover each part of the kernel (events, store, state derivation, context building, policy, approval and resume), plus end-to-end runs of the agent loop. Tests that involve a model use the scripted `FakeModel`, so the suite is deterministic and runs offline.

The full check used during development:

```bash
npm run typecheck && npm run lint && npm test
```

## Using Kern

```typescript
import { Agent, Runner, tool, Policy } from "kern";
import { z } from "zod";

// findById, setStatus and removeById stand in for your own data-access code.
const lookup = tool({
  name: "lookup",
  description: "Find a record by ID",
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => findById(id),
});

const updateStatus = tool({
  name: "update_status",
  description: "Change a record's status",
  input: z.object({ id: z.string(), status: z.enum(["open", "closed"]) }),
  requiresApproval: true, // pause for a human before this runs
  execute: async ({ id, status }) => setStatus(id, status),
});

const deleteRecord = tool({
  name: "delete_record",
  description: "Permanently delete a record",
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => removeById(id),
});

const agent = new Agent({
  name: "records-agent",
  model: "anthropic:<model-id>",
  instructions: "Use tools when needed, then summarize what you did.",
  tools: [lookup, updateStatus, deleteRecord],
  // Policy blocks any delete tool; the model gets a "Denied by policy" result instead
  hooks: [Policy({ deny: ["*delete*"] })],
});

const runner = new Runner();

// Stream events as they are persisted
for await (const event of runner.stream(agent, "Close record A-17")) {
  console.log(event.seq, event.type);
}

// ...or run to completion or pause, then resume later, even from another process
const state = await runner.run(agent, "Close record A-17");
if (state.status === "paused") {
  const final = await runner.resume(agent, state.runId, {
    decision: { approved: true },
  });
  console.log(final.status, final.output);
}
```

See examples/demo/agent.ts for a complete agent with working tool implementations.

## Demo

The demo agent in `examples/demo/agent.ts` works with a small set of records. It has a read-only `lookup` tool and a write tool that requires approval. A typical request makes the agent look up a record and then try to update it, so the run pauses before the write until a person approves or rejects it.

### Offline demo (no API key)

```bash
npm run demo
```

This runs the full flow with the scripted `FakeModel`: lookup, pause before the write, approval, resume and completion. It then prints the trace, so you can see the whole lifecycle without network access.

### Live demo with the CLI (needs an API key)

The CLI runs the same agent against the real Anthropic API:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
```

1. Start a run. The agent looks up the record, then pauses before the write and prints the run ID.

   ```bash
   npm run kern -- run "Update record A-17" --agent examples/demo/agent.ts
   ```

2. Approve the pending write. The same run resumes and completes.

   ```bash
   npm run kern -- approve <runId> --agent examples/demo/agent.ts
   ```

   Or reject it instead. The rejection is returned to the model as a tool error, so the agent can respond to it.

   ```bash
   npm run kern -- reject <runId> --agent examples/demo/agent.ts
   ```

3. Print the full history, including the pause, the decision and the resumed steps.

   ```bash
   npm run kern -- trace <runId>
   ```

The raw events are in `runs/<runId>.jsonl`.

## Design

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): core concepts, components, run lifecycle and public API.
- [docs/ADRS.md](docs/ADRS.md): nine design decisions with their context, alternatives and trade-offs.
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md): known limitations and deferred work.

## Development approach

**Coding agent:** Claude Code

**Scope and Spec first.** Decided on architecture, scope and design before writing code. Set the roadmap with five broad phases; the steps within each phase were planned only when that phase began, so each plan built on what already existed.
**One step at a time.** Set the rules in CLAUDE.md: one step per session, stop and ask if code and spec disagree.
**Maintained Progress log.** At the end of each step, Claude Code summarised the changes and decisions made, and I recorded them in a progress file that informed the next step.
**Testing.** Each step added focused tests for the critical paths the demo depends on, and CLAUDE.md required npm run typecheck, npm run lint and npm test to pass before a step counted as done.
