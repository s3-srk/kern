import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
} from "./messages.js";
import type { ToolCall, ToolResult } from "./events.js";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContent[];
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicResponse {
  content: AnthropicContent[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: AnthropicMessage[];
      tools: Array<{ name: string; description: string; input_schema: unknown }>;
      signal?: AbortSignal;
    }): Promise<AnthropicResponse>;
  };
}

export interface AnthropicAdapterOptions {
  apiKey?: string;
  client?: unknown;
  defaultMaxTokens?: number;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic";
  private cachedClient: AnthropicClient | null = null;
  private readonly apiKey: string | undefined;
  private readonly defaultMaxTokens: number;
  private readonly injectedClient: AnthropicClient | undefined;

  constructor(options?: AnthropicAdapterOptions) {
    this.apiKey = options?.apiKey;
    this.defaultMaxTokens = options?.defaultMaxTokens ?? 4096;
    this.injectedClient = options?.client as AnthropicClient | undefined;
  }

  private async getClientAsync(): Promise<AnthropicClient> {
    if (this.cachedClient !== null) {
      return this.cachedClient;
    }

    let client: AnthropicClient;

    if (this.injectedClient) {
      client = this.injectedClient;
    } else {
      // Lazy load Anthropic SDK using dynamic import (ESM)
      const module = await import("@anthropic-ai/sdk");
      const AnthropicConstructor = module.default;
      client = new AnthropicConstructor({
        apiKey: this.apiKey || process.env.ANTHROPIC_API_KEY,
      }) as AnthropicClient;
    }

    this.cachedClient = client;
    return client;
  }


  async generate(
    req: ModelRequest,
    opts?: { signal?: AbortSignal }
  ): Promise<ModelResponse> {
    const client = await this.getClientAsync();

    const messages = this.convertMessages(req.messages);

    const response = (await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      system: req.system,
      messages,
      tools: req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      signal: opts?.signal,
    })) as AnthropicResponse;

    return this.convertResponse(response);
  }

  private convertMessages(
    messages: Array<{ role: string; text?: string; toolCalls?: ToolCall[]; results?: ToolResult[] }>
  ): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        result.push({
          role: "user",
          content: [{ type: "text", text: msg.text || "" }],
        });
      } else if (msg.role === "assistant") {
        const content: AnthropicContent[] = [];

        if (msg.text) {
          content.push({ type: "text", text: msg.text });
        }

        if (msg.toolCalls) {
          for (const call of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.args,
            });
          }
        }

        result.push({
          role: "assistant",
          content,
        });
      } else if (msg.role === "tool") {
        const content: AnthropicContent[] = [];

        if (msg.results) {
          for (const result_ of msg.results) {
            content.push({
              type: "tool_result",
              tool_use_id: result_.callId,
              content:
                typeof result_.output === "string"
                  ? result_.output
                  : JSON.stringify(result_.output),
              is_error: result_.isError,
            });
          }
        }

        result.push({
          role: "user",
          content,
        });
      }
    }

    return result;
  }

  private convertResponse(response: AnthropicResponse): ModelResponse {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input,
        });
      }
    }

    return {
      text: textParts.join("\n"),
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason,
      raw: response.content,
    };
  }
}
