import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import {
  FakeModel,
  Runner,
  deriveState,
  JsonlRunStore,
  Agent,
  tool,
  Policy,
} from "../src/index.js";

describe("Demo", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(process.env.TEMP || "/tmp", "kern-demo-test-")
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createTestAgent(runsDir: string): Agent {
    const lookupRecord = tool({
      name: "lookup_record",
      description: "Look up a record by ID",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const recordsPath = path.join(runsDir, "demo-records.json");
        try {
          const content = await fs.readFile(recordsPath, "utf-8");
          const records = JSON.parse(content);
          const found = records.find((r: { id: string }) => r.id === id);
          if (!found) {
            return { id, found: false };
          }
          return found;
        } catch {
          const seedRecords = [
            { id: "A-17", status: "pending", description: "Order #17" },
            { id: "B-42", status: "shipped", description: "Order #42" },
          ];
          const found = seedRecords.find((r) => r.id === id);
          if (!found) {
            return { id, found: false };
          }
          return found;
        }
      },
      requiresApproval: false,
    });

    const updateStatus = tool({
      name: "update_status",
      description:
        "Update the status of a record (pending, shipped, or cancelled)",
      input: z.object({
        id: z.string(),
        status: z.enum(["pending", "shipped", "cancelled"]),
      }),
      execute: async ({ id, status }) => {
        const recordsPath = path.join(runsDir, "demo-records.json");
        let records;
        try {
          const content = await fs.readFile(recordsPath, "utf-8");
          records = JSON.parse(content);
        } catch {
          records = [
            { id: "A-17", status: "pending", description: "Order #17" },
            { id: "B-42", status: "shipped", description: "Order #42" },
          ];
        }
        const record = records.find((r: { id: string }) => r.id === id);
        if (!record) {
          return { error: `Record ${id} not found` };
        }
        const previous = record.status;
        record.status = status;
        await fs.writeFile(recordsPath, JSON.stringify(records, null, 2), "utf-8");
        return { id, status, previous };
      },
      requiresApproval: true,
    });

    return new Agent({
      name: "demo-agent",
      model: "fake:test",
      instructions: `You are a helpful order management assistant.`,
      tools: [lookupRecord, updateStatus],
      hooks: [Policy({ allow: ["lookup_record"] })],
      maxSteps: 10,
    });
  }

  it("runDemo completes successfully with correct event sequence", async () => {
    const agent = createTestAgent(tempDir);

    const fakeModel = new FakeModel([
      {
        text: "I'll help you with that. Let me first look up the record.",
        toolCalls: [{ id: "call-1", name: "lookup_record", args: { id: "A-17" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Now I'll update the status to shipped.",
        toolCalls: [
          { id: "call-2", name: "update_status", args: { id: "A-17", status: "shipped" } },
        ],
        usage: { inputTokens: 200, outputTokens: 75 },
        stopReason: "tool_use",
      },
      {
        text: "Record A-17 has been successfully updated from pending to shipped.",
        toolCalls: [],
        usage: { inputTokens: 250, outputTokens: 50 },
        stopReason: "end_turn",
      },
    ]);

    const runner = new Runner({
      runsDir: tempDir,
      models: [{ provider: "fake", generate: (req) => fakeModel.generate(req) }],
    });

    // Phase 1: Run until paused
    let runId = "";
    for await (const event of runner.stream(agent, "Update record A-17 status to shipped")) {
      if (event.type === "run_started") {
        runId = event.runId;
      }
    }

    expect(runId).toBeTruthy();

    // Phase 2: Approve and resume
    const fakeModel2 = new FakeModel([
      {
        text: "Record A-17 has been successfully updated from pending to shipped.",
        toolCalls: [],
        usage: { inputTokens: 250, outputTokens: 50 },
        stopReason: "end_turn",
      },
    ]);

    const runner2 = new Runner({
      runsDir: tempDir,
      models: [{ provider: "fake", generate: (req) => fakeModel2.generate(req) }],
    });

    for await (const event of runner2.resumeStream(agent, runId, {
      decision: { approved: true },
    })) {
      void event; // Consume events
    }

    // Verify the complete event sequence
    const store = new JsonlRunStore(tempDir);
    const storedEvents = await store.read(runId);
    const state = deriveState(storedEvents);

    expect(state.status).toBe("completed");
    expect(state.steps).toBe(3);

    // Check event types
    const eventTypes = storedEvents.map((e) => e.type);
    expect(eventTypes).toContain("run_started");
    expect(eventTypes).toContain("model_requested");
    expect(eventTypes).toContain("model_responded");
    expect(eventTypes).toContain("tool_started");
    expect(eventTypes).toContain("tool_result");
    expect(eventTypes).toContain("policy_decided");
    expect(eventTypes).toContain("run_paused");
    expect(eventTypes).toContain("approval_decided");
    expect(eventTypes).toContain("run_resumed");
    expect(eventTypes).toContain("run_completed");

    // Count tool_started events for update_status (should be exactly 1)
    const updateStatusEvents = storedEvents.filter(
      (e) => e.type === "tool_started" && "name" in e && e.name === "update_status"
    );
    expect(updateStatusEvents).toHaveLength(1);

    // Verify demo-records.json shows A-17 as "shipped"
    const recordsPath = path.join(tempDir, "demo-records.json");
    const recordsContent = await fs.readFile(recordsPath, "utf-8");
    const records = JSON.parse(recordsContent);
    const a17 = records.find((r: { id: string }) => r.id === "A-17");
    expect(a17).toBeTruthy();
    expect(a17.status).toBe("shipped");
  });

  it("reject path keeps records unchanged with error message", async () => {
    // Initialize the demo-records.json file with seed data
    const recordsPath = path.join(tempDir, "demo-records.json");
    await fs.writeFile(
      recordsPath,
      JSON.stringify(
        [
          { id: "A-17", status: "pending", description: "Order #17" },
          { id: "B-42", status: "shipped", description: "Order #42" },
        ],
        null,
        2
      ),
      "utf-8"
    );

    const agent = createTestAgent(tempDir);

    const fakeModel = new FakeModel([
      {
        text: "I'll help you with that. Let me first look up the record.",
        toolCalls: [{ id: "call-1", name: "lookup_record", args: { id: "A-17" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Now I'll update the status to shipped.",
        toolCalls: [
          { id: "call-2", name: "update_status", args: { id: "A-17", status: "shipped" } },
        ],
        usage: { inputTokens: 200, outputTokens: 75 },
        stopReason: "tool_use",
      },
      {
        text: "The update was rejected. Record A-17 status remains pending.",
        toolCalls: [],
        usage: { inputTokens: 250, outputTokens: 50 },
        stopReason: "end_turn",
      },
    ]);

    const runner = new Runner({
      runsDir: tempDir,
      models: [{ provider: "fake", generate: (req) => fakeModel.generate(req) }],
    });

    // Phase 1: Run until paused
    let runId = "";
    for await (const event of runner.stream(agent, "Update record A-17 status to shipped")) {
      if (event.type === "run_started") {
        runId = event.runId;
      }
    }

    // Phase 2: Reject the call
    const fakeModel2 = new FakeModel([
      {
        text: "The update was rejected. Record A-17 status remains pending.",
        toolCalls: [],
        usage: { inputTokens: 250, outputTokens: 50 },
        stopReason: "end_turn",
      },
    ]);

    const runner2 = new Runner({
      runsDir: tempDir,
      models: [{ provider: "fake", generate: (req) => fakeModel2.generate(req) }],
    });

    for await (const event of runner2.resumeStream(agent, runId, {
      decision: { approved: false },
    })) {
      void event; // Consume events
    }

    // Verify the final state
    const store = new JsonlRunStore(tempDir);
    const storedEvents = await store.read(runId);
    const state = deriveState(storedEvents);

    expect(state.status).toBe("completed");

    // Verify rejection is recorded
    const approvalEvent = storedEvents.find((e) => e.type === "approval_decided");
    expect(approvalEvent).toBeTruthy();
    if (approvalEvent && "approved" in approvalEvent) {
      expect(approvalEvent.approved).toBe(false);
    }

    // Verify there's a tool_result with rejection error message
    const toolResults = storedEvents.filter((e) => e.type === "tool_result");
    let foundRejectionError = false;
    for (const result of toolResults) {
      if ("isError" in result && result.isError && "output" in result) {
        const output = result.output;
        if (typeof output === "string" && output.includes("Rejected by user")) {
          foundRejectionError = true;
          break;
        }
      }
    }
    expect(foundRejectionError).toBe(true);

    // Verify demo-records.json still shows A-17 as "pending"
    const recordsContent = await fs.readFile(recordsPath, "utf-8");
    const records = JSON.parse(recordsContent);
    const a17 = records.find((r: { id: string }) => r.id === "A-17");
    expect(a17).toBeTruthy();
    expect(a17.status).toBe("pending");
  });

  it("delete_record denied by policy shows denial without pause", async () => {
    const agent = createTestAgent(tempDir);

    // Initialize records
    const recordsPath = path.join(tempDir, "demo-records.json");
    await fs.writeFile(
      recordsPath,
      JSON.stringify(
        [
          { id: "A-17", status: "pending", description: "Order #17" },
          { id: "B-2", status: "pending", description: "Order #2" },
          { id: "C-9", status: "pending", description: "Order #9" },
        ],
        null,
        2
      ),
      "utf-8"
    );

    const fakeModel = new FakeModel([
      {
        text: "I'll delete record B-2.",
        toolCalls: [{ id: "call-1", name: "delete_record", args: { id: "B-2" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      },
      {
        text: "Record B-2 deletion was denied by policy.",
        toolCalls: [],
        usage: { inputTokens: 150, outputTokens: 50 },
        stopReason: "end_turn",
      },
    ]);

    const runner = new Runner({
      runsDir: tempDir,
      models: [{ provider: "fake", generate: (req) => fakeModel.generate(req) }],
    });

    // Run the delete command
    let runId = "";
    const events = [];
    for await (const event of runner.stream(agent, "Delete record B-2")) {
      events.push(event);
      if (event.type === "run_started") {
        runId = event.runId;
      }
    }

    const store = new JsonlRunStore(tempDir);
    const storedEvents = await store.read(runId);
    const state = deriveState(storedEvents);

    // Should complete without pause (policy deny returns error instead of pausing)
    expect(state.status).toBe("completed");

    // Verify delete_record was NOT executed (no tool_started)
    const deleteToolEvents = storedEvents.filter(
      (e) => e.type === "tool_started" && "name" in e && e.name === "delete_record"
    );
    expect(deleteToolEvents).toHaveLength(0);

    // Verify B-2 still present in records
    const recordsContent = await fs.readFile(recordsPath, "utf-8");
    const records = JSON.parse(recordsContent);
    const b2 = records.find((r: { id: string }) => r.id === "B-2");
    expect(b2).toBeTruthy();
    expect(b2.status).toBe("pending");
  });
});
