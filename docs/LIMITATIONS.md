# Limitations and deferred work

Kern was built as a time-boxed project with a deliberately narrow scope. These are the limitations worth knowing about. Most are deferrals that the existing interfaces already allow for, not design gaps.

## Deferred features

| Feature               | Where it would fit                                             |
| --------------------- | -------------------------------------------------------------- |
| MCP tool integration  | Wrapped behind the existing `Tool` interface                   |
| Sub-agents            | A child run with its own log, exposed as a tool                |
| Other model providers | A new `ModelAdapter` per provider; only Anthropic is included  |
| Database storage      | A new `RunStore` implementation; only JSONL is included        |
| Context compaction    | A new `ContextStrategy`; only tool outputs are truncated today |

## Recovery and side effects

- **Interrupted tool calls always need manual review.** No tool can yet be declared idempotent, so a call with `tool_started` but no `tool_result` fails the run instead of being retried
- **No exactly-once guarantee.** Writing each event before acting gives traceability, not exactly-once execution of external side effects.

## Storage

- **JSONL survives process crashes, not power loss.** Appends are not fsync'd.
- **Single process only.** The JSONL store does not support concurrent writers to the same run.

## Approvals

- **One pending approval at a time, and each decision covers one call.** There is no "always allow this tool" option.
- **Approvals carry no identity.** The log records the decision, not who made it.
- **Approval rules are per tool, not per input.** `requiresApproval` is a fixed flag; input-dependent rules need a policy hook.

## Execution

- **Tool calls in one turn run sequentially.** There is no parallel execution.
