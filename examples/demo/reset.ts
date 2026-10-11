import { promises as fs } from "fs";
import path from "path";
import { resetDemoData } from "./agent.js";

async function reset(): Promise<void> {
  const runsDir = process.env.KERN_DEMO_DIR ?? "runs";

  // Reset the demo data
  await resetDemoData(runsDir);
  console.log(`✓ Demo data reset to seed records in ${runsDir}/demo-records.json`);

  // Delete all JSONL run files
  const dir = runsDir;
  try {
    const files = await fs.readdir(dir);
    let deletedCount = 0;
    for (const file of files) {
      if (file.endsWith(".jsonl")) {
        await fs.unlink(path.join(dir, file));
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`✓ Deleted ${deletedCount} run file(s)`);
    }
  } catch {
    // Directory might not exist yet, that's OK
  }

  console.log(`✓ Demo directory ready: ${path.resolve(dir)}`);
}

reset().catch((error) => {
  console.error("Reset failed:", error);
  process.exit(1);
});
