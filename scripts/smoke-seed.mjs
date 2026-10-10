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

/**
 * Electron's `userData`, per platform.
 *
 * This hardcoded the Linux path, and the Windows smoke found it on its first working run:
 * fifteen checks passed and the sixteenth said the seeded agent was not on the Dashboard. It
 * was not — it had been written to `~/.config` on a machine where the app reads `%APPDATA%`.
 *
 * Exactly the class of bug that job exists for, and exactly the shape of it: not a crash, not
 * an error, just a file written somewhere nothing reads. On Linux it would have stayed
 * invisible forever.
 *
 * This mirrors `app.getPath('userData')`. If the two ever diverge the seed misses silently
 * again — which is why the smoke asserts the agent APPEARS rather than that the file was
 * written.
 */
function userData() {
    if (process.platform === 'win32') {
        return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'genie2');
    }
    if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', 'genie2');
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'genie2');
}

const runtime = join(userData(), 'runtime');
mkdirSync(runtime, { recursive: true });

const now = new Date().toISOString();

// A well-formed id, in the shape `asAgentId` accepts — `agent_` plus 32 hex characters. A
// malformed one is REFUSED by the main process rather than repaired, which is correct and
// would make this seed silently invisible.
const id = `agent_${'a1b2c3d4'.repeat(4)}`;

/**
 * A second agent, on CODEX.
 *
 * It exists so the smoke can see a REAL parked approval. `ClaudeDriver.permissionRequests` is
 * false in prism-acp 0.6.1 — claude does not send them over ACP yet — and `CodexDriver`'s is
 * true. It is pointed at `scripts/stub-codex.mjs` through `GENIE2_CODEX_BINARY`, which is
 * ordinary provider configuration rather than a hook: the product behaves identically either
 * way, which is exactly what the previous build's `GENIE_E2E` did not.
 */
const codexId = `agent_${'b2c3d4e5'.repeat(4)}`;

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
            {
                id: codexId,
                workspaceId: 'tynn',
                provider: 'codex',
                name: 'wren',
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

console.log(`seeded one workspace and two agents (${id}, ${codexId}) into ${runtime}`);
