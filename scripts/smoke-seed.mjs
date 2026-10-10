/**
 * Seed a workspace and an agent before the app launches.
 *
 * ## Why this is state, not a hook
 *
 * It writes the same two JSON files a real user's machine would already have — nothing in
 * `src/` knows this script exists and the app behaves identically. That matters: the previous
 * build's harness set `GENIE_E2E`, which short-circuited the single-instance lock, and so
 * tested a product that behaved differently from the shipped one.
 *
 * ## Why it is worth doing at all
 *
 * An empty Dashboard proves the app boots. It cannot prove that **clicking an agent opens that
 * agent**, which is §0.4's exact shape — a finished Conversation UI that was built, shipped and
 * unreachable for three releases because one condition decided it should not render. Every test
 * of that feature passed. The only check that would have caught it is a click.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Electron's `userData` on Linux is `~/.config/<package name>`.
const runtime = join(homedir(), '.config', 'genie2', 'runtime');
mkdirSync(runtime, { recursive: true });

const now = new Date().toISOString();

// A well-formed id, in the shape `asAgentId` accepts — `agent_` plus 32 hex characters. A
// malformed one is REFUSED by the main process rather than repaired, which is correct and
// would make this seed silently invisible.
const id = `agent_${'a1b2c3d4'.repeat(4)}`;

writeFileSync(
    join(runtime, 'workspaces.json'),
    JSON.stringify([{ id: 'tynn', path: '/work' }], null, 2),
);

writeFileSync(
    join(runtime, 'agents.json'),
    JSON.stringify(
        [
            {
                id,
                workspaceId: 'tynn',
                provider: 'claude',
                name: 'atlas',
                instructions: null,
                threadId: null,
                createdAt: now,
                lastUsedAt: null,
                mode: 'manual',
                accessScope: 'none',
            },
        ],
        null,
        2,
    ),
);

console.log(`seeded one workspace and one agent (${id}) into ${runtime}`);
