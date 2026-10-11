import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import {
  Runner,
  Agent,
  FakeModel,
  tool,
} from "../src/index.js";

describe("Runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(process.env.TEMP || "/tmp", "kern-runner-test-")
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("run() with registered FakeModel completes and creates run file", async () => {
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
        text: "Calling tool",
        toolCalls: [
          { id: "call-1", name: "test_tool", args: { value: "hello" } },
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

    const runner = new Runner({
      runsDir: tempDir,
      models: [fakeModel],
    });

    const state = await runner.run(agent, "Hello");

    // Verify run completed
    expect(state.status).toBe("completed");
    expect(state.output).toBe("Final answer");

    // Verify runId matches the format
    expect(state.runId).toMatch(/^run-\d{8}-\d{6}-[0-9a-f]{4}$/);

    // Verify run file exists
    const runFile = path.join(tempDir, `${state.runId}.jsonl`);
    const fileExists = await fs
      .access(runFile)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);

    // Verify file has content
    const content = await fs.readFile(runFile, "utf-8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("unknown provider throws clear error and no run file created", async () => {
    const agent = new Agent({
      name: "test-agent",
      model: "unknown-provider:test",
      instructions: "Test",
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([]);

    const runner = new Runner({
      runsDir: tempDir,
      models: [fakeModel],
    });

    // Try to run with unknown provider
    await expect(runner.run(agent, "Hello")).rejects.toThrow(
      'No model adapter registered for provider "unknown-provider"'
    );

    // Verify no run file was created
    const files = await fs.readdir(tempDir);
    expect(files).toHaveLength(0);
  });

  it("stream() with existing runId throws", async () => {
    const testTool = tool({
      name: "test_tool",
      description: "A test tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: value }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Test",
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

    const runner = new Runner({
      runsDir: tempDir,
      models: [fakeModel],
    });

    // First run should succeed
    const state1 = await runner.run(agent, "Hello");
    expect(state1.status).toBe("completed");

    // Second run with same runId should throw
    const streamCall = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const event of runner.stream(agent, "Hello", {
        runId: state1.runId,
      })) {
        // stream throws before first event
      }
    };

    await expect(streamCall()).rejects.toThrow(
      `Run ${state1.runId} already exists; resuming is not yet supported`
    );
  });

  it("resume() on unknown run throws", async () => {
    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Test",
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([]);

    const runner = new Runner({
      runsDir: tempDir,
      models: [fakeModel],
    });

    await expect(runner.resume(agent, "unknown-run")).rejects.toThrow(
      "Unknown run unknown-run"
    );
  });

  it("resume() with decision on completed run throws", async () => {
    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Test",
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

    const runner = new Runner({
      runsDir: tempDir,
      models: [fakeModel],
    });

    const state = await runner.run(agent, "Hello");
    expect(state.status).toBe("completed");

    await expect(
      runner.resume(agent, state.runId, { decision: { approved: true } })
    ).rejects.toThrow("Cannot resume completed run");
  });

  it("resume() without decision on paused run throws", async () => {
    const writeTool = tool({
      name: "write",
      description: "Write",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ result: id }),
      requiresApproval: true,
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Test",
      tools: [writeTool],
      maxSteps: 10,
    });

    const fakeModel = new FakeModel([
      {
        text: "Writing",
        toolCalls: [{ id: "call-1", name: "write", args: { id: "123" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
    ]);

    const runner = new Runner({
      runsDir: tempDir,
      models: [fakeModel],
    });

    const state = await runner.run(agent, "Write");
    expect(state.status).toBe("paused");

    await expect(runner.resume(agent, state.runId)).rejects.toThrow(
      "run is paused; approve or reject"
    );
  });

  it("resume() with agent name mismatch throws", async () => {
    const agent = new Agent({
      name: "agent-1",
      model: "fake:test",
      instructions: "Test",
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

    const runner = new Runner({
      runsDir: tempDir,
      models: [fakeModel],
    });

    const state = await runner.run(agent, "Hello");

    // Try to resume with different agent name
    const differentAgent = new Agent({
      name: "agent-2",
      model: "fake:test",
      instructions: "Test",
      maxSteps: 10,
    });

    await expect(
      runner.resume(differentAgent, state.runId)
    ).rejects.toThrow("Agent name or model does not match run");
  });
});
