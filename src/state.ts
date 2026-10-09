import { KernEvent, ToolCall } from "./events.js";

export interface RunState {
  runId: string;
  status: "running" | "paused" | "completed" | "failed";
  steps: number;
  pending?: {
    call: ToolCall;
    approved?: boolean;
  };
  output?: string;
  error?: {
    message: string;
    code: string;
  };
  lastSeq: number;
}

export function deriveState(events: KernEvent[]): RunState {
  if (events.length === 0) {
    throw new Error("Cannot derive state from empty event list");
  }

  const first = events[0];
  if (first.type !== "run_started") {
    throw new Error("First event must be run_started");
  }

  const state: RunState = {
    runId: first.runId,
    status: "running",
    steps: 0,
    lastSeq: first.seq,
  };

  const toolCallsById = new Map<string, ToolCall>();

  for (const event of events) {
    state.lastSeq = event.seq;

    switch (event.type) {
      case "run_started":
        break;

      case "model_requested":
        break;

      case "model_responded":
        state.steps += 1;
        for (const call of event.toolCalls) {
          toolCallsById.set(call.id, call);
        }
        break;

      case "tool_started":
        break;

      case "tool_result":
        break;

      case "policy_decided":
        break;

      case "run_paused": {
        state.status = "paused";
        const pausedCallId = event.callId;
        const pausedCall = toolCallsById.get(pausedCallId);
        if (!pausedCall) {
          throw new Error(
            `Tool call ${pausedCallId} not found in model_responded events`
          );
        }
        state.pending = { call: pausedCall };
        break;
      }

      case "approval_decided":
        if (state.pending) {
          state.pending.approved = event.approved;
        }
        break;

      case "run_resumed":
        state.status = "running";
        state.pending = undefined;
        break;

      case "run_completed":
        state.status = "completed";
        state.output = event.output;
        state.pending = undefined;
        break;

      case "run_failed":
        state.status = "failed";
        state.error = event.error;
        state.pending = undefined;
        break;

      default: {
        const _exhaustive: never = event;
        throw new Error(`Unhandled event type: ${_exhaustive}`);
      }
    }
  }

  return state;
}
