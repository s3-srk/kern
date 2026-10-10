import { describe, it, expect } from "vitest";
import { FakeModel } from "../src/fake-model.js";
import type { ModelRequest } from "../src/messages.js";

describe("FakeModel", () => {
  it("returns scripted responses in order, applies defaults, and records requests", async () => {
    const model = new FakeModel([
      {
        text: "Hello",
        toolCalls: [{ id: "1", name: "tool1", args: { foo: "bar" } }],
      },
      {
        text: "World",
      },
    ]);

    const req1: ModelRequest = {
      model: "test",
      messages: [{ role: "user", text: "test" }],
      tools: [],
    };

    const res1 = await model.generate(req1);

    expect(res1.text).toBe("Hello");
    expect(res1.toolCalls).toHaveLength(1);
    expect(res1.toolCalls[0].name).toBe("tool1");
    expect(res1.stopReason).toBe("tool_use");
    expect(res1.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    const req2: ModelRequest = {
      model: "test",
      messages: [{ role: "user", text: "test2" }],
      tools: [],
    };

    const res2 = await model.generate(req2);

    expect(res2.text).toBe("World");
    expect(res2.toolCalls).toHaveLength(0);
    expect(res2.stopReason).toBe("end_turn");
    expect(res2.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]).toEqual(req1);
    expect(model.requests[1]).toEqual(req2);
  });

  it("receives the request in function script items", async () => {
    const model = new FakeModel([
      (req: ModelRequest) => ({
        text: `Received ${req.messages.length} messages`,
        toolCalls: req.tools.length > 0 ? [{ id: "1", name: "tool", args: {} }] : [],
      }),
    ]);

    const req: ModelRequest = {
      model: "test",
      messages: [
        { role: "user", text: "a" },
        { role: "assistant", text: "b", toolCalls: [] },
      ],
      tools: [{ name: "myTool", description: "does something", inputSchema: {} }],
    };

    const res = await model.generate(req);

    expect(res.text).toBe("Received 2 messages");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.stopReason).toBe("tool_use");
    expect(model.requests).toHaveLength(1);
  });

  it("throws when script is exhausted", async () => {
    const model = new FakeModel([{ text: "only response" }]);

    const req: ModelRequest = {
      model: "test",
      messages: [{ role: "user", text: "test" }],
      tools: [],
    };

    await model.generate(req);

    await expect(model.generate(req)).rejects.toThrow(
      /FakeModel script exhausted/
    );
  });
});
