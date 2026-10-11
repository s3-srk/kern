import { KernEvent } from "./events.js";
import { deriveState } from "./state.js";

export interface FormatTraceOptions {
  maxValueChars?: number;
}

function formatPreview(value: unknown, maxChars: number): string {
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else {
    str = JSON.stringify(value);
  }

  str = str.replace(/\s+/g, " ");

  if (str.length > maxChars) {
    return str.slice(0, maxChars) + "…";
  }
  return str;
}

function padType(type: string): string {
  const types = [
    "run_started",
    "model_requested",
    "model_responded",
    "tool_started",
    "tool_result",
    "policy_decided",
    "run_paused",
    "approval_decided",
    "run_resumed",
    "run_completed",
    "run_failed",
  ];
  const maxLen = Math.max(...types.map((t) => t.length));
  return type.padEnd(maxLen);
}

export function formatTrace(
  events: readonly KernEvent[],
  opts?: FormatTraceOptions
): string {
  const maxValueChars = opts?.maxValueChars ?? 120;

  const state = deriveState([...events]);
  const startTs = new Date(events[0].ts).getTime();

  const lines: string[] = [];

  for (const event of events) {
    const eventTs = new Date(event.ts).getTime();
    const elapsed = (eventTs - startTs) / 1000;
    const timeStr = elapsed.toFixed(3).padStart(7);
    const paddedType = padType(event.type);

    let details = "";

    switch (event.type) {
      case "run_started":
        details = `agent=${event.agentName} model=${event.model} input=${formatPreview(event.input, maxValueChars)}`;
        break;

      case "model_requested":
        details = `step=${event.step} messageCount=${event.messageCount}`;
        break;

      case "model_responded": {
        const toolNames = event.toolCalls.map((c) => `${c.name}(${c.id})`).join(" ");
        const textPreview = formatPreview(event.text, maxValueChars);
        details = `step=${event.step} stopReason=${event.stopReason} usage=${event.usage.inputTokens}/${event.usage.outputTokens} text=${textPreview}`;
        if (toolNames) {
          details += ` tools=${toolNames}`;
        }
        break;
      }

      case "tool_started":
        details = `tool=${event.name} callId=${event.callId} input=${formatPreview(event.args, maxValueChars)}`;
        break;

      case "tool_result":
        details = `callId=${event.callId} ${event.isError ? "error" : "ok"} output=${formatPreview(event.output, maxValueChars)}`;
        break;

      case "policy_decided":
        details = `callId=${event.callId} decision=${event.decision} source=${event.source}`;
        break;

      case "run_paused": {
        const pendingCall = state.pending?.call;
        const toolName = pendingCall?.name ?? "?";
        details = `pending=${toolName}(${event.callId})`;
        break;
      }

      case "approval_decided":
        details = `callId=${event.callId} ${event.approved ? "approved" : "rejected"}`;
        break;

      case "run_resumed":
        break;

      case "run_completed":
        details = `output=${formatPreview(event.output, maxValueChars)}`;
        break;

      case "run_failed":
        details = `error=${event.error.code} ${event.error.message}`;
        break;

      default: {
        const _exhaustive: never = event;
        throw new Error(`Unhandled event type: ${_exhaustive}`);
      }
    }

    const line = `#${event.seq} +${timeStr}s ${paddedType} ${details}`.trimEnd();
    lines.push(line);
  }

  let summary = `status=${state.status} steps=${state.steps}`;

  if (state.pending) {
    summary += ` pending=${state.pending.call.name}(${state.pending.call.id})`;
  }

  if (state.error) {
    summary += ` error=${formatPreview(state.error.message, maxValueChars)}`;
  }

  lines.push(summary);

  return lines.join("\n");
}
