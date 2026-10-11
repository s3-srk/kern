# Kern — Architecture Decision Records

Oct 9, 2026 · @srk

These records capture the reasoning behind the design, including decisions that are planned but will not fit into the current build. **“Accepted” means the design choice is intentional; it does not mean every related feature is implemented in the demo.**

## Index

| ADR | Decision                                  | Status   | Current build                               |
| --- | ----------------------------------------- | -------- | ------------------------------------------- |
| 001 | Model-driven loop, not a graph DSL        | Accepted | Core loop                                   |
| 002 | Event-sourced run state                   | Accepted | JSONL event log and derived state           |
| 003 | Replay and idempotency semantics          | Accepted | Approval resume only; crash replay deferred |
| 004 | Internal message types and model adapters | Accepted | Anthropic + FakeModel                       |
| 005 | Agents as tools, not handoffs             | Accepted | Deferred; single-agent demo                 |
| 006 | Hooks observe and veto only               | Accepted | Basic allow/ask/deny policy                 |
| 007 | MCP for tool interoperability             | Accepted | Deferred; local tools only                  |
| 008 | JSONL behind a `RunStore` interface       | Accepted | JSONL implementation                        |
| 009 | Context is a view of the log              | Accepted | Basic truncation; compaction deferred       |

## ADR-001: Model-driven loop, not a graph DSL

**Context.** A graph DSL adds another programming model and more machinery to maintain. For this framework, a straightforward loop is easier to understand and test.

**Decision.** The model chooses the next step within a run. Deterministic workflows across runs stay in ordinary TypeScript.

**Trade-off.** We give up graph visualization and workflow-node checkpoints. A workflow layer can be added later without changing the core runner.

## ADR-002: Event-sourced run state

**Context.** Separate state, trace and approval mechanisms can drift apart and make failures harder to debug.

**Decision.** Each run is an append-only sequence of typed events. `deriveState(events)` reconstructs its state. Persist complete events; stream token deltas without writing them to disk.

**Trade-off.** The log gives us one history for state and tracing, but event schemas need versioning and logs grow over time. Replay must account for side effects (ADR-003).

## ADR-003: Replay and idempotency semantics

**Context.** If a process stops after a tool has acted but before its result is saved, blindly retrying can repeat a side effect.

**Decision.** Reuse recorded model responses and tool results. Record `tool_started` before execution. On recovery, a started call with no result is uncertain: retry it only when the tool is declared idempotent; otherwise ask for human review. Calls not yet started can be executed after policy and approval checks.

**Alternatives considered.** Always retrying risks duplicate actions; never retrying can leave work incomplete. External idempotency keys are a stronger option, but require support from each tool.

**Current scope.** The policy is designed now, but automatic crash recovery is deferred. The demo will prove pause/resume for an explicit approval, not exactly-once execution or safe recovery from every crash window.

## ADR-004: Internal message types and model adapters

**Context.** The core should not depend on one provider's message format, but a unified SDK can hide provider-specific details.

**Decision.** Use internal `Message`, `ToolCall`, `ToolResult` and `Usage` types. Each provider adapter translates to and from them and can retain raw provider blocks when needed.

**Trade-off.** Each new provider needs an adapter, but provider-specific features remain accessible. The demo starts with Anthropic and a `FakeModel`; another provider is deferred.

## ADR-005: Agents as tools, not handoffs

**Context.** Handoffs and group-chat patterns introduce more control-flow and shared-history rules. A sub-agent used as a tool has a clearer boundary.

**Decision.** `agent.asTool()` runs a child agent with its own log and context. The parent receives the child's final result; approval and budget accounting are intended to propagate to the root run.

**Trade-off.** This keeps contexts separate and runs traceable, but adds lifecycle complexity. Sub-agents are deferred from the demo; the first version runs one agent. Handoffs can be added later as a separate control-flow feature.

## ADR-006: Hooks observe and veto only

**Context.** Hooks are useful for policy and tracing, but allowing them to rewrite arguments or messages makes execution harder to audit.

**Decision.** Hooks can observe events and return `allow`, `ask` or `deny`. The loop records the decision. Hooks do not modify events, messages or tool arguments in v1.

**Trade-off.** The log remains a faithful record of what the model requested and how policy responded. Rewriting, redaction and argument repair need an explicit design later.The cost is control: hooks cannot redact sensitive data, repair malformed arguments or constrain a call

## ADR-007: MCP for tool interoperability

**Context.** MCP provides a shared way to expose tools, so Kern should not invent a competing protocol.

**Decision.** Use the official MCP client to discover server tools and wrap them in the same interface as local tools. Start with stdio transport.

**Trade-off.** This avoids maintaining custom integrations, but adds connection and schema-handling work. MCP is deferred from the current build; local typed tools will demonstrate the same core tool contract. HTTP transport, resources and prompts can follow later. MCP tools default to non-idempotent unless explicitly configured otherwise (ADR-003).

## ADR-008: JSONL behind a `RunStore` interface

**Context.** The demo needs durable, inspectable events without spending its limited build time on database setup.

**Decision.** Define a small `RunStore` interface (`append`, `read`, `list`) and use one JSONL file per run.

**Trade-off.** Files are easy to inspect and need no database service, but this implementation is single-process and has limited query/concurrency support. SQLite or Postgres can be added behind the same interface later.

## ADR-009: Context is a view of the log

**Context.** Long tool outputs can overwhelm the model's context. Editing the stored history to save tokens would make the audit trail incomplete.

**Decision.** Build model input through a `ContextStrategy`. The initial strategy truncates large tool outputs in the prompt while keeping the full event in the log.

**Trade-off.** The model sees a smaller view without losing stored history. Smarter compaction is deferred; when introduced, its summary should itself be recorded as an event.
