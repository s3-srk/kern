import { describe, it, expect } from "vitest";
import { stampEvent, truncatingContext } from "../src/index.js";

describe("truncatingContext", () => {
  it("builds context with system, user, assistant, and tool messages", () => {
    const strategy = truncatingContext();

    const events = [
      stampEvent(
        {
          type: "run_started",
          agentName: "test-agent",
          model: "anthropic:claude-3-sonnet",
          instructions: "Be a helpful assistant",
          input: "Look up record A-17",
        },
        { runId: "run-1", seq: 1 }
      ),
      stampEvent(
        {
          type: "model_responded",
          step: 1,
          text: "I'll look that up",
          toolCalls: [
            { id: "call-1", name: "lookup", args: { id: "A-17" } },
            { id: "call-2", name: "verify", args: { id: "A-17" } },
          ],
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: "tool_use",
        },
        { runId: "run-1", seq: 2 }
      ),
      stampEvent(
        {
          type: "policy_decided",
          callId: "call-1",
          decision: "allow",
        },
        { runId: "run-1", seq: 3 }
      ),
      stampEvent(
        {
          type: "tool_started",
          callId: "call-1",
          name: "lookup",
          args: { id: "A-17" },
        },
        { runId: "run-1", seq: 4 }
      ),
      stampEvent(
        {
          type: "tool_started",
          callId: "call-2",
          name: "verify",
          args: { id: "A-17" },
        },
        { runId: "run-1", seq: 5 }
      ),
      stampEvent(
        {
          type: "tool_result",
          callId: "call-1",
          output: { status: "found" },
          isError: false,
        },
        { runId: "run-1", seq: 6 }
      ),
      stampEvent(
        {
          type: "tool_result",
          callId: "call-2",
          output: { verified: true },
          isError: false,
        },
        { runId: "run-1", seq: 7 }
      ),
      stampEvent(
        {
          type: "model_responded",
          step: 2,
          text: "Record A-17 is verified and active.",
          toolCalls: [],
          usage: { inputTokens: 200, outputTokens: 30 },
          stopReason: "end_turn",
        },
        { runId: "run-1", seq: 8 }
      ),
    ];

    const context = strategy.build(events);

    expect(context.system).toBe("Be a helpful assistant");
    expect(context.messages).toHaveLength(4);

    // User message
    expect(context.messages[0]).toEqual({
      role: "user",
      text: "Look up record A-17",
    });

    // First assistant message with 2 tool calls
    expect(context.messages[1]).toEqual({
      role: "assistant",
      text: "I'll look that up",
      toolCalls: [
        { id: "call-1", name: "lookup", args: { id: "A-17" } },
        { id: "call-2", name: "verify", args: { id: "A-17" } },
      ],
      raw: undefined,
    });

    // Tool results message (single combined message)
    expect(context.messages[2].role).toBe("tool");
    if (context.messages[2].role === "tool") {
      expect(context.messages[2].results).toHaveLength(2);
      expect(context.messages[2].results[0]).toEqual({
        callId: "call-1",
        output: { status: "found" },
        isError: false,
      });
      expect(context.messages[2].results[1]).toEqual({
        callId: "call-2",
        output: { verified: true },
        isError: false,
      });
    }

    // Second assistant message (final)
    expect(context.messages[3]).toEqual({
      role: "assistant",
      text: "Record A-17 is verified and active.",
      toolCalls: [],
      raw: undefined,
    });
  });

  it("truncates large tool outputs but not model text; does not mutate input", () => {
    const strategy = truncatingContext({ maxToolOutputChars: 20 });

    const largeOutput = "x".repeat(50);
    const largeText = "y".repeat(100);

    const events = [
      stampEvent(
        {
          type: "run_started",
          agentName: "test-agent",
          model: "anthropic:claude-3-sonnet",
          instructions: "Test",
          input: "Test",
        },
        { runId: "run-1", seq: 1 }
      ),
      stampEvent(
        {
          type: "model_responded",
          step: 1,
          text: largeText,
          toolCalls: [{ id: "call-1", name: "tool", args: {} }],
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        },
        { runId: "run-1", seq: 2 }
      ),
      stampEvent(
        {
          type: "tool_result",
          callId: "call-1",
          output: largeOutput,
          isError: false,
        },
        { runId: "run-1", seq: 3 }
      ),
    ];

    const eventsCopy = JSON.parse(JSON.stringify(events));
    const context = strategy.build(events);

    // Check that events are not mutated
    expect(events).toEqual(eventsCopy);

    // Check that model text is not truncated
    const assistantMsg = context.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.text).toBe(largeText);

    // Check that tool output is truncated
    const toolMsg = context.messages.find((m) => m.role === "tool");
    if (toolMsg && toolMsg.role === "tool") {
      const truncated = toolMsg.results[0].output;
      expect(typeof truncated).toBe("string");
      if (typeof truncated === "string") {
        expect(truncated).toContain("[truncated:");
        expect(truncated.startsWith("x".repeat(20))).toBe(true);
      }
    }
  });

  it("throws if assistant tool call has no matching tool_result", () => {
    const strategy = truncatingContext();

    const events = [
      stampEvent(
        {
          type: "run_started",
          agentName: "test-agent",
          model: "anthropic:claude-3-sonnet",
          instructions: "Test",
          input: "Test",
        },
        { runId: "run-1", seq: 1 }
      ),
      stampEvent(
        {
          type: "model_responded",
          step: 1,
          text: "I will look that up",
          toolCalls: [{ id: "call-1", name: "lookup", args: {} }],
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        },
        { runId: "run-1", seq: 2 }
      ),
    ];

    expect(() => {
      strategy.build(events);
    }).toThrow(/call-1.*lookup.*no matching tool_result/);
  });
});
