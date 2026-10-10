import type { ModelAdapter, ModelRequest, ModelResponse } from "./messages.js";

type ScriptItem =
  | Partial<ModelResponse>
  | ((req: ModelRequest) => Partial<ModelResponse>);

/**
 * A deterministic model adapter for testing. Returns scripted responses in order.
 */
export class FakeModel implements ModelAdapter {
  readonly provider = "fake";
  private scriptIndex = 0;
  readonly requests: ModelRequest[] = [];

  constructor(private script: ScriptItem[]) {}

  async generate(
    req: ModelRequest,
    _opts?: { signal?: AbortSignal }
  ): Promise<ModelResponse> {
    this.requests.push(this.deepCopy(req));

    if (this.scriptIndex >= this.script.length) {
      throw new Error(
        `FakeModel script exhausted: no response at index ${this.scriptIndex}`
      );
    }

    const item = this.script[this.scriptIndex];
    this.scriptIndex++;

    const partial =
      typeof item === "function" ? item(req) : this.deepCopy(item);

    return this.applyDefaults(partial);
  }

  private applyDefaults(partial: Partial<ModelResponse>): ModelResponse {
    const toolCalls = partial.toolCalls ?? [];
    const stopReason =
      partial.stopReason ??
      (toolCalls.length > 0 ? "tool_use" : "end_turn");

    return {
      text: partial.text ?? "",
      toolCalls,
      usage: partial.usage ?? { inputTokens: 0, outputTokens: 0 },
      stopReason,
      raw: partial.raw,
    };
  }

  private deepCopy<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
  }
}
