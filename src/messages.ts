import type { ToolCall, ToolResult, Usage } from "./events.js";

// Message types as discriminated union
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

// Tool schema as JSON Schema object (plain type, no Zod)
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Request and response types
export interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string;
  raw?: unknown;
}

// Model adapter interface
export interface ModelAdapter {
  readonly provider: string;
  generate(
    req: ModelRequest,
    opts?: { signal?: AbortSignal }
  ): Promise<ModelResponse>;
}
