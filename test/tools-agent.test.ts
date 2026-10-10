/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool, toToolSpec, validateToolInput, Agent } from "../src/index.js";

describe("tool and Agent", () => {
  it("tool produces a ToolSpec with no $schema, and validateToolInput works", () => {
    const lookup = tool({
      name: "lookup",
      description: "Look up a record",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ result: id }),
    });

    const spec = toToolSpec(lookup);
    expect(spec.name).toBe("lookup");
    expect(spec.description).toBe("Look up a record");
    expect(spec.inputSchema).toBeDefined();
    expect(spec.inputSchema.$schema).toBeUndefined();
    expect((spec.inputSchema as any).type).toBe("object");
    expect((spec.inputSchema as any).properties?.id).toBeDefined();
    expect((spec.inputSchema as any).required).toContain("id");

    // Valid input passes
    const validResult = validateToolInput(lookup, { id: "test" });
    expect(validResult.ok).toBe(true);
    if (validResult.ok) {
      expect(validResult.data).toEqual({ id: "test" });
    }

    // Invalid input returns error string
    const invalidResult = validateToolInput(lookup, { id: 123 });
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) {
      expect(typeof invalidResult.error).toBe("string");
      expect(invalidResult.error.length).toBeGreaterThan(0);
    }
  });

  it("Agent constructor rejects duplicate tool names and malformed model", () => {
    const tool1 = tool({
      name: "tool_a",
      description: "Tool A",
      input: z.object({}),
      execute: async () => ({}),
    });

    const tool2 = tool({
      name: "tool_a",
      description: "Tool A duplicate",
      input: z.object({}),
      execute: async () => ({}),
    });

    const tool3 = tool({
      name: "tool-b",
      description: "Tool B",
      input: z.object({}),
      execute: async () => ({}),
    });

    // Duplicate names should throw
    expect(() => {
      new Agent({
        name: "test-agent",
        model: "fake:test",
        instructions: "Test",
        tools: [tool1, tool2],
      });
    }).toThrow(/Duplicate tool names/);

    // Malformed model (missing provider or id) should throw
    expect(() => {
      new Agent({
        name: "test-agent",
        model: "nocolon",
        instructions: "Test",
        tools: [tool1],
      });
    }).toThrow(/provider:id/);

    expect(() => {
      new Agent({
        name: "test-agent",
        model: "provider:",
        instructions: "Test",
        tools: [tool1],
      });
    }).toThrow(/provider:id/);

    // Valid agent should be created
    const agent = new Agent({
      name: "test-agent",
      model: "anthropic:claude-3-5-sonnet",
      instructions: "Test",
      tools: [tool1, tool3],
    });

    expect(agent.name).toBe("test-agent");
    expect(agent.model).toBe("anthropic:claude-3-5-sonnet");
    expect(agent.tools).toHaveLength(2);
    expect(agent.maxSteps).toBe(10);
  });

  it("type inference works for tool execute input", () => {
    const myTool = tool({
      name: "my_tool",
      description: "A tool",
      input: z.object({ id: z.string(), count: z.number().optional() }),
      execute: async ({ id, count }) => {
        // This line should type-check without casts
        const idStr: string = id;
        const countNum: number | undefined = count;
        return { idStr, countNum };
      },
    });

    expect(myTool).toBeDefined();
    expect(myTool.name).toBe("my_tool");
  });
});
