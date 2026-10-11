import type { Tool } from "./tools.js";
import type { Hook } from "./hooks.js";

export interface AgentConfig {
  name: string;
  model: string;
  instructions: string;
  tools?: Tool[];
  hooks?: Hook[];
  maxSteps?: number;
}

const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export class Agent {
  readonly name: string;
  readonly model: string;
  readonly instructions: string;
  readonly tools: Tool[];
  readonly hooks: Hook[];
  readonly maxSteps: number;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.model = config.model;
    this.instructions = config.instructions;
    this.tools = config.tools ?? [];
    this.hooks = config.hooks ?? [];
    this.maxSteps = config.maxSteps ?? 10;

    this.validate();
  }

  private validate(): void {
    // Check for duplicate tool names
    const toolNames = this.tools.map((t) => t.name);
    const uniqueNames = new Set(toolNames);
    if (toolNames.length !== uniqueNames.size) {
      const duplicates = toolNames.filter(
        (name, i) => toolNames.indexOf(name) !== i
      );
      throw new Error(`Duplicate tool names: ${[...new Set(duplicates)].join(", ")}`);
    }

    // Check tool name format
    for (const tool of this.tools) {
      if (!TOOL_NAME_REGEX.test(tool.name)) {
        throw new Error(
          `Tool name "${tool.name}" does not match /^[a-zA-Z0-9_-]{1,64}$/`
        );
      }
    }

    // Check model format: "provider:id"
    const [provider, id] = this.model.split(":");
    if (!provider || !id) {
      throw new Error(
        `Model must be in "provider:id" form, got "${this.model}"`
      );
    }

    // Check maxSteps
    if (this.maxSteps < 1) {
      throw new Error(`maxSteps must be >= 1, got ${this.maxSteps}`);
    }
  }
}
