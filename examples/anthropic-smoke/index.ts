import { Agent, Runner, tool } from "../../src/index.js";
import { z } from "zod";

// Sample data for the lookup tool
const sampleData: Record<string, { status: string; lastUpdated: string }> = {
  "REC-001": { status: "active", lastUpdated: "2026-10-08" },
  "REC-002": { status: "pending", lastUpdated: "2026-10-07" },
  "REC-003": { status: "archived", lastUpdated: "2026-09-15" },
};

// Define a simple lookup tool
const lookup = tool({
  name: "lookup",
  description: "Look up the status of a record by ID",
  input: z.object({
    id: z.string().describe("The record ID to look up"),
  }),
  execute: async ({ id }) => {
    const record = sampleData[id];
    if (!record) {
      return { error: `Record ${id} not found` };
    }
    return record;
  },
});

// Create an agent that can use the lookup tool
const agent = new Agent({
  name: "smoke-test-agent",
  model: "anthropic:claude-haiku-4-5-20251001",
  instructions:
    "You are a helpful assistant. Use the lookup tool to find information about records. " +
    "Always try to be helpful and provide clear answers based on the information you find.",
  tools: [lookup],
  maxSteps: 5,
});

// Run the agent
async function main(): Promise<void> {
  const runner = new Runner();

  console.log("🔥 Kern Anthropic Smoke Test");
  console.log("=============================\n");
  console.log(`Agent: ${agent.name}`);
  console.log(`Model: ${agent.model}`);
  console.log(`Tools: ${agent.tools.map((t) => t.name).join(", ")}\n`);

  const userInput = "Please look up the status of records REC-001 and REC-003, and tell me which one is most recent.";
  console.log(`User: ${userInput}\n`);

  try {
    const state = await runner.run(agent, userInput);

    console.log(`\nRun Status: ${state.status}`);
    console.log(`Steps: ${state.steps}`);

    if (state.status === "completed" && state.output) {
      console.log(`\n✅ Assistant: ${state.output}`);
    } else if (state.status === "failed" && state.error) {
      console.log(`\n❌ Error: ${state.error.message} (${state.error.code})`);
    }
  } catch (error) {
    console.error("Error running agent:", error);
    process.exit(1);
  }
}

main();
