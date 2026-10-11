import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { Agent, Policy, tool } from "../../src/index.js";

interface Record {
  id: string;
  status: "pending" | "shipped" | "cancelled";
  description?: string;
}

const SEED_RECORDS: Record[] = [
  { id: "A-17", status: "pending", description: "Order #17" },
  { id: "B-2", status: "pending", description: "Order #2" },
  { id: "C-9", status: "pending", description: "Order #9" },
];

async function loadRecords(recordsPath: string): Promise<Record[]> {
  try {
    const content = await fs.readFile(recordsPath, "utf-8");
    return JSON.parse(content) as Record[];
  } catch {
    return SEED_RECORDS;
  }
}

async function saveRecords(
  recordsPath: string,
  records: Record[],
): Promise<void> {
  await fs.writeFile(recordsPath, JSON.stringify(records, null, 2), "utf-8");
}

export async function resetDemoData(runsDir: string): Promise<void> {
  const recordsPath = path.join(runsDir, "demo-records.json");
  await saveRecords(recordsPath, SEED_RECORDS);
}

function createDemoAgent(
  runsDir: string,
  model: string = "anthropic:claude-haiku-4-5-20251001"
): Agent {
  const recordsPath = path.join(runsDir, "demo-records.json");

  const lookupRecord = tool({
    name: "lookup_record",
    description: "Look up a record by ID",
    input: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const records = await loadRecords(recordsPath);
      const found = records.find((r) => r.id === id);
      if (!found) {
        return { id, found: false };
      }
      return found;
    },
    requiresApproval: false,
  });

  const updateStatus = tool({
    name: "update_status",
    description:
      "Update the status of a record (pending, shipped, or cancelled)",
    input: z.object({
      id: z.string(),
      status: z.enum(["pending", "shipped", "cancelled"]),
    }),
    execute: async ({ id, status }) => {
      const records = await loadRecords(recordsPath);
      const record = records.find((r) => r.id === id);
      if (!record) {
        return { error: `Record ${id} not found` };
      }
      const previous = record.status;
      record.status = status;
      await saveRecords(recordsPath, records);
      return { id, status, previous };
    },
    requiresApproval: true,
  });

  const deleteRecord = tool({
    name: "delete_record",
    description: "Delete a record by ID",
    input: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const records = await loadRecords(recordsPath);
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) {
        return { error: `Record ${id} not found` };
      }
      const deleted = records[index];
      records.splice(index, 1);
      await saveRecords(recordsPath, records);
      return { deleted };
    },
    requiresApproval: false,
  });

  return new Agent({
    name: "demo-agent",
    model,
    instructions: `You are a helpful order management assistant. Always look up a record before changing it.
To change or delete a record, call the tool directly. Do NOT ask the user for confirmation in text,
because approval is handled by the system. If a tool is denied or rejected, say so plainly.
Finish with a one-sentence summary of what was done.`,
    tools: [lookupRecord, updateStatus, deleteRecord],
    hooks: [Policy({ allow: ["lookup_record"], deny: ["delete_*"] })],
    maxSteps: 10,
  });
}

export const agent = createDemoAgent(process.env.KERN_DEMO_DIR ?? "runs");

export { createDemoAgent };
