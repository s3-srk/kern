import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import {
  runLoop,
  Agent,
  FakeModel,
  JsonlRunStore,
  tool,
  stampEvent,
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
      "tool_started",
      "tool_result",
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
});
