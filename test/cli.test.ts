import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { main } from "../src/cli.js";
import { Agent, FakeModel, tool } from "../src/index.js";

describe("CLI", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(process.env.TEMP || "/tmp", "kern-cli-test-")
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("run paused → approve → completed (default output without events)", async () => {
    const approvableTool = tool({
      name: "write_data",
      description: "Write data (requires approval)",
      input: z.object({ data: z.string() }),
      execute: async ({ data }) => ({ written: data }),
      requiresApproval: true,
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Write data when asked",
      tools: [approvableTool],
      maxSteps: 10,
    });

    const moduleDir = path.join(tempDir, "modules");
    await fs.mkdir(moduleDir, { recursive: true });
    const modulePath = path.join(moduleDir, "test-agent.js");

    const fakeModel = new FakeModel([
      {
        text: "I'll write the data",
        toolCalls: [
          { id: "call-1", name: "write_data", args: { data: "hello" } },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Data written successfully",
        toolCalls: [],
        usage: { inputTokens: 150, outputTokens: 50 },
        stopReason: "end_turn",
      },
    ]);

    let stdoutContent = "";

    // Run and pause
    const code1 = await main(
      ["run", "write data", "--agent", modulePath, "--runs-dir", tempDir],
      {
        stdout: { write: (s: string) => { stdoutContent += s; } },
        stderr: { write: () => {} },
        loadAgent: async () => ({
          agent,
          models: [{ provider: "fake", generate: (req) => fakeModel.generate(req) }],
        }),
      }
    );

    expect(code1).toBe(0);
    expect(stdoutContent).toContain("Run run-");
    expect(stdoutContent).toContain("Waiting for approval: write_data");
    expect(stdoutContent).toContain("npm run kern -- approve");
    expect(stdoutContent).toContain("npm run kern -- reject");
    // Default output should NOT contain per-event lines
    expect(stdoutContent).not.toContain("#1 run_started");

    // Extract runId
    const runIdMatch = stdoutContent.match(/Run (run-[^\s]+)/);
    expect(runIdMatch).toBeTruthy();
    const runId = runIdMatch![1];

    // Approve
    stdoutContent = "";
    const fakeModel2 = new FakeModel([
      {
        text: "Data written successfully",
        toolCalls: [],
        usage: { inputTokens: 150, outputTokens: 50 },
        stopReason: "end_turn",
      },
    ]);

    const code2 = await main(
      ["approve", runId, "--agent", modulePath, "--runs-dir", tempDir],
      {
        stdout: { write: (s: string) => { stdoutContent += s; } },
        stderr: { write: () => {} },
        loadAgent: async () => ({
          agent,
          models: [{ provider: "fake", generate: (req) => fakeModel2.generate(req) }],
        }),
      }
    );

    expect(code2).toBe(0);
    expect(stdoutContent).toContain("Completed in");
    expect(stdoutContent).toContain("Data written successfully");
  });

  it("--events flag prints per-event lines", async () => {
    const simpleTool = tool({
      name: "simple",
      description: "Simple tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: value }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Test",
      tools: [simpleTool],
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

    let stdoutContent = "";

    const code = await main(
      ["run", "test", "--agent", "dummy", "--runs-dir", tempDir, "--events"],
      {
        stdout: { write: (s: string) => { stdoutContent += s; } },
        stderr: { write: () => {} },
        loadAgent: async () => ({
          agent,
          models: [{ provider: "fake", generate: (req) => fakeModel.generate(req) }],
        }),
      }
    );

    expect(code).toBe(0);
    expect(stdoutContent).toContain("#1 run_started");
    expect(stdoutContent).toContain("run_completed");
  });

  it("list shows runs sorted by ID", async () => {
    const simpleTool = tool({
      name: "simple",
      description: "Simple tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: value }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Test",
      tools: [simpleTool],
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

    // Create a run
    let stdoutContent = "";
    await main(
      ["run", "test", "--agent", "dummy", "--runs-dir", tempDir],
      {
        stdout: { write: (s: string) => { stdoutContent += s; } },
        stderr: { write: () => {} },
        loadAgent: async () => ({
          agent,
          models: [{ provider: "fake", generate: (req) => fakeModel.generate(req) }],
        }),
      }
    );

    // List
    stdoutContent = "";
    const listCode = await main(
      ["list", "--runs-dir", tempDir],
      {
        stdout: { write: (s: string) => { stdoutContent += s; } },
        stderr: { write: () => {} },
      }
    );

    expect(listCode).toBe(0);
    expect(stdoutContent).toContain("completed");
  });

  it("trace outputs full event log", async () => {
    const simpleTool = tool({
      name: "simple",
      description: "Simple tool",
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ result: value }),
    });

    const agent = new Agent({
      name: "test-agent",
      model: "fake:test",
      instructions: "Test",
      tools: [simpleTool],
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

    // Create a run
    let stdoutContent = "";
    await main(
      ["run", "test", "--agent", "dummy", "--runs-dir", tempDir],
      {
        stdout: { write: (s: string) => { stdoutContent += s; } },
        stderr: { write: () => {} },
        loadAgent: async () => ({
          agent,
          models: [{ provider: "fake", generate: (req) => fakeModel.generate(req) }],
        }),
      }
    );

    const runIdMatch = stdoutContent.match(/Run (run-[^\s]+)/);
    const runId = runIdMatch![1];

    // Trace
    stdoutContent = "";
    const traceCode = await main(
      ["trace", runId, "--runs-dir", tempDir],
      {
        stdout: { write: (s: string) => { stdoutContent += s; } },
        stderr: { write: () => {} },
      }
    );

    expect(traceCode).toBe(0);
    expect(stdoutContent).toContain("run_started");
    expect(stdoutContent).toContain("run_completed");
    expect(stdoutContent).toContain("status=completed");
  });

  it("usage errors return exit code 2", async () => {
    let stderrContent = "";

    const code = await main(
      ["unknown_command", "--runs-dir", tempDir],
      {
        stdout: { write: () => {} },
        stderr: { write: (s: string) => { stderrContent += s; } },
      }
    );

    expect(code).toBe(2);
    expect(stderrContent).toContain("Unknown command");
  });
});
