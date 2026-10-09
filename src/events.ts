// Core types
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  callId: string;
  output: unknown;
  isError: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// Event envelope fields
interface EventEnvelope {
  v: 1;
  seq: number;
  runId: string;
  ts: string; // ISO string
}

// Event types (persisted events)
export interface RunStartedEvent extends EventEnvelope {
  type: "run_started";
  agentName: string;
  model: string;
  input: string;
}

export interface ModelRequestedEvent extends EventEnvelope {
  type: "model_requested";
  step: number;
  messageCount: number;
}

export interface ModelRespondedEvent extends EventEnvelope {
  type: "model_responded";
  step: number;
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string;
  raw?: unknown;
}

export interface ToolStartedEvent extends EventEnvelope {
  type: "tool_started";
  callId: string;
  name: string;
  args: unknown;
}

export interface ToolResultEvent extends EventEnvelope {
  type: "tool_result";
  callId: string;
  output: unknown;
  isError: boolean;
}

export interface PolicyDecidedEvent extends EventEnvelope {
  type: "policy_decided";
  callId: string;
  decision: "allow" | "ask" | "deny";
  reason?: string;
}

export interface RunPausedEvent extends EventEnvelope {
  type: "run_paused";
  reason: "approval";
  callId: string;
}

export interface ApprovalDecidedEvent extends EventEnvelope {
  type: "approval_decided";
  callId: string;
  approved: boolean;
  reason?: string;
}

export interface RunResumedEvent extends EventEnvelope {
  type: "run_resumed";
}

export interface RunCompletedEvent extends EventEnvelope {
  type: "run_completed";
  output: string;
}

export interface RunFailedEvent extends EventEnvelope {
  type: "run_failed";
  error: {
    message: string;
    code: string; // e.g., "max_steps", "model_error", "tool_error", "invalid_state"
  };
}

// Discriminated union of all events
export type KernEvent =
  | RunStartedEvent
  | ModelRequestedEvent
  | ModelRespondedEvent
  | ToolStartedEvent
  | ToolResultEvent
  | PolicyDecidedEvent
  | RunPausedEvent
  | ApprovalDecidedEvent
  | RunResumedEvent
  | RunCompletedEvent
  | RunFailedEvent;

export type EventType = KernEvent["type"];

// NewEvent: event without envelope fields (for callers to construct)
export type NewEvent =
  | Omit<RunStartedEvent, keyof EventEnvelope>
  | Omit<ModelRequestedEvent, keyof EventEnvelope>
  | Omit<ModelRespondedEvent, keyof EventEnvelope>
  | Omit<ToolStartedEvent, keyof EventEnvelope>
  | Omit<ToolResultEvent, keyof EventEnvelope>
  | Omit<PolicyDecidedEvent, keyof EventEnvelope>
  | Omit<RunPausedEvent, keyof EventEnvelope>
  | Omit<ApprovalDecidedEvent, keyof EventEnvelope>
  | Omit<RunResumedEvent, keyof EventEnvelope>
  | Omit<RunCompletedEvent, keyof EventEnvelope>
  | Omit<RunFailedEvent, keyof EventEnvelope>;

// Stamp an event with envelope fields
export interface StampOptions {
  runId: string;
  seq: number;
  now?: () => Date;
}

export function stampEvent(
  newEvent: NewEvent,
  options: StampOptions
): KernEvent {
  const now = options.now ?? (() => new Date());
  const ts = now().toISOString();

  return {
    ...(newEvent as Record<string, unknown>),
    v: 1,
    seq: options.seq,
    runId: options.runId,
    ts,
  } as KernEvent;
}

// Check if an event is terminal
export function isTerminalEvent(event: KernEvent): boolean {
  return event.type === "run_completed" || event.type === "run_failed";
}
