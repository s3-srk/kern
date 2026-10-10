# Anthropic Smoke Test

A minimal example demonstrating Kern's Anthropic adapter with a real model request.

## Usage

To run this example, you'll need an Anthropic API key. Set it via environment variable:

```bash
# Option 1: Export in your shell
export ANTHROPIC_API_KEY="sk-ant-..."
npx tsx examples/anthropic-smoke/index.ts

# Option 2: Use .env file
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npx tsx examples/anthropic-smoke/index.ts --env-file .env
```

(Node 22+ supports `--env-file` natively via `node --env-file`, but tsx may require configuration.)

## What It Does

1. **Defines a lookup tool** that queries a small sample database
2. **Creates an agent** configured with:
   - Model: `claude-haiku-4-5-20251001`
   - Instructions: Act as a helpful assistant using the lookup tool
   - Max steps: 5
3. **Runs a request**: Asks the agent to look up two records and compare them
4. **Shows the result**: Prints the agent's response after it's made tool calls

## Example Output

```
🔥 Kern Anthropic Smoke Test
=============================

Agent: smoke-test-agent
Model: anthropic:claude-haiku-4-5-20251001
Tools: lookup

User: Please look up the status of records REC-001 and REC-003, and tell me which one is most recent.

Run Status: completed
Steps: 2

✅ Assistant: Based on the lookup results:
- REC-001 status: active, last updated on 2026-10-08
- REC-003 status: archived, last updated on 2026-09-15

REC-001 is the most recent record, last updated on 2026-10-08.
```

## How It Demonstrates the Adapter

- **Auto-registration**: Uses the default `AnthropicAdapter` (no explicit model list passed to Runner)
- **Lazy loading**: The Anthropic SDK client is only loaded on first use
- **Tool integration**: Demonstrates tool definition, schema generation, and result handling
- **Real API calls**: Makes actual requests to the Anthropic API
- **Event logging**: Full run history is available in the `runs/` directory as JSONL

## Notes

- Never run this in automated tests (no network I/O in test suite)
- For testing the adapter offline, use `FakeModel` with mocked responses
- The run log is written to `runs/<runId>.jsonl` for inspection
