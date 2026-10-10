/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import type { ToolSpec } from "./messages.js";

export interface ToolContext {
  runId: string;
  callId: string;
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  input: z.ZodObject<any>;
  requiresApproval: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<unknown> | unknown;
}

export function tool<T extends z.ZodObject<any>>({
  name,
  description,
  input,
  execute,
  requiresApproval = false,
}: {
  name: string;
  description: string;
  input: T;
  execute: (input: z.output<T>, ctx: ToolContext) => Promise<unknown> | unknown;
  requiresApproval?: boolean;
}): Tool {
  return {
    name,
    description,
    input,
    requiresApproval,
    execute: execute as (input: unknown, ctx: ToolContext) => Promise<unknown> | unknown,
  };
}

export function toToolSpec(tool: Tool): ToolSpec {
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  // Remove top-level $schema key
  delete schema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
  };
}

export function validateToolInput(
  tool: Tool,
  raw: unknown
): { ok: true; data: unknown } | { ok: false; error: string } {
  const result = tool.input.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error.toString() };
}
