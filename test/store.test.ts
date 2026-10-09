import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { JsonlRunStore } from "../src/index.js";
import { stampEvent, KernEvent } from "../src/index.js";

describe("JsonlRunStore", () => {
  let tempDir: string;
  let store: JsonlRunStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(process.env.TEMP || "/tmp", "kern-store-test-")
    );
    store = new JsonlRunStore(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("append and read", () => {
    it("round-trips events in order, unchanged", async () => {
      const event1 = stampEvent(
        {
          type: "run_started",
          agentName: "test-agent",
          model: "anthropic:claude-3-sonnet",
          input: "Hello",
        },
        { runId: "test-run-1", seq: 1 }
      );

      const event2 = stampEvent(
        {
          type: "model_requested",
          step: 1,
          messageCount: 1,
        },
        { runId: "test-run-1", seq: 2 }
      );

      await store.append(event1);
      await store.append(event2);

      const events = await store.read("test-run-1");

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(event1);
      expect(events[1]).toEqual(event2);
    });

    it("preserves all event fields", async () => {
      const event = stampEvent(
        {
          type: "model_responded",
          step: 1,
          text: "Response text",
          toolCalls: [
            {
              id: "call-1",
              name: "test_tool",
              args: { key: "value", nested: { a: 1 } },
            },
          ],
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: "tool_use",
          raw: { custom: "data" },
        },
        { runId: "test-run-2", seq: 1 }
      );

      await store.append(event);
      const [readEvent] = await store.read("test-run-2");

      expect(readEvent).toEqual(event);
      if (readEvent.type === "model_responded") {
        expect(readEvent.raw).toEqual({ custom: "data" });
      }
    });
  });

  describe("multiple runs", () => {
    it("stores runs in separate files", async () => {
      const event1 = stampEvent(
        {
          type: "run_started",
          agentName: "agent-a",
          model: "anthropic:claude-3-sonnet",
          input: "Input A",
        },
        { runId: "run-a", seq: 1 }
      );

      const event2 = stampEvent(
        {
          type: "run_started",
          agentName: "agent-b",
          model: "anthropic:claude-3-sonnet",
          input: "Input B",
        },
        { runId: "run-b", seq: 1 }
      );

      await store.append(event1);
      await store.append(event2);

      const eventsA = await store.read("run-a");
      const eventsB = await store.read("run-b");

      expect(eventsA).toHaveLength(1);
      expect(eventsA[0].runId).toBe("run-a");
      expect(eventsB).toHaveLength(1);
      expect(eventsB[0].runId).toBe("run-b");
    });

    it("list returns both runs sorted", async () => {
      const event1 = stampEvent(
        {
          type: "run_started",
          agentName: "a",
          model: "anthropic:claude-3-sonnet",
          input: "A",
        },
        { runId: "zebra-run", seq: 1 }
      );

      const event2 = stampEvent(
        {
          type: "run_started",
          agentName: "b",
          model: "anthropic:claude-3-sonnet",
          input: "B",
        },
        { runId: "alpha-run", seq: 1 }
      );

      await store.append(event1);
      await store.append(event2);

      const runs = await store.list();

      expect(runs).toEqual(["alpha-run", "zebra-run"]);
    });
  });

  describe("torn write handling", () => {
    it("ignores torn last line without final newline", async () => {
      const event = stampEvent(
        {
          type: "run_started",
          agentName: "test",
          model: "anthropic:claude-3-sonnet",
          input: "test",
        },
        { runId: "test-run-3", seq: 1 }
      );

      await store.append(event);

      // Append incomplete JSON to simulate a torn write
      const filePath = path.join(tempDir, "test-run-3.jsonl");
      await fs.appendFile(filePath, '{"incomplete":', "utf-8");

      const events = await store.read("test-run-3");

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it("throws on corrupt middle line with line number", async () => {
      const filePath = path.join(tempDir, "test-run-4.jsonl");

      const line1 = JSON.stringify(
        stampEvent(
          {
            type: "run_started",
            agentName: "test",
            model: "anthropic:claude-3-sonnet",
            input: "test",
          },
          { runId: "test-run-4", seq: 1 }
        )
      );

      const line2 = '{"bad json without closing';
      const line3 = JSON.stringify(
        stampEvent(
          {
            type: "model_requested",
            step: 1,
            messageCount: 1,
          },
          { runId: "test-run-4", seq: 3 }
        )
      );

      await fs.writeFile(filePath, `${line1}\n${line2}\n${line3}\n`, "utf-8");

      await expect(store.read("test-run-4")).rejects.toThrow(
        "Invalid JSON on line 2"
      );
    });
  });

  describe("event version validation", () => {
    it("throws on unsupported event version", async () => {
      const filePath = path.join(tempDir, "test-run-5.jsonl");

      const validEvent = JSON.stringify(
        stampEvent(
          {
            type: "run_started",
            agentName: "test",
            model: "anthropic:claude-3-sonnet",
            input: "test",
          },
          { runId: "test-run-5", seq: 1 }
        )
      );

      const badEvent = JSON.stringify({
        v: 2,
        seq: 2,
        runId: "test-run-5",
        ts: new Date().toISOString(),
        type: "model_requested",
        step: 1,
        messageCount: 1,
      });

      await fs.writeFile(filePath, `${validEvent}\n${badEvent}\n`, "utf-8");

      await expect(store.read("test-run-5")).rejects.toThrow(
        "Unsupported event version 2 on line 2"
      );
    });
  });

  describe("error handling", () => {
    it("throws clear 'run not found' error for unknown runId", async () => {
      await expect(store.read("nonexistent-run")).rejects.toThrow(
        "Run not found: nonexistent-run"
      );
    });

    it("rejects path traversal in runId", async () => {
      const event = stampEvent(
        {
          type: "run_started",
          agentName: "test",
          model: "anthropic:claude-3-sonnet",
          input: "test",
        },
        { runId: "normal-run", seq: 1 }
      );

      await expect(
        store.append({
          ...event,
          runId: "../evil",
        } as KernEvent)
      ).rejects.toThrow("Invalid run ID: ../evil");

      await expect(store.read("../evil")).rejects.toThrow(
        "Invalid run ID: ../evil"
      );

      await expect(store.list()).resolves.not.toContain("../evil");
    });

    it("rejects runId with special characters", async () => {
      const event = stampEvent(
        {
          type: "run_started",
          agentName: "test",
          model: "anthropic:claude-3-sonnet",
          input: "test",
        },
        { runId: "normal-run", seq: 1 }
      );

      const invalidIds = [
        "run/with/slash",
        "run\\with\\backslash",
        "run with space",
        "run.with.dot",
        "run@with@at",
      ];

      for (const invalidId of invalidIds) {
        await expect(
          store.append({
            ...event,
            runId: invalidId,
          } as KernEvent)
        ).rejects.toThrow(`Invalid run ID: ${invalidId}`);
      }
    });
  });

  describe("valid runId patterns", () => {
    it("accepts alphanumeric, underscore, and hyphen", async () => {
      const validIds = [
        "run-123",
        "run_123",
        "run123",
        "a",
        "z",
        "0",
        "a-b_c-123",
      ];

      for (const validId of validIds) {
        const event = stampEvent(
          {
            type: "run_started",
            agentName: "test",
            model: "anthropic:claude-3-sonnet",
            input: "test",
          },
          { runId: validId, seq: 1 }
        );

        await expect(store.append(event)).resolves.not.toThrow();
        const events = await store.read(validId);
        expect(events).toHaveLength(1);
      }
    });
  });

  describe("empty runs", () => {
    it("list returns empty array when no runs exist", async () => {
      const runs = await store.list();
      expect(runs).toEqual([]);
    });
  });

  describe("empty run file", () => {
    it("returns empty array for empty run file", async () => {
      const filePath = path.join(tempDir, "empty-run.jsonl");
      await fs.writeFile(filePath, "", "utf-8");

      const events = await store.read("empty-run");
      expect(events).toEqual([]);
    });
  });
});
