import { describe, it, expect } from "vitest";
import {
  stampEvent,
  isTerminalEvent,
  KernEvent,
  NewEvent,
  ToolCall,
} from "../src/index.js";

describe("events", () => {
  describe("stampEvent", () => {
    it("sets v, seq, runId from options", () => {
      const newEvent: NewEvent = {
        type: "run_started",
        agentName: "test-agent",
        model: "anthropic:claude-3-sonnet",
        instructions: "Be helpful",
        input: "Hello",
      };

      const event = stampEvent(newEvent, {
        runId: "run-123",
        seq: 1,
      });

      expect(event.v).toBe(1);
      expect(event.seq).toBe(1);
      expect(event.runId).toBe("run-123");
      expect(event.ts).toBeDefined();
      expect(typeof event.ts).toBe("string");
    });

    it("uses injected clock for ts", () => {
      const fixedDate = new Date("2026-10-09T12:00:00Z");
      const newEvent: NewEvent = {
        type: "run_started",
        agentName: "test-agent",
        model: "anthropic:claude-3-sonnet",
        instructions: "Be helpful",
        input: "Hello",
      };

      const event = stampEvent(newEvent, {
        runId: "run-123",
        seq: 1,
        now: () => fixedDate,
      });

      expect(event.ts).toBe("2026-10-09T12:00:00.000Z");
    });

    it("preserves all event fields", () => {
      const toolCall: ToolCall = {
        id: "tool-1",
        name: "lookup",
        args: { id: "A-17" },
      };

      const newEvent: NewEvent = {
        type: "model_responded",
        step: 2,
        text: "I found the record",
        toolCalls: [toolCall],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "tool_use",
      };

      const event = stampEvent(newEvent, {
        runId: "run-456",
        seq: 5,
      });

      expect(event.type).toBe("model_responded");
      if (event.type === "model_responded") {
        expect(event.step).toBe(2);
        expect(event.text).toBe("I found the record");
        expect(event.toolCalls).toEqual([toolCall]);
        expect(event.usage).toEqual({
          inputTokens: 100,
          outputTokens: 50,
        });
      }
    });
  });

  describe("isTerminalEvent", () => {
    it("returns true for run_completed", () => {
      const event = stampEvent(
        {
          type: "run_completed",
          output: "Task completed",
        },
        { runId: "run-1", seq: 10 }
      );

      expect(isTerminalEvent(event)).toBe(true);
    });

    it("returns true for run_failed", () => {
      const event = stampEvent(
        {
          type: "run_failed",
          error: {
            message: "Max steps exceeded",
            code: "max_steps",
          },
        },
        { runId: "run-2", seq: 10 }
      );

      expect(isTerminalEvent(event)).toBe(true);
    });

    it("returns false for non-terminal events", () => {
      const events = [
        stampEvent(
          {
            type: "run_started",
            agentName: "test",
            model: "anthropic:claude-3-sonnet",
            instructions: "Test instructions",
          input: "test",
          },
          { runId: "run-3", seq: 1 }
        ),
        stampEvent(
          {
            type: "model_requested",
            step: 1,
            messageCount: 1,
          },
          { runId: "run-3", seq: 2 }
        ),
        stampEvent(
          {
            type: "tool_started",
            callId: "tool-1",
            name: "lookup",
            args: {},
          },
          { runId: "run-3", seq: 3 }
        ),
        stampEvent(
          {
            type: "run_paused",
            reason: "approval",
            callId: "tool-1",
          },
          { runId: "run-3", seq: 4 }
        ),
      ];

      events.forEach((e) => {
        expect(isTerminalEvent(e)).toBe(false);
      });
    });
  });

  describe("exhaustiveness check", () => {
    it("type-checks all event types", () => {
      const checkExhaustiveness = (event: KernEvent): void => {
        switch (event.type) {
          case "run_started":
          case "model_requested":
          case "model_responded":
          case "tool_started":
          case "tool_result":
          case "policy_decided":
          case "run_paused":
          case "approval_decided":
          case "run_resumed":
          case "run_completed":
          case "run_failed":
            break;
          default: {
            const _exhaustive: never = event;
            throw new Error(`Unhandled event type: ${_exhaustive}`);
          }
        }
      };

      const events = [
        stampEvent(
          {
            type: "run_started",
            agentName: "test",
            model: "anthropic:claude-3-sonnet",
            instructions: "Test instructions",
          input: "test",
          },
          { runId: "run-4", seq: 1 }
        ),
        stampEvent(
          {
            type: "model_requested",
            step: 1,
            messageCount: 1,
          },
          { runId: "run-4", seq: 2 }
        ),
      ];

      events.forEach((e) => {
        checkExhaustiveness(e);
      });
    });
  });
});
