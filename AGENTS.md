# Agent notes for this repository

## Change Flows → run `npm run verify:flows`

Flows have their own acceptance suite (`test/flows-acceptance/*.accept.ts`, config `vitest.flows.config.mts`). It puts
every trigger (Run now, Schedule, A file is added) and every node kind the canvas palette offers through Genie's real
scheduler and runner, composed as `src/main/compose.ts` composes them, and checks each one's effect. It is not part of
`npm test`; run it whenever you change what Flows are made of:

- any file in `node scripts/flows-paths.mjs`'s output. That is the run-time import graph from every `src/` file named
  flow and from the flow editor window's route (`core/address.ts`, `core/route.ts`, `core/window-activation.ts`,
  `core/view-requests.ts`, `main/preload.ts`), plus the files that import a flow file (`compose.ts`, `feature-ipc.ts`,
  `main.ts`, `App.tsx`…). Not by name: genie#1302 broke the editor through `core/address.ts`;
- the `@particle-academy/fancy-flow` dependency;
- the suite itself, its config and that script.

CI's `flows acceptance` job runs it on exactly those changes (`flows-paths.mjs --touched`), and reports a pass without
running it otherwise. `test/flows-acceptance-ci.test.ts` holds the rules.

Adding a node kind to the palette means adding its case: `kindCase('<kind>', …)` in `test/flows-acceptance/`. The palette
guard (`palette-guard.accept.ts`) fails while a kind has none, and `kindCase` fails unless that kind actually ran.

Tests run in the test VMs, never on the owner's desktop (see the envelope's `RULES.md`).
