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

export async function* runLoop({
  agent,
  model,
  store,
  runId,
  input,
  context,
  signal,
}: {
  agent: Agent;
  model: ModelAdapter;
  store: RunStore;
  runId: string;
  input?: string;
  context?: ContextStrategy;
  signal?: AbortSignal;
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

    const stamped = stampEvent(runStartedEvent, { runId, seq: 1 });
    await store.append(stamped);
    events.push(stamped);
    yield stamped;
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

    let lastSeq = events[events.length - 1]?.seq ?? 0;
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

            lastSeq += 1;
            const stamped = stampEvent(failedEvent, {
              runId,
              seq: lastSeq,
            });
            await store.append(stamped);
            events.push(stamped);
            yield stamped;
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

            lastSeq += 1;
            const stamped = stampEvent(resultEvent, {
              runId,
              seq: lastSeq,
            });
            await store.append(stamped);
            events.push(stamped);
            yield stamped;
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

            lastSeq += 1;
            const stamped = stampEvent(resultEvent, {
              runId,
              seq: lastSeq,
            });
            await store.append(stamped);
            events.push(stamped);
            yield stamped;
            continue;
          }

          // Append tool_started
          const startedEvent: NewEvent = {
            type: "tool_started",
            callId: call.id,
            name: call.name,
            args: call.args,
          };

          lastSeq += 1;
          const startedStamped = stampEvent(startedEvent, {
            runId,
            seq: lastSeq,
          });
          await store.append(startedStamped);
          events.push(startedStamped);
          yield startedStamped;

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

              lastSeq += 1;
              const stamped = stampEvent(resultEvent, {
                runId,
                seq: lastSeq,
              });
              await store.append(stamped);
              events.push(stamped);
              yield stamped;
              continue;
            }
          } catch (error) {
            const resultEvent: NewEvent = {
              type: "tool_result",
              callId: call.id,
              output: error instanceof Error ? error.message : String(error),
              isError: true,
            };

            lastSeq += 1;
            const stamped = stampEvent(resultEvent, {
              runId,
              seq: lastSeq,
            });
            await store.append(stamped);
            events.push(stamped);
            yield stamped;
            continue;
          }

          // Append tool_result
          const resultEvent: NewEvent = {
            type: "tool_result",
            callId: call.id,
            output,
            isError: false,
          };

          lastSeq += 1;
          const resultStamped = stampEvent(resultEvent, {
            runId,
            seq: lastSeq,
          });
          await store.append(resultStamped);
          events.push(resultStamped);
          yield resultStamped;
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

      const stamped = stampEvent(completedEvent, {
        runId,
        seq: lastSeq + 1,
      });
      await store.append(stamped);
      events.push(stamped);
      yield stamped;
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

      const stamped = stampEvent(failedEvent, {
        runId,
        seq: lastSeq + 1,
      });
      await store.append(stamped);
      events.push(stamped);
      yield stamped;
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

    const requestStamped = stampEvent(requestEvent, {
      runId,
      seq: lastSeq + 1,
    });
    await store.append(requestStamped);
    events.push(requestStamped);
    yield requestStamped;

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

      const stamped = stampEvent(failedEvent, {
        runId,
        seq: lastSeq + 2,
      });
      await store.append(stamped);
      events.push(stamped);
      yield stamped;
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

    const respondedStamped = stampEvent(respondedEvent, {
      runId,
      seq: lastSeq + 2,
    });
    await store.append(respondedStamped);
    events.push(respondedStamped);
    yield respondedStamped;
  }
}
