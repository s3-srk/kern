import { describe, it, expect } from "vitest";

describe("smoke test", () => {
  it("imports from src/index", async () => {
    // Import the public entry point
    const mod = await import("../src/index.js");
    expect(mod).toBeDefined();
  });
});
