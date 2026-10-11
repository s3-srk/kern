import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { runLoop } from "../src/loop.js";
import { stampEvent } from "../src/events.js";
import { deriveState } from "../src/state.js";
import {
  Agent,
  FakeModel,
  JsonlRunStore,
  tool,
  Policy,
  type Hook,
} from "../src/index.js";

describe("runLoop", () => {
  let tempDir: string;
  let store: JsonlRunStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(process.env.TEMP || "/tmp", "kern-loop-test-")
    );
    store = new JsonlRunStore(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("happy path: model returns 2 tool calls then final text", async () => {
    const testTool = tool({
      name: "test_tool",
      description: "A test tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: `processed: ${value}` }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Use tools as needed",
      tools: [testTool],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Calling tools",
        toolCalls: [
          { id: "call-1", name: "test_tool", args: { value: "first" } },
          { id: "call-2", name: "test_tool", args: { value: "second" } },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Final answer",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-run-1",
      input: "Hello",
    })) {
      events.push(event);
    }

    // Verify event sequence
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "run_started",
      "model_requested",
      "model_responded",
      "policy_decided",
      "tool_started",
      "tool_result",
      "policy_decided",
      "tool_started",
      "tool_result",
      "model_requested",
      "model_responded",
      "run_completed",
    ]);

    // Verify run_completed output
    const completed = events.find((e) => e.type === "run_completed");
    expect(completed?.type === "run_completed" && completed.output).toBe(
      "Final answer"
    );

    // Verify store events match yielded events
    const storedEvents = await store.read("test-run-1");
    expect(storedEvents).toHaveLength(events.length);
    expect(storedEvents).toEqual(events);

    // Verify model's second request has one tool message with 2 results
    expect(fakeModel.requests).toHaveLength(2);
    const secondRequest = fakeModel.requests[1];
    const toolMessage = secondRequest.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    if (toolMessage?.role === "tool") {
      expect(toolMessage.results).toHaveLength(2);
    }
  });

  it("tool errors: invalid input and execution error", async () => {
    const testTool = tool({
      name: "test_tool",
      description: "A test tool",
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => {
        if (value === 999) {
          throw new Error("Tool execution failed");
        }
        return { result: value * 2 };
      },
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Use tools",
      tools: [testTool],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Calling tools",
        toolCalls: [
          { id: "call-1", name: "test_tool", args: { value: "not-a-number" } },
          { id: "call-2", name: "test_tool", args: { value: 999 } },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Got errors, done",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-run-2",
      input: "Hello",
    })) {
      events.push(event);
    }

    // Verify both tool calls produced errors
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    for (const result of toolResults) {
      if (result.type === "tool_result") {
        expect(result.isError).toBe(true);
      }
    }

    // Verify run completed despite errors
    const completed = events.find((e) => e.type === "run_completed");
    expect(completed?.type === "run_completed").toBe(true);
  });

  it("step limit: max steps reached", async () => {
    const testTool = tool({
      name: "test_tool",
      description: "A test tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: value }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Use tools",
      tools: [testTool],
      maxSteps: 2,
    });

    const fakeModel = new FakeModel([
      {
        text: "Calling tool",
        toolCalls: [{ id: "call-1", name: "test_tool", args: { value: "a" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Calling tool again",
        toolCalls: [{ id: "call-2", name: "test_tool", args: { value: "b" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-run-3",
      input: "Hello",
    })) {
      events.push(event);
    }

    // Verify run failed with max_steps
    const failed = events.find((e) => e.type === "run_failed");
    expect(failed?.type === "run_failed" && failed.error.code).toBe(
      "max_steps"
    );

    // Verify model was called exactly twice
    expect(fakeModel.requests).toHaveLength(2);
  });

  it("ADR-003: pre-seeded log with tool_started but no tool_result", async () => {
    const testTool = tool({
      name: "test_tool",
      description: "A test tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: value }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Use tools",
      tools: [testTool],
      maxSteps: 10,
    });

    // Pre-seed the store with a run that has tool_started but no tool_result
    const preseedEvents = [
      stampEvent(
        {
          type: "run_started",
          agentName: agent.name,
          model: agent.model,
          instructions: agent.instructions,
          input: "Hello",
        },
        { runId: "test-run-4", seq: 1 }
      ),
      stampEvent(
        {
          type: "model_requested",
          step: 1,
          messageCount: 1,
        },
        { runId: "test-run-4", seq: 2 }
      ),
      stampEvent(
        {
          type: "model_responded",
          step: 1,
          text: "Calling tool",
          toolCalls: [
            { id: "uncertain-call", name: "test_tool", args: { value: "x" } },
          ],
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: "tool_use",
        },
        { runId: "test-run-4", seq: 3 }
      ),
      stampEvent(
        {
          type: "tool_started",
          callId: "uncertain-call",
          name: "test_tool",
          args: { value: "x" },
        },
        { runId: "test-run-4", seq: 4 }
      ),
    ];

    for (const event of preseedEvents) {
      await store.append(event);
    }

    // Don't provide a FakeModel response - the loop should detect the uncertain state
    const fakeModel = new FakeModel([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-run-4",
    })) {
      events.push(event);
    }

    // Verify the loop appended a run_failed event
    const failed = events[0];
    expect(failed.type).toBe("run_failed");
    if (failed.type === "run_failed") {
      expect(failed.error.code).toBe("uncertain_tool_outcome");
      expect(failed.error.message).toContain("uncertain outcome");
    }

    // Verify the tool's execute was never called
    expect(fakeModel.requests).toHaveLength(0);
  });

  it("policy deny: tool call is denied, execution not called", async () => {
    const deleteToolCalled = { count: 0 };
    const deleteTool = tool({
      name: "delete_record",
      description: "Delete a record",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        deleteToolCalled.count += 1;
        return { deleted: id };
      },
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Delete records as needed",
      tools: [deleteTool],
      hooks: [Policy({ deny: ["*delete*"] })],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Calling delete",
        toolCalls: [{ id: "call-1", name: "delete_record", args: { id: "123" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Got denied",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-deny-1",
      input: "Delete record 123",
    })) {
      events.push(event);
    }

    // Verify policy_decided event
    const policyEvent = events.find((e) => e.type === "policy_decided");
    expect(policyEvent?.type === "policy_decided" && policyEvent.decision).toBe(
      "deny"
    );

    // Verify tool_result with error
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult?.type === "tool_result" && toolResult.isError).toBe(true);

    // Verify tool was never executed
    expect(deleteToolCalled.count).toBe(0);

    // Verify no tool_started event
    const toolStarted = events.find((e) => e.type === "tool_started");
    expect(toolStarted).toBeUndefined();

    // Verify run completed
    const completed = events.find((e) => e.type === "run_completed");
    expect(completed?.type === "run_completed").toBe(true);
  });

  it("policy ask + pause: tool call pauses run for approval", async () => {
    const writeTool = tool({
      name: "write_record",
      description: "Write a record",
      input: z.object({ id: z.string(), data: z.string() }),
      execute: async ({ id, data }) => ({ written: id, data }),
      requiresApproval: true,
    });

    const lookupTool = tool({
      name: "lookup",
      description: "Look up a record",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ result: `found: ${id}` }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Look up then write",
      tools: [lookupTool, writeTool],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Looking up and writing",
        toolCalls: [
          { id: "call-1", name: "lookup", args: { id: "123" } },
          { id: "call-2", name: "write_record", args: { id: "123", data: "updated" } },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-pause-1",
      input: "Look up and write",
    })) {
      events.push(event);
    }

    // Verify first tool executed
    const lookup = events.find((e) => e.type === "tool_result" && e.callId === "call-1");
    expect(lookup?.type === "tool_result" && !lookup.isError).toBe(true);

    // Verify second tool paused before execution
    const policyEvent = events.find(
      (e) => e.type === "policy_decided" && e.callId === "call-2"
    );
    expect(policyEvent?.type === "policy_decided" && policyEvent.decision).toBe(
      "ask"
    );

    // Verify run_paused event
    const pauseEvent = events.find((e) => e.type === "run_paused");
    expect(pauseEvent?.type === "run_paused" && pauseEvent.callId).toBe("call-2");

    // Verify no tool_started for write_record
    const writeStarted = events.find(
      (e) => e.type === "tool_started" && e.callId === "call-2"
    );
    expect(writeStarted).toBeUndefined();

    // Verify run is paused
    expect(events[events.length - 1].type).toBe("run_paused");
  });

  it("onEvent hook called for each event", async () => {
    const eventLog: string[] = [];
    const observer: Hook = {
      name: "observer",
      onEvent: (event) => {
        eventLog.push(event.type);
      },
    };

    const testTool = tool({
      name: "test_tool",
      description: "A test tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: value }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Use tool",
      tools: [testTool],
      hooks: [observer],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Calling tool",
        toolCalls: [{ id: "call-1", name: "test_tool", args: { value: "x" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Done",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-observer-1",
      input: "Test",
    })) {
      events.push(event);
    }

    // Verify all events were observed
    expect(eventLog).toEqual([
      "run_started",
      "model_requested",
      "model_responded",
      "policy_decided",
      "tool_started",
      "tool_result",
      "model_requested",
      "model_responded",
      "run_completed",
    ]);

    // Verify same events yielded
    const yieldedTypes = events.map((e) => e.type);
    expect(yieldedTypes).toEqual(eventLog);
  });

  it("approve paused run: approval_decided, run_resumed, execution, completion", async () => {
    const writeTool = tool({
      name: "write_record",
      description: "Write a record",
      input: z.object({ id: z.string(), data: z.string() }),
      execute: async ({ id, data }) => ({ written: id, data }),
      requiresApproval: true,
    });

    const lookupTool = tool({
      name: "lookup",
      description: "Look up a record",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ result: `found: ${id}` }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Look up then write",
      tools: [lookupTool, writeTool],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Looking up and writing",
        toolCalls: [
          { id: "call-1", name: "lookup", args: { id: "123" } },
          { id: "call-2", name: "write_record", args: { id: "123", data: "updated" } },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Done",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      },
    ]);

    // First: run to paused state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pausedEvents: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-approve-1",
      input: "Look up and write",
    })) {
      pausedEvents.push(event);
    }

    // Verify paused
    expect(pausedEvents[pausedEvents.length - 1].type).toBe("run_paused");

    // Now resume with approval
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resumedEvents: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-approve-1",
      decision: { approved: true },
    })) {
      resumedEvents.push(event);
    }

    // Verify approval_decided
    const approvalEvent = resumedEvents.find((e) => e.type === "approval_decided");
    expect(approvalEvent?.approved).toBe(true);

    // Verify run_resumed
    const resumedEvent = resumedEvents.find((e) => e.type === "run_resumed");
    expect(resumedEvent?.type).toBe("run_resumed");

    // Verify write was executed
    const writeStarted = resumedEvents.find(
      (e) => e.type === "tool_started" && e.callId === "call-2"
    );
    expect(writeStarted).toBeDefined();

    // Verify run completed
    const completed = resumedEvents.find((e) => e.type === "run_completed");
    expect(completed?.type).toBe("run_completed");

    // Verify full log derivation includes all steps
    const allEvents = [...pausedEvents, ...resumedEvents];
    const state = deriveState(allEvents.filter(e => e.type)); // Filter to valid types
    expect(state.status).toBe("completed");
    expect(state.steps).toBe(2); // Both model calls
  });

  it("reject paused run: approval_decided not approved, tool_result error, no execution", async () => {
    const writeTool = tool({
      name: "write_record",
      description: "Write a record",
      input: z.object({ id: z.string() }),
      execute: async (_args) => {
        throw new Error("Should not execute");
      },
      requiresApproval: true,
    });

    const lookupTool = tool({
      name: "lookup",
      description: "Look up a record",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ result: `found: ${id}` }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Look up then write",
      tools: [lookupTool, writeTool],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Looking up and writing",
        toolCalls: [
          { id: "call-1", name: "lookup", args: { id: "123" } },
          { id: "call-2", name: "write_record", args: { id: "123" } },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Got error, done",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      },
    ]);

    // First: run to paused state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pausedEvents: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-reject-1",
      input: "Look up and write",
    })) {
      pausedEvents.push(event);
    }

    // Now resume with rejection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resumedEvents: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-reject-1",
      decision: { approved: false, reason: "user denied" },
    })) {
      resumedEvents.push(event);
    }

    // Verify approval_decided not approved
    const approvalEvent = resumedEvents.find((e) => e.type === "approval_decided");
    expect(approvalEvent?.approved).toBe(false);

    // Verify tool_result with error (no tool_started)
    const writeStarted = resumedEvents.find(
      (e) => e.type === "tool_started" && e.callId === "call-2"
    );
    expect(writeStarted).toBeUndefined();

    const resultEvent = resumedEvents.find(
      (e) => e.type === "tool_result" && e.callId === "call-2"
    );
    expect(resultEvent?.isError).toBe(true);
    expect(resultEvent?.output).toContain("Rejected by user");

    // Verify run completed (model sees the error)
    const completed = resumedEvents.find((e) => e.type === "run_completed");
    expect(completed?.type).toBe("run_completed");
  });

  it("pause again: first call approved, second call pauses", async () => {
    const tool1 = tool({
      name: "write_1",
      description: "Write 1",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ result: id }),
      requiresApproval: true,
    });

    const tool2 = tool({
      name: "write_2",
      description: "Write 2",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ result: id }),
      requiresApproval: true,
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Write twice",
      tools: [tool1, tool2],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Writing twice",
        toolCalls: [
          { id: "call-1", name: "write_1", args: { id: "a" } },
          { id: "call-2", name: "write_2", args: { id: "b" } },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Done",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: "end_turn",
      },
    ]);

    // First: run to paused at call-1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pausedEvents: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-pause-again-1",
      input: "Write twice",
    })) {
      pausedEvents.push(event);
    }

    // Resume and approve call-1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resumedEvents: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-pause-again-1",
      decision: { approved: true },
    })) {
      resumedEvents.push(event);
    }

    // Verify call-1 was executed
    const call1Executed = resumedEvents.some(
      (e) => e.type === "tool_started" && e.callId === "call-1"
    );
    expect(call1Executed).toBe(true);

    // Verify paused again at call-2
    const finalPause = resumedEvents.find(
      (e) => e.type === "run_paused" && e.callId === "call-2"
    );
    expect(finalPause).toBeDefined();

    // Verify state is paused with call-2 pending
    const allEvents = [...pausedEvents, ...resumedEvents];
    const state = deriveState(allEvents.filter(e => e.type));
    expect(state.status).toBe("paused");
    expect(state.pending?.call.id).toBe("call-2");
  });

  it("guard: decision on completed run throws", async () => {
    const testTool = tool({
      name: "test_tool",
      description: "A test tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: value }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Use tool",
      tools: [testTool],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Done",
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
      },
    ]);

    // Run to completion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    for await (const event of runLoop({
      agent,
      model: fakeModel,
      store,
      runId: "test-guard-1",
      input: "Test",
    })) {
      events.push(event);
    }

    // Try to resume with decision on completed run
    await expect(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of runLoop({
          agent,
          model: fakeModel,
          store,
          runId: "test-guard-1",
          decision: { approved: true },
        })) {
          // noop
        }
      })()
    ).rejects.toThrow("paused");
  });
});
