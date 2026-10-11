import type { KernEvent, ToolCall } from "./events.js";
import type { Tool } from "./tools.js";

export interface PolicyDecision {
  decision: "allow" | "ask" | "deny";
  reason?: string;
}

export interface Hook {
  name: string;
  beforeToolCall?(ctx: {
    runId: string;
    call: ToolCall;
    tool: Tool;
    input: unknown;
  }): PolicyDecision | undefined | Promise<PolicyDecision | undefined>;
  onEvent?(event: KernEvent): void | Promise<void>;
}

export function Policy({
  allow,
  ask,
  deny,
}: {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}): Hook {
  const allowPatterns = allow ?? [];
  const askPatterns = ask ?? [];
  const denyPatterns = deny ?? [];

  const matchesPattern = (pattern: string, name: string): boolean => {
    if (pattern === "*") return true;
    if (pattern.includes("*")) {
      const regex = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`
      );
      return regex.test(name);
    }
    return pattern === name;
  };

  return {
    name: "policy",
    beforeToolCall: ({ call }) => {
      const toolName = call.name;

      if (denyPatterns.some((p) => matchesPattern(p, toolName))) {
        return { decision: "deny", reason: `Tool "${toolName}" is denied by policy` };
      }

      if (askPatterns.some((p) => matchesPattern(p, toolName))) {
        return { decision: "ask", reason: `Tool "${toolName}" requires approval` };
      }

      if (allowPatterns.some((p) => matchesPattern(p, toolName))) {
        return { decision: "allow" };
      }

      return undefined;
    },
  };
}

export async function resolvePolicy(
  hooks: Hook[],
  ctx: {
    runId: string;
    call: ToolCall;
    tool: Tool;
    input: unknown;
  },
  toolRequiresApproval: boolean
): Promise<{
  decision: "allow" | "ask" | "deny";
  reason?: string;
  source: string;
}> {
  let result: PolicyDecision | undefined;
  let source = "default";

  for (const hook of hooks) {
    if (!hook.beforeToolCall) continue;

    try {
      const decision = await hook.beforeToolCall(ctx);
      if (!decision) continue;

      if (!result) {
        result = decision;
        source = hook.name;
      } else if (decision.decision === "deny" && result.decision !== "deny") {
        result = decision;
        source = hook.name;
      } else if (
        decision.decision === "ask" &&
        result.decision === "allow"
      ) {
        result = decision;
        source = hook.name;
      }
    } catch (error) {
      return {
        decision: "deny",
        reason: `hook ${hook.name} threw: ${error instanceof Error ? error.message : String(error)}`,
        source: hook.name,
      };
    }
  }

  if (!result) {
    if (toolRequiresApproval) {
      return {
        decision: "ask",
        reason: "tool requires approval",
        source: "requiresApproval",
      };
    }

    return {
      decision: "allow",
      source: "default",
    };
  }

  if (toolRequiresApproval && result.decision !== "deny") {
    return {
      decision: "ask",
      reason: result.reason ?? "tool requires approval",
      source: "requiresApproval",
    };
  }

  return { ...result, source };
}
