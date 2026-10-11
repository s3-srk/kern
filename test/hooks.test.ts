/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { Policy, type Hook } from "../src/index.js";
import { resolvePolicy } from "../src/hooks.js";

describe("resolvePolicy", () => {
  const mockCtx = {
    runId: "test-run",
    call: { id: "call-1", name: "delete_file", args: {} },
    tool: {
      name: "delete_file",
      description: "Delete a file",
      input: {} as any,
      requiresApproval: false,
      execute: async () => ({}),
    },
    input: {},
  };

  it("deny > ask > allow precedence", async () => {
    const denyHook: Hook = {
      name: "deny",
      beforeToolCall: () => ({ decision: "deny", reason: "test deny" }),
    };

    const askHook: Hook = {
      name: "ask",
      beforeToolCall: () => ({ decision: "ask", reason: "test ask" }),
    };

    const allowHook: Hook = {
      name: "allow",
      beforeToolCall: () => ({ decision: "allow" }),
    };

    // ask + deny → deny
    const result1 = await resolvePolicy([askHook, denyHook], mockCtx, false);
    expect(result1.decision).toBe("deny");
    expect(result1.source).toBe("deny");

    // allow + deny → deny
    const result2 = await resolvePolicy([allowHook, denyHook], mockCtx, false);
    expect(result2.decision).toBe("deny");

    // allow + ask → ask
    const result3 = await resolvePolicy([allowHook, askHook], mockCtx, false);
    expect(result3.decision).toBe("ask");

    // all three: deny wins
    const result4 = await resolvePolicy(
      [allowHook, askHook, denyHook],
      mockCtx,
      false
    );
    expect(result4.decision).toBe("deny");
  });

  it("hook that throws becomes deny", async () => {
    const throwingHook: Hook = {
      name: "thrower",
      beforeToolCall: () => {
        throw new Error("hook failed");
      },
    };

    const result = await resolvePolicy([throwingHook], mockCtx, false);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("hook thrower threw");
    expect(result.source).toBe("thrower");
  });

  it("no hooks + no requiresApproval → allow", async () => {
    const result = await resolvePolicy([], mockCtx, false);
    expect(result.decision).toBe("allow");
    expect(result.source).toBe("default");
  });

  it("no hooks + requiresApproval → ask", async () => {
    const result = await resolvePolicy([], mockCtx, true);
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("tool requires approval");
    expect(result.source).toBe("requiresApproval");
  });

  it("requiresApproval overrides allow → ask", async () => {
    const allowHook: Hook = {
      name: "allow",
      beforeToolCall: () => ({ decision: "allow" }),
    };

    const result = await resolvePolicy([allowHook], mockCtx, true);
    expect(result.decision).toBe("ask");
    expect(result.source).toBe("requiresApproval");
  });

  it("requiresApproval does not override deny", async () => {
    const denyHook: Hook = {
      name: "deny",
      beforeToolCall: () => ({ decision: "deny", reason: "denied" }),
    };

    const result = await resolvePolicy([denyHook], mockCtx, true);
    expect(result.decision).toBe("deny");
  });
});

describe("Policy", () => {
  const mockTool = {
    name: "test_tool",
    description: "Test tool",
    input: {} as any,
    requiresApproval: false,
    execute: async () => ({}),
  };

  const mockCtx = {
    runId: "test-run",
    call: { id: "call-1", name: "delete_file", args: {} },
    tool: mockTool,
    input: {},
  };

  it("deny pattern: *delete* matches delete_file", () => {
    const policy = Policy({ deny: ["*delete*"] });
    const result = policy.beforeToolCall?.({
      ...mockCtx,
      call: { id: "call-1", name: "delete_file", args: {} },
    }) as any;
    expect(result?.decision).toBe("deny");
  });

  it("deny pattern: exact match", () => {
    const policy = Policy({ deny: ["delete_file"] });
    const result = policy.beforeToolCall?.({
      ...mockCtx,
      call: { id: "call-1", name: "delete_file", args: {} },
    }) as any;
    expect(result?.decision).toBe("deny");
  });

  it("deny * matches everything", () => {
    const policy = Policy({ deny: ["*"] });
    const result = policy.beforeToolCall?.({
      ...mockCtx,
      call: { id: "call-1", name: "any_tool", args: {} },
    }) as any;
    expect(result?.decision).toBe("deny");
  });

  it("allow pattern returns allow", () => {
    const policy = Policy({ allow: ["safe_tool"] });
    const result = policy.beforeToolCall?.({
      ...mockCtx,
      call: { id: "call-1", name: "safe_tool", args: {} },
    }) as any;
    expect(result?.decision).toBe("allow");
  });

  it("ask pattern returns ask", () => {
    const policy = Policy({ ask: ["write_*"] });
    const result = policy.beforeToolCall?.({
      ...mockCtx,
      call: { id: "call-1", name: "write_file", args: {} },
    }) as any;
    expect(result?.decision).toBe("ask");
  });

  it("no matching pattern returns undefined", () => {
    const policy = Policy({ deny: ["delete_*"], allow: ["safe_*"] });
    const result = policy.beforeToolCall?.({
      ...mockCtx,
      call: { id: "call-1", name: "other_tool", args: {} },
    });
    expect(result).toBeUndefined();
  });
});
