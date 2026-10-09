import { promises as fs } from "fs";
import path from "path";
import { KernEvent } from "./events.js";

export interface RunStore {
  append(event: KernEvent): Promise<void>;
  read(runId: string): Promise<KernEvent[]>;
  list(): Promise<string[]>;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run ID: ${runId}`);
  }
}

export class JsonlRunStore implements RunStore {
  private directory: string;

  constructor(directory = "runs") {
    this.directory = path.resolve(process.cwd(), directory);
  }

  async append(event: KernEvent): Promise<void> {
    validateRunId(event.runId);

    await fs.mkdir(this.directory, { recursive: true });

    const filePath = path.join(this.directory, `${event.runId}.jsonl`);
    const line = JSON.stringify(event) + "\n";

    await fs.appendFile(filePath, line, "utf-8");
  }

  async read(runId: string): Promise<KernEvent[]> {
    validateRunId(runId);

    const filePath = path.join(this.directory, `${runId}.jsonl`);

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Run not found: ${runId}`, { cause: error });
      }
      throw error;
    }

    const events: KernEvent[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!line) {
        // Empty line (normal case: last line after final newline, or empty middle line)
        if (i === lines.length - 1) {
          // Last line is empty - this is normal after a trailing newline
          continue;
        }
        // Empty line in the middle - skip it (shouldn't happen with our append format)
        continue;
      }

      // Try to parse this line
      let event: KernEvent;
      try {
        event = JSON.parse(line);
      } catch {
        // Check if this is a torn write (last line without final newline)
        if (i === lines.length - 1) {
          // This is the last line and parsing failed - it's a torn write, ignore it
          continue;
        }
        // Any other bad line is an error
        throw new Error(`Invalid JSON on line ${i + 1}: ${line}`);
      }

      // Validate the event version
      if (event.v !== 1) {
        throw new Error(
          `Unsupported event version ${event.v} on line ${i + 1}`
        );
      }

      events.push(event);
    }

    return events;
  }

  async list(): Promise<string[]> {
    await fs.mkdir(this.directory, { recursive: true });

    const files = await fs.readdir(this.directory);
    const runIds = files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -6)) // Remove .jsonl extension
      .sort();

    return runIds;
  }
}
