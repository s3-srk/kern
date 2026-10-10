import { describe, it, expect } from "vitest";
import { deriveState, stampEvent } from "../src/index.js";

describe("deriveState", () => {
  it("completed run: status, steps and output are correct", () => {
    const events = [
      stampEvent(
        {
        type: "run_started",
        agentName: "",
        model: "",
        instructions: "Test instructions",
        input: "Hello",
        },
        { runId: "run-1", seq: 1 }
      ),
      stampEvent(
        {
          type: "model_requested",
          step: 1,
          messageCount: 1,
        },
        { runId: "run-1", seq: 2 }
      ),
      stampEvent(
        {
          type: "model_responded",
          step: 1,
          text: "I will look that up",
          toolCalls: [
            {
              id: "call-1",
              name: "lookup",
              args: { id: "A-17" },
            },
          ],
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: "tool_use",
        },
        { runId: "run-1", seq: 3 }
      ),
      stampEvent(
        {
          type: "model_requested",
          step: 2,
          messageCount: 2,
        },
        { runId: "run-1", seq: 4 }
      ),
      stampEvent(
        {
          type: "model_responded",
          step: 2,
          text: "The record shows...",
          toolCalls: [],
          usage: { inputTokens: 150, outputTokens: 75 },
          stopReason: "end_turn",
        },
        { runId: "run-1", seq: 5 }
      ),
      stampEvent(
        {
          type: "run_completed",
          output: "Task completed successfully",
        },
        { runId: "run-1", seq: 6 }
      ),
    ];

    const state = deriveState(events);

    expect(state.status).toBe("completed");
    expect(state.steps).toBe(2);
    expect(state.output).toBe("Task completed successfully");
    expect(state.lastSeq).toBe(6);
    expect(state.runId).toBe("run-1");
    expect(state.pending).toBeUndefined();
  });

  it("paused run: status paused with pending call; after approval_decided + run_resumed it is running with no pending", () => {
    const events = [
      stampEvent(
        {
        type: "run_started",
        agentName: "",
        model: "",
        instructions: "Test instructions",
        input: "Delete the file",
        },
        { runId: "run-2", seq: 1 }
      ),
      stampEvent(
        {
          type: "model_requested",
          step: 1,
          messageCount: 1,
        },
        { runId: "run-2", seq: 2 }
      ),
      stampEvent(
        {
          type: "model_responded",
          step: 1,
          text: "I will delete the file",
          toolCalls: [
            {
              id: "call-1",
              name: "delete_file",
              args: { path: "/data/important.txt" },
            },
          ],
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: "tool_use",
        },
        { runId: "run-2", seq: 3 }
      ),
      stampEvent(
        {
          type: "run_paused",
          reason: "approval",
          callId: "call-1",
        },
        { runId: "run-2", seq: 4 }
      ),
    ];

    const pausedState = deriveState(events);
    expect(pausedState.status).toBe("paused");
    expect(pausedState.pending).toBeDefined();
    expect(pausedState.pending?.call.id).toBe("call-1");
    expect(pausedState.pending?.call.name).toBe("delete_file");
    expect(pausedState.pending?.approved).toBeUndefined();
    expect(pausedState.lastSeq).toBe(4);

    // Now add approval and resume
    const resumeEvents = [
      ...events,
      stampEvent(
        {
          type: "approval_decided",
          callId: "call-1",
          approved: true,
        },
        { runId: "run-2", seq: 5 }
      ),
      stampEvent(
        {
          type: "run_resumed",
        },
        { runId: "run-2", seq: 6 }
      ),
    ];

    const resumedState = deriveState(resumeEvents);
    expect(resumedState.status).toBe("running");
    expect(resumedState.pending).toBeUndefined();
    expect(resumedState.lastSeq).toBe(6);
  });

  it("empty events throws", () => {
    expect(() => deriveState([])).toThrow("Cannot derive state from empty event list");
  });

  it("first event not run_started throws", () => {
    const events = [
      stampEvent(
        {
          type: "model_requested",
          step: 1,
          messageCount: 1,
        },
        { runId: "run-3", seq: 1 }
      ),
    ];

    expect(() => deriveState(events)).toThrow(
      "First event must be run_started"
    );
  });

  it("paused with missing tool call throws", () => {
    const events = [
      stampEvent(
        {
          type: "run_started",
          agentName: "test-agent",
          model: "anthropic:claude-3-sonnet",
          instructions: "Test instructions",
          input: "test",
        },
        { runId: "run-4", seq: 1 }
      ),
      stampEvent(
        {
          type: "run_paused",
          reason: "approval",
          callId: "nonexistent-call",
        },
        { runId: "run-4", seq: 2 }
      ),
    ];

    expect(() => deriveState(events)).toThrow(
      "Tool call nonexistent-call not found in model_responded events"
    );
  });
});
