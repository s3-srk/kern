import type { KernEvent, RunStartedEvent } from "./events.js";
import type { Message } from "./messages.js";

export interface ContextStrategy {
  readonly name: string;
  build(events: KernEvent[]): { system?: string; messages: Message[] };
}

export function truncatingContext(
  options?: { maxToolOutputChars?: number }
): ContextStrategy {
  const maxToolOutputChars = options?.maxToolOutputChars ?? 8000;

  return {
    name: "truncate",
    build(events: KernEvent[]) {
      if (events.length === 0) {
        throw new Error("events must not be empty");
      }

      const firstEvent = events[0];
      if (firstEvent.type !== "run_started") {
        throw new Error("First event must be run_started");
      }

      const runStarted = firstEvent as RunStartedEvent;
      const messages: Message[] = [];
      const system = runStarted.instructions;

      // Track tool calls and results
      const callIds = new Map<string, string>(); // callId -> toolName
      const toolResults = new Map<string, boolean>(); // callId -> hasResult

      const currentToolResults: Map<string, unknown> = new Map();

      for (let i = 1; i < events.length; i++) {
        const event = events[i];

        if (event.type === "model_responded") {
          // Add any accumulated tool results before this assistant message
          if (currentToolResults.size > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const resultList: any[] = [];
            for (const [callId, output] of currentToolResults.entries()) {
              const isError = false;
              resultList.push({ callId, output, isError });
            }
            messages.push({
              role: "tool",
              results: resultList,
            });
            currentToolResults.clear();
          }

          // Track tool calls in this response
          for (const call of event.toolCalls) {
            callIds.set(call.id, call.name);
            toolResults.set(call.id, false);
          }

          // Add assistant message
          messages.push({
            role: "assistant",
            text: event.text,
            toolCalls: event.toolCalls,
            raw: event.raw,
          });
        } else if (event.type === "tool_result") {
          if (!callIds.has(event.callId)) {
            throw new Error(
              `tool_result references call id "${event.callId}" with no matching tool call`
            );
          }

          toolResults.set(event.callId, true);

          // Truncate if needed
          let output = event.output;
          if (typeof output === "string") {
            if (output.length > maxToolOutputChars) {
              output =
                output.substring(0, maxToolOutputChars) +
                `\n[truncated: showing ${maxToolOutputChars} of ${output.length} chars]`;
            }
          } else {
            const jsonStr = JSON.stringify(output);
            if (jsonStr.length > maxToolOutputChars) {
              output =
                jsonStr.substring(0, maxToolOutputChars) +
                `\n[truncated: showing ${maxToolOutputChars} of ${jsonStr.length} chars]`;
            }
          }

          currentToolResults.set(event.callId, output);
        }
      }

      // Add any remaining tool results
      if (currentToolResults.size > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resultList: any[] = [];
        for (const [callId, output] of currentToolResults.entries()) {
          const isError = false;
          resultList.push({ callId, output, isError });
        }
        messages.push({
          role: "tool",
          results: resultList,
        });
      }

      // Check for unmatched tool calls
      for (const [callId, hasResult] of toolResults.entries()) {
        if (!hasResult) {
          const toolName = callIds.get(callId) || "unknown";
          throw new Error(
            `tool call ${callId} (${toolName}) has no matching tool_result`
          );
        }
      }

      // Add first user message if not already added
      if (messages.length === 0 || messages[0].role !== "user") {
        messages.unshift({
          role: "user",
          text: runStarted.input,
        });
      }

      return { system, messages };
    },
  };
}
