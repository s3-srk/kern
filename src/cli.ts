import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { Agent } from "./agent.js";
import type { ModelAdapter } from "./messages.js";
import { Runner } from "./runner.js";
import { JsonlRunStore } from "./store.js";
import { deriveState, type RunState } from "./state.js";
import { formatTrace } from "./trace.js";
import type { KernEvent } from "./events.js";

export interface CliIO {
  stdout?: { write: (str: string) => void };
  stderr?: { write: (str: string) => void };
  runner?: Runner;
  loadAgent?: (modulePath: string) => Promise<{
    agent: Agent;
    models?: ModelAdapter[];
  }>;
}

function formatEventLine(event: KernEvent): string {
  function formatPreview(value: unknown, maxChars = 120): string {
    let str: string;
    if (typeof value === "string") {
      str = value;
    } else {
      str = JSON.stringify(value);
    }
    str = str.replace(/\s+/g, " ");
    if (str.length > maxChars) {
      return str.slice(0, maxChars) + "…";
    }
    return str;
  }

  const types = [
    "run_started",
    "model_requested",
    "model_responded",
    "tool_started",
    "tool_result",
    "policy_decided",
    "run_paused",
    "approval_decided",
    "run_resumed",
    "run_completed",
    "run_failed",
  ];
  const maxLen = Math.max(...types.map((t) => t.length));
  const paddedType = event.type.padEnd(maxLen);

  let details = "";

  switch (event.type) {
    case "run_started":
      details = `agent=${event.agentName} model=${event.model} input=${formatPreview(event.input)}`;
      break;
    case "model_requested":
      details = `step=${event.step} messageCount=${event.messageCount}`;
      break;
    case "model_responded": {
      const toolNames = event.toolCalls.map((c) => `${c.name}(${c.id})`).join(" ");
      const textPreview = formatPreview(event.text);
      details = `step=${event.step} stopReason=${event.stopReason} usage=${event.usage.inputTokens}/${event.usage.outputTokens} text=${textPreview}`;
      if (toolNames) {
        details += ` tools=${toolNames}`;
      }
      break;
    }
    case "tool_started":
      details = `tool=${event.name} callId=${event.callId} input=${formatPreview(event.args)}`;
      break;
    case "tool_result":
      details = `callId=${event.callId} ${event.isError ? "error" : "ok"} output=${formatPreview(event.output)}`;
      break;
    case "policy_decided":
      details = `callId=${event.callId} decision=${event.decision} source=${event.source}`;
      break;
    case "run_paused":
      details = `callId=${event.callId}`;
      break;
    case "approval_decided":
      details = `callId=${event.callId} ${event.approved ? "approved" : "rejected"}`;
      break;
    case "run_resumed":
      break;
    case "run_completed":
      details = `output=${formatPreview(event.output)}`;
      break;
    case "run_failed":
      details = `error=${event.error.code} ${event.error.message}`;
      break;
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled event type: ${_exhaustive}`);
    }
  }

  return `#${event.seq} ${paddedType} ${details}`.trimEnd();
}

function formatSummary(
  state: RunState,
  events: KernEvent[],
  agentPath?: string,
  runsDir?: string
): string {
  let output = `Run ${state.runId}\n`;

  switch (state.status) {
    case "completed": {
      output += `Completed in ${state.steps} steps.\n`;
      if (state.output) {
        output += `\n${state.output}\n`;
      }
      output += `\nDetails: npm run kern -- trace ${state.runId}`;
      if (runsDir && runsDir !== "runs") {
        output += ` --runs-dir ${runsDir}`;
      }
      output += "\n";
      break;
    }

    case "paused": {
      const pending = state.pending;
      if (pending) {
        function formatArgs(args: unknown, maxChars = 80): string {
          let str = JSON.stringify(args);
          if (str.length > maxChars) {
            str = str.slice(0, maxChars) + "…";
          }
          return str;
        }

        output += `Waiting for approval: ${pending.call.name} ${formatArgs(pending.call.args)}\n`;
      }
      output += `\nRun saved. This process can exit; approve or reject later:\n`;
      output += `  npm run kern -- approve ${state.runId} --agent ${agentPath}`;
      if (runsDir && runsDir !== "runs") {
        output += ` --runs-dir ${runsDir}`;
      }
      output += "\n";
      output += `  npm run kern -- reject ${state.runId} --agent ${agentPath}`;
      if (runsDir && runsDir !== "runs") {
        output += ` --runs-dir ${runsDir}`;
      }
      output += "\n";
      break;
    }

    case "failed": {
      output += `Failed: ${state.error?.message}\n`;
      output += `\nDetails: npm run kern -- trace ${state.runId}`;
      if (runsDir && runsDir !== "runs") {
        output += ` --runs-dir ${runsDir}`;
      }
      output += "\n";
      break;
    }

    default:
      output += `${state.status}\n`;
  }

  return output;
}

async function loadAgent(
  modulePath: string,
  loadAgentFn?: (path: string) => Promise<{ agent: Agent; models?: ModelAdapter[] }>
): Promise<{ agent: Agent; models?: ModelAdapter[] }> {
  if (loadAgentFn) {
    return loadAgentFn(modulePath);
  }

  const absolutePath = path.resolve(process.cwd(), modulePath);
  const url = pathToFileURL(absolutePath).href;
  const module = await import(url);

  if (!module.agent) {
    throw new Error(`Module ${modulePath} does not export 'agent'`);
  }

  return {
    agent: module.agent,
    models: module.models,
  };
}

export async function main(
  argv: string[],
  io?: CliIO
): Promise<number> {
  const stdout = io?.stdout ?? { write: (s: string) => process.stdout.write(s) };
  const stderr = io?.stderr ?? { write: (s: string) => process.stderr.write(s) };

  try {
    const result = parseArgs({
      args: argv,
      options: {
        "runs-dir": { type: "string", default: "runs" },
        "run-id": { type: "string" },
        agent: { type: "string" },
        events: { type: "boolean", default: false },
      },
      strict: false,
    });

    const runsDir = result.values["runs-dir"] as string;
    const showEvents = result.values.events as boolean;
    const command = result.positionals[0];

    if (!command) {
      stderr.write("Error: No command specified\n");
      return 2;
    }

    const runner =
      io?.runner ??
      new Runner({
        runsDir,
        models: undefined,
      });

    switch (command) {
      case "run": {
        const input = result.positionals[1];
        const agentPath = result.values.agent as string | undefined;

        if (!input || !agentPath) {
          stderr.write("Error: 'run' requires <input> and --agent <path>\n");
          return 2;
        }

        const { agent, models } = await loadAgent(agentPath, io?.loadAgent);
        const actualRunner = models
          ? new Runner({ runsDir, models })
          : runner;

        const runId = (result.values["run-id"] as string | undefined) ?? undefined;
        const events: KernEvent[] = [];

        for await (const event of actualRunner.stream(agent, input, { runId })) {
          events.push(event);
          if (showEvents) {
            stdout.write(formatEventLine(event) + "\n");
          }
        }

        const state = deriveState(events);
        stdout.write(formatSummary(state, events, agentPath, runsDir !== "runs" ? runsDir : undefined));

        return state.status === "paused" || state.status === "completed" ? 0 : 1;
      }

      case "approve": {
        const runId = result.positionals[1];
        const agentPath = result.values.agent as string | undefined;

        if (!runId || !agentPath) {
          stderr.write("Error: 'approve' requires <runId> and --agent <path>\n");
          return 2;
        }

        const { agent, models } = await loadAgent(agentPath, io?.loadAgent);
        const actualRunner = models
          ? new Runner({ runsDir, models })
          : runner;

        const store = new JsonlRunStore(runsDir);
        const existingEvents = await store.read(runId);
        const newEvents: KernEvent[] = [];

        for await (const event of actualRunner.resumeStream(agent, runId, {
          decision: { approved: true },
        })) {
          newEvents.push(event);
          if (showEvents) {
            stdout.write(formatEventLine(event) + "\n");
          }
        }

        const allEvents = [...existingEvents, ...newEvents];
        const state = deriveState(allEvents);
        stdout.write(formatSummary(state, allEvents, agentPath, runsDir !== "runs" ? runsDir : undefined));

        return state.status === "paused" || state.status === "completed" ? 0 : 1;
      }

      case "reject": {
        const runId = result.positionals[1];
        const agentPath = result.values.agent as string | undefined;

        if (!runId || !agentPath) {
          stderr.write("Error: 'reject' requires <runId> and --agent <path>\n");
          return 2;
        }

        const { agent, models } = await loadAgent(agentPath, io?.loadAgent);
        const actualRunner = models
          ? new Runner({ runsDir, models })
          : runner;

        const store = new JsonlRunStore(runsDir);
        const existingEvents = await store.read(runId);
        const newEvents: KernEvent[] = [];

        for await (const event of actualRunner.resumeStream(agent, runId, {
          decision: { approved: false },
        })) {
          newEvents.push(event);
          if (showEvents) {
            stdout.write(formatEventLine(event) + "\n");
          }
        }

        const allEvents = [...existingEvents, ...newEvents];
        const state = deriveState(allEvents);
        stdout.write(formatSummary(state, allEvents, agentPath, runsDir !== "runs" ? runsDir : undefined));

        return state.status === "paused" || state.status === "completed" ? 0 : 1;
      }

      case "resume": {
        const runId = result.positionals[1];
        const agentPath = result.values.agent as string | undefined;

        if (!runId || !agentPath) {
          stderr.write("Error: 'resume' requires <runId> and --agent <path>\n");
          return 2;
        }

        const { agent, models } = await loadAgent(agentPath, io?.loadAgent);
        const actualRunner = models
          ? new Runner({ runsDir, models })
          : runner;

        const store = new JsonlRunStore(runsDir);
        const existingEvents = await store.read(runId);
        const newEvents: KernEvent[] = [];

        for await (const event of actualRunner.resumeStream(agent, runId)) {
          newEvents.push(event);
          if (showEvents) {
            stdout.write(formatEventLine(event) + "\n");
          }
        }

        const allEvents = [...existingEvents, ...newEvents];
        const state = deriveState(allEvents);
        stdout.write(formatSummary(state, allEvents, agentPath, runsDir !== "runs" ? runsDir : undefined));

        return state.status === "paused" || state.status === "completed" ? 0 : 1;
      }

      case "list": {
        const store = new JsonlRunStore(runsDir);
        const runIds = await store.list();
        for (const runId of runIds) {
          const events = await store.read(runId);
          const state = deriveState(events);
          stdout.write(
            `${runId}  ${state.status}  ${state.steps}\n`
          );
        }
        return 0;
      }

      case "trace": {
        const runId = result.positionals[1];
        if (!runId) {
          stderr.write("Error: 'trace' requires <runId>\n");
          return 2;
        }

        const store = new JsonlRunStore(runsDir);
        const events = await store.read(runId);
        const trace = formatTrace(events);
        stdout.write(trace + "\n");
        return 0;
      }

      default:
        stderr.write(`Error: Unknown command '${command}'\n`);
        return 2;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    stderr.write(`Error: ${message}\n`);
    return 1;
  }
}
