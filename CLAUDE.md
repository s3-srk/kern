# Kern

Minimal TypeScript agent framework. The spec is docs/ARCHITECTURE.md and
docs/ADRS.md. Read the relevant sections before changing code. If code and
spec disagree, stop and ask; do not silently diverge.

## Stack

Node 22, ESM, TypeScript strict, Zod v4, Vitest, tsx.
No agent/orchestration frameworks. Use raw provider SDKs.
ESLint (flat config) + typescript-eslint

## Rules

- Do exactly the step you are asked for. Do not start the next step.
- Keep the kernel small (target < 1,500 lines in src/). Prefer plain functions.
- Every behavior change gets a Vitest test. Tests involving a model use FakeModel. No network in tests.
- Events are appended and flushed BEFORE being yielded or acted on.
- Never modify persisted events. Run state = deriveState(events).
- Imports use .js extensions (NodeNext).
- Never read or print .env. Never commit secrets.

## Before you say a step is done

Run: npm run typecheck && npm run lint && npm test
All three must pass. Show me the output summary.

## Git

- Do not commit or push unless I ask.
- When I ask for a commit message, use Conventional Commits:
  type(scope): imperative summary under 72 chars, blank line, short body
  explaining why. Types: feat, fix, test, docs, chore, refactor, ci.

## Commands

npm run typecheck | npm run lint | npm test | npm run build
npx tsx examples/<name>/index.ts
