import {
  KernEvent,
  stampEvent,
  type ModelRespondedEvent,
  type NewEvent,
} from "./events.js";
import { type Agent } from "./agent.js";
import { type ModelAdapter, type ModelRequest } from "./messages.js";
import { type RunStore } from "./store.js";
import { deriveState } from "./state.js";
import { type ContextStrategy, truncatingContext } from "./context.js";
import { validateToolInput, toToolSpec } from "./tools.js";
import { resolvePolicy } from "./hooks.js";

async function appendAndYield(
  store: RunStore,
  events: KernEvent[],
  newEvent: NewEvent,
  runId: string,
  hooks: Array<{ onEvent?: (e: KernEvent) => void | Promise<void> }>
): Promise<KernEvent> {
  const lastSeq = events[events.length - 1]?.seq ?? 0;
  const stamped = stampEvent(newEvent, {
    runId,
    seq: lastSeq + 1,
  });
  await store.append(stamped);
  events.push(stamped);

  for (const hook of hooks) {
    if (hook.onEvent) {
      try {
        await hook.onEvent(stamped);
      } catch {
        // Ignore onEvent errors
      }
    }
  }

  return stamped;
}

export async function* runLoop({
  agent,
  model,
  store,
  runId,
  input,
  context,
  signal,
  decision,
}: {
  agent: Agent;
  model: ModelAdapter;
  store: RunStore;
  runId: string;
  input?: string;
  context?: ContextStrategy;
  signal?: AbortSignal;
  decision?: { approved: boolean; reason?: string };
}): AsyncGenerator<KernEvent> {
  const contextStrategy = context ?? truncatingContext();

  // Read existing events for this run
  let events: KernEvent[] = [];
  try {
    events = await store.read(runId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Run not found")
    ) {
      // New run
      if (!input) {
        throw new Error("input is required for a new run", { cause: error });
      }
    } else {
      throw new Error("Failed to read run from store", { cause: error });
    }
  }

  // If no events, start a new run
  if (events.length === 0) {
    if (!input) {
      throw new Error("input is required for a new run");
    }

    const runStartedEvent: NewEvent = {
      type: "run_started",
      agentName: agent.name,
      model: agent.model,
      instructions: agent.instructions,
      input,
    };

    const event = await appendAndYield(
      store,
      events,
      runStartedEvent,
      runId,
      agent.hooks
    );
    yield event;
  } else {
    // Existing run - handle decision if provided
    if (decision) {
      const state = deriveState(events);
      if (state.status !== "paused" || !state.pending) {
        throw new Error("Run is not paused or has no pending call");
      }

      const event = await appendAndYield(
        store,
        events,
        {
          type: "approval_decided",
          callId: state.pending.call.id,
          approved: decision.approved,
          reason: decision.reason,
        },
        runId,
        agent.hooks
      );
      yield event;

      // Append run_resumed after decision
      const resumeEvent = await appendAndYield(
        store,
        events,
        { type: "run_resumed" },
        runId,
        agent.hooks
      );
      yield resumeEvent;
    }
  }

  // Main loop
  while (true) {
    if (signal?.aborted) {
      throw new Error("Loop aborted");
    }

    const state = deriveState(events);

    // Check for terminal state
    if (state.status === "completed" || state.status === "failed") {
      return;
    }

    // Check for paused state with no approval_decided yet
    if (state.status === "paused" && state.pending) {
      const lastEvent = events[events.length - 1];
      if (lastEvent?.type === "run_paused") {
        return;
      }
    }

    let lastModelResponse: ModelRespondedEvent | null = null;

    // Find the last model_responded event
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "model_responded") {
        lastModelResponse = events[i] as ModelRespondedEvent;
        break;
      }
    }

    // If last model_responded has toolCalls without a tool_result, process them
    if (lastModelResponse && lastModelResponse.toolCalls.length > 0) {
      let hasUnprocessedCalls = false;

      for (const call of lastModelResponse.toolCalls) {
        // Check if this call already has a result
        const hasResult = events.some(
          (e) =>
            e.type === "tool_result" &&
            "callId" in e &&
            (e.callId === call.id)
        );

        if (!hasResult) {
          hasUnprocessedCalls = true;

          // Check if tool_started exists but no tool_result
          const hasStarted = events.some(
            (e) =>
              e.type === "tool_started" &&
              "callId" in e &&
              (e.callId === call.id)
          );

          if (hasStarted) {
            // ADR-003: uncertain outcome, tool not idempotent
            const failedEvent: NewEvent = {
              type: "run_failed",
              error: {
                message: `uncertain outcome for call ${call.id} (${call.name}); tool not idempotent, manual review required`,
                code: "uncertain_tool_outcome",
              },
            };

            const event = await appendAndYield(
              store,
              events,
              failedEvent,
              runId,
              agent.hooks
            );
            yield event;
            return;
          }

          // Find the tool in agent.tools
          const tool = agent.tools.find((t) => t.name === call.name);

          if (!tool) {
            // Unknown tool
            const resultEvent: NewEvent = {
              type: "tool_result",
              callId: call.id,
              output: null,
              isError: true,
            };

            const event = await appendAndYield(
              store,
              events,
              resultEvent,
              runId,
              agent.hooks
            );
            yield event;
            continue;
          }

          // Validate input
          const validation = validateToolInput(tool, call.args);

          if (!validation.ok) {
            // Validation error
            const resultEvent: NewEvent = {
              type: "tool_result",
              callId: call.id,
              output: validation.error,
              isError: true,
            };

            const event = await appendAndYield(
              store,
              events,
              resultEvent,
              runId,
              agent.hooks
            );
            yield event;
            continue;
          }

          // Check if approval_decided exists for this call
          const approvalEvent = events.find(
            (e) =>
              e.type === "approval_decided" &&
              "callId" in e &&
              e.callId === call.id
          );

          let approved: boolean;
          let approvalReason: string | undefined;

          if (approvalEvent && approvalEvent.type === "approval_decided") {
            approved = approvalEvent.approved;
            approvalReason = approvalEvent.reason;
          } else {
            // Apply policy if no approval decision
            const policyResult = await resolvePolicy(agent.hooks, {
              runId,
              call,
              tool,
              input: validation.data,
            }, tool.requiresApproval);

            const policyDecidedEvent = await appendAndYield(
              store,
              events,
              {
                type: "policy_decided",
                callId: call.id,
                decision: policyResult.decision,
                reason: policyResult.reason,
                source: policyResult.source,
              },
              runId,
              agent.hooks
            );
            yield policyDecidedEvent;

            // Handle policy decision
            if (policyResult.decision === "deny") {
              const resultEvent: NewEvent = {
                type: "tool_result",
                callId: call.id,
                output: `Denied by policy: ${policyResult.reason || "denied"}`,
                isError: true,
              };

              const event = await appendAndYield(
                store,
                events,
                resultEvent,
                runId,
                agent.hooks
              );
              yield event;
              continue;
            }

            if (policyResult.decision === "ask") {
              const pauseEvent = await appendAndYield(
                store,
                events,
                {
                  type: "run_paused",
                  reason: "approval",
                  callId: call.id,
                },
                runId,
                agent.hooks
              );
              yield pauseEvent;
              return;
            }

            approved = true;
          }

          // Handle approval decision if it came from approval_decided
          if (approved === false) {
            const resultEvent: NewEvent = {
              type: "tool_result",
              callId: call.id,
              output: `Rejected by user: ${approvalReason || "no reason"}`,
              isError: true,
            };

            const event = await appendAndYield(
              store,
              events,
              resultEvent,
              runId,
              agent.hooks
            );
            yield event;
            continue;
          }

          // approved is true (from policy "allow" or approval_decided approved), continue with execution

          // Append tool_started
          const startedEvent: NewEvent = {
            type: "tool_started",
            callId: call.id,
            name: call.name,
            args: call.args,
          };

          const started = await appendAndYield(
            store,
            events,
            startedEvent,
            runId,
            agent.hooks
          );
          yield started;

          // Execute tool
          let output: unknown;
          try {
            output = await tool.execute(validation.data, {
              runId,
              callId: call.id,
              signal,
            });

            // Handle undefined output → null
            if (output === undefined) {
              output = null;
            }

            // Check if output is JSON-serializable
            try {
              JSON.stringify(output);
            } catch {
              const resultEvent: NewEvent = {
                type: "tool_result",
                callId: call.id,
                output: "tool output is not JSON-serializable",
                isError: true,
              };

              const event = await appendAndYield(
                store,
                events,
                resultEvent,
                runId,
                agent.hooks
              );
              yield event;
              continue;
            }
          } catch (error) {
            const resultEvent: NewEvent = {
              type: "tool_result",
              callId: call.id,
              output: error instanceof Error ? error.message : String(error),
              isError: true,
            };

            const event = await appendAndYield(
              store,
              events,
              resultEvent,
              runId,
              agent.hooks
            );
            yield event;
            continue;
          }

          // Append tool_result
          const resultEvent: NewEvent = {
            type: "tool_result",
            callId: call.id,
            output,
            isError: false,
          };

          const event = await appendAndYield(
            store,
            events,
            resultEvent,
            runId,
            agent.hooks
          );
          yield event;
        }
      }

      if (!hasUnprocessedCalls) {
        // All calls have been processed, continue to next iteration
        continue;
      }
    }

    // If last model_responded has no toolCalls, run is completed
    if (lastModelResponse && lastModelResponse.toolCalls.length === 0) {
      const completedEvent: NewEvent = {
        type: "run_completed",
        output: lastModelResponse.text,
      };

      const event = await appendAndYield(
        store,
        events,
        completedEvent,
        runId,
        agent.hooks
      );
      yield event;
      return;
    }

    // Otherwise, call the model
    const derivedState = deriveState(events);

    if (derivedState.steps >= agent.maxSteps) {
      const failedEvent: NewEvent = {
        type: "run_failed",
        error: {
          message: `max steps (${agent.maxSteps}) reached`,
          code: "max_steps",
        },
      };

      const event = await appendAndYield(
        store,
        events,
        failedEvent,
        runId,
        agent.hooks
      );
      yield event;
      return;
    }

    // Build context
    const contextView = contextStrategy.build(events);

    // Get model ID from agent.model (format: "provider:id")
    const [agentModelProvider, modelId] = agent.model.split(":");

    if (model.provider !== agentModelProvider) {
      throw new Error(
        `Model provider mismatch: agent requires "${agentModelProvider}", got "${model.provider}"`
      );
    }

    // Build request
    const toolSpecs = agent.tools.map(toToolSpec);

    const request: ModelRequest = {
      model: modelId,
      system: contextView.system,
      messages: contextView.messages,
      tools: toolSpecs,
    };

    // Append model_requested
    const requestEvent: NewEvent = {
      type: "model_requested",
      step: derivedState.steps + 1,
      messageCount: contextView.messages.length,
    };

    const req = await appendAndYield(
      store,
      events,
      requestEvent,
      runId,
      agent.hooks
    );
    yield req;

    // Call model
    let modelResponse;
    try {
      modelResponse = await model.generate(request, { signal });
    } catch (error) {
      const failedEvent: NewEvent = {
        type: "run_failed",
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "model_error",
        },
      };

      const event = await appendAndYield(
        store,
        events,
        failedEvent,
        runId,
        agent.hooks
      );
      yield event;
      return;
    }

    // Append model_responded
    const respondedEvent: NewEvent = {
      type: "model_responded",
      step: derivedState.steps + 1,
      text: modelResponse.text,
      toolCalls: modelResponse.toolCalls,
      usage: modelResponse.usage,
      stopReason: modelResponse.stopReason,
      raw: modelResponse.raw,
    };

    const event = await appendAndYield(
      store,
      events,
      respondedEvent,
      runId,
      agent.hooks
    );
    yield event;
  }
}
