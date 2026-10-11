import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { FakeModel, Runner, deriveState, formatTrace, JsonlRunStore } from "../../src/index.js";
import { createDemoAgent, resetDemoData } from "./agent.js";

export interface DemoOptions {
  runsDir?: string;
  out?: { write: (str: string) => void };
}

export async function runDemo(opts?: DemoOptions): Promise<ReturnType<typeof deriveState>> {
  // Use temp dir for isolation if no runsDir provided
  const runsDir = opts?.runsDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "kern-demo-")));
  const out = opts?.out ?? { write: (s: string) => process.stdout.write(s) };

  // Initialize demo data
  await resetDemoData(runsDir);

  const agent = createDemoAgent(runsDir);

  // Set up FakeModel with scripted responses
  const fakeModel = new FakeModel([
    {
      text: "I'll help you with that. Let me first look up the record.",
      toolCalls: [{ id: "call-1", name: "lookup_record", args: { id: "A-17" } }],
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "tool_use",
    },
    {
      text: "Now I'll update the status to shipped.",
      toolCalls: [
        { id: "call-2", name: "update_status", args: { id: "A-17", status: "shipped" } },
      ],
      usage: { inputTokens: 200, outputTokens: 75 },
      stopReason: "tool_use",
    },
    {
      text: "Record A-17 has been successfully updated from pending to shipped.",
      toolCalls: [],
      usage: { inputTokens: 250, outputTokens: 50 },
      stopReason: "end_turn",
    },
  ]);

  const runner = new Runner({
    runsDir,
    models: [{ provider: "fake", generate: (req) => fakeModel.generate(req) }],
  });

  // Phase 1: Run until paused
  out.write("=== Phase 1: Initial run ===\n");
  const allEvents = [];
  let runId = "";

  for await (const event of runner.stream(agent, "Update record A-17 status to shipped")) {
    allEvents.push(event);
    if (event.type === "run_started") {
      runId = event.runId;
    }
    if (event.type === "run_paused") {
      out.write(`Paused at event #${event.seq}, approving the pending call...\n`);
    }
  }

  // Phase 2: Approve and resume
  out.write("\n=== Phase 2: Approve and resume ===\n");
  const fakeModel2 = new FakeModel([
    {
      text: "Record A-17 has been successfully updated from pending to shipped.",
      toolCalls: [],
      usage: { inputTokens: 250, outputTokens: 50 },
      stopReason: "end_turn",
    },
  ]);

  const runner2 = new Runner({
    runsDir,
    models: [{ provider: "fake", generate: (req) => fakeModel2.generate(req) }],
  });

  for await (const event of runner2.resumeStream(agent, runId, {
    decision: { approved: true },
  })) {
    allEvents.push(event);
  }

  // Phase 3: Load full history and show trace
  out.write("\n=== Phase 3: Full trace ===\n");
  const store = new JsonlRunStore(runsDir);
  const storedEvents = await store.read(runId);

  const trace = formatTrace(storedEvents);
  out.write(trace + "\n");

  // Verify the final state
  const finalState = deriveState(storedEvents);

  out.write(`\n=== Demo completed ===\n`);
  out.write(`Run ID: ${runId}\n`);
  out.write(`Status: ${finalState.status}\n`);
  out.write(`Steps: ${finalState.steps}\n`);

  // Show JSONL path
  const jsonlPath = path.join(runsDir, `${runId}.jsonl`);
  out.write(`\nEvents stored in: ${path.resolve(jsonlPath)}\n`);

  // Equivalent CLI commands
  out.write(`\nEquivalent CLI commands:\n`);
  out.write(`  npm run kern -- run "Update record A-17 status to shipped" --agent examples/demo/agent.ts --runs-dir ${runsDir}\n`);
  out.write(`  npm run kern -- approve ${runId} --agent examples/demo/agent.ts --runs-dir ${runsDir}\n`);
  out.write(`  npm run kern -- trace ${runId} --runs-dir ${runsDir}\n`);
  out.write(`  cat ${path.resolve(jsonlPath)}\n`);

  return finalState;
}

// Only run if executed directly (not imported)
runDemo().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});
