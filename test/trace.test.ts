import { describe, it, expect } from "vitest";
import { formatTrace } from "../src/trace.js";
import type { KernEvent } from "../src/events.js";
import { deepEqual } from "assert";

describe("formatTrace", () => {
  const baseTime = new Date("2026-10-10T12:00:00Z");
  const baseTimeMs = baseTime.getTime();

  function makeEvent(
    override: Partial<KernEvent> & { type: KernEvent["type"] }
  ): KernEvent {
    const baseSeq = override.seq ?? 1;
    const baseTs = new Date(baseTimeMs + (override.seq ?? 1) * 1000).toISOString();
    return {
      v: 1,
      seq: baseSeq,
      runId: "run-test",
      ts: override.ts ?? baseTs,
      ...override,
    } as KernEvent;
  }

  it("completes with one tool call", () => {
    const events: KernEvent[] = [
      makeEvent({
        type: "run_started",
        seq: 1,
        agentName: "test-agent",
        model: "fake:model",
        instructions: "Be helpful",
        input: "What is 2+2?",
      }),
      makeEvent({
        type: "model_requested",
        seq: 2,
        step: 1,
        messageCount: 1,
      }),
      makeEvent({
        type: "model_responded",
        seq: 3,
        step: 1,
        text: "I'll calculate that",
        toolCalls: [{ id: "call-1", name: "calculator", args: { a: 2, b: 2 } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      }),
      makeEvent({
        type: "tool_started",
        seq: 4,
        callId: "call-1",
        name: "calculator",
        args: { a: 2, b: 2 },
      }),
      makeEvent({
        type: "tool_result",
        seq: 5,
        callId: "call-1",
        output: 4,
        isError: false,
      }),
      makeEvent({
        type: "model_requested",
        seq: 6,
        step: 2,
        messageCount: 3,
      }),
      makeEvent({
        type: "model_responded",
        seq: 7,
        step: 2,
        text: "The answer is 4",
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 8 },
        stopReason: "end_turn",
      }),
      makeEvent({
        type: "run_completed",
        seq: 8,
        output: "The answer is 4",
      }),
    ];

    const trace = formatTrace(events);
    expect(trace).toMatchInlineSnapshot(`
"#1 +  0.000s run_started      agent=test-agent model=fake:model input=What is 2+2?
#2 +  1.000s model_requested  step=1 messageCount=1
#3 +  2.000s model_responded  step=1 stopReason=tool_use usage=10/5 text=I'll calculate that tools=calculator(call-1)
#4 +  3.000s tool_started     tool=calculator callId=call-1 input={"a":2,"b":2}
#5 +  4.000s tool_result      callId=call-1 ok output=4
#6 +  5.000s model_requested  step=2 messageCount=3
#7 +  6.000s model_responded  step=2 stopReason=end_turn usage=20/8 text=The answer is 4
#8 +  7.000s run_completed    output=The answer is 4
status=completed steps=2"
    `);
  });

  it("paused run with pending approval", () => {
    const events: KernEvent[] = [
      makeEvent({
        type: "run_started",
        seq: 1,
        agentName: "danger-agent",
        model: "fake:model",
        instructions: "Delete things",
        input: "Delete all files",
      }),
      makeEvent({
        type: "model_requested",
        seq: 2,
        step: 1,
        messageCount: 1,
      }),
      makeEvent({
        type: "model_responded",
        seq: 3,
        step: 1,
        text: "I'll delete them",
        toolCalls: [{ id: "call-danger", name: "delete_all", args: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      }),
      makeEvent({
        type: "policy_decided",
        seq: 4,
        callId: "call-danger",
        decision: "ask",
        source: "requiresApproval",
      }),
      makeEvent({
        type: "run_paused",
        seq: 5,
        reason: "approval",
        callId: "call-danger",
      }),
    ];

    const trace = formatTrace(events);

    expect(trace).toContain("run_paused");
    expect(trace).toContain("pending=delete_all(call-danger)");
    expect(trace).toContain("status=paused");
  });

  it("long tool output is truncated without mutating events", () => {
    const longOutput = "x".repeat(200);
    const events: KernEvent[] = [
      makeEvent({
        type: "run_started",
        seq: 1,
        agentName: "test",
        model: "fake:model",
        instructions: "Help",
        input: "Go",
      }),
      makeEvent({
        type: "model_requested",
        seq: 2,
        step: 1,
        messageCount: 1,
      }),
      makeEvent({
        type: "model_responded",
        seq: 3,
        step: 1,
        text: "Calling tool",
        toolCalls: [{ id: "call-1", name: "tool", args: {} }],
        usage: { inputTokens: 5, outputTokens: 3 },
        stopReason: "tool_use",
      }),
      makeEvent({
        type: "tool_started",
        seq: 4,
        callId: "call-1",
        name: "tool",
        args: {},
      }),
      makeEvent({
        type: "tool_result",
        seq: 5,
        callId: "call-1",
        output: longOutput,
        isError: false,
      }),
    ];

    const eventsCopy = JSON.parse(JSON.stringify(events));
    const trace = formatTrace(events, { maxValueChars: 50 });

    expect(trace).toContain("…");
    deepEqual(events, eventsCopy);
  });
});
