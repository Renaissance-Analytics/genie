# Agent notes for this repository

## Change Flows → run `npm run verify:flows`

Flows have their own acceptance suite (`test/flows-acceptance/*.accept.ts`, config `vitest.flows.config.mts`). It puts
every trigger (Run now, Schedule, A file is added) and every node kind the canvas palette offers through Genie's real
scheduler and runner, composed as `src/main/compose.ts` composes them, and checks each one's effect. It is not part of
`npm test`; run it whenever you change Flows:

- anything under `src/` whose name says flow (`src/**/flow*`, `FlowEditorWindow.tsx`, `v1-flows.ts`, `mcp-tools-flows.ts`),
  `src/core/cron.ts`, `src/core/file-trigger.ts`;
- the `@particle-academy/fancy-flow` dependency;
- the suite itself.

CI's `flows acceptance` job runs it on exactly those changes (and reports a pass without running it otherwise).

Adding a node kind to the palette means adding its case: `kindCase('<kind>', …)` in `test/flows-acceptance/`. The palette
guard (`palette-guard.accept.ts`) fails while a kind has none, and `kindCase` fails unless that kind actually ran.

Tests run in the test VMs, never on the owner's desktop (see the envelope's `RULES.md`).
