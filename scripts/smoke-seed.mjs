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
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

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

// Genie's data root is ~/.genie on every version (src/main/paths.ts genieHome); `userData()`
// above is kept only as documentation of what it is NOT.
const runtime = join(homedir(), '.genie', 'runtime');
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

/**
 * THE WORKSPACE PATH — a directory that exists wherever this runs.
 *
 * It was hardcoded to `/work`, the smoke container's mount, which exists in the container and
 * nowhere else. On a CI runner the Dashboard still rendered perfectly: the path is only text in
 * a group header, so fifteen checks passed and the agent row appeared.
 *
 * What broke was the one check that starts a provider. Genie handed the missing directory to
 * prism-acp, which failed inside its own spawn and reported `failed to spawn Codex (Error)` —
 * a true sentence about the wrong component. I measured the wrong spawn, wrote a commit
 * blaming a library that handles its own case correctly, and put the wrong reason in a CI
 * workflow. All of it from a path in a seed script.
 *
 * `/work` had ALREADY been found once in this file's sibling, for the screenshot destination
 * (`smoke-cdp.mjs`, `ENOENT: /work/smoke-agent.png`). The assumption was fixed where it had
 * surfaced and left everywhere it had not — which is the whole reason it cost a second,
 * dearer diagnosis. A fix applied to the one line that failed is not a fix applied to the
 * belief behind it.
 *
 * `process.cwd()` is the repository in both environments, and the assertion below is the
 * positive control: a seed that writes an unusable path must say so here, where it is one
 * line, rather than three layers down as somebody else's error message.
 */
const workspacePath = process.cwd();
if (!statSync(workspacePath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`seed refuses to write an unusable workspace path: ${workspacePath}`);
}

writeFileSync(
    join(runtime, 'workspaces.json'),
    JSON.stringify([{ id: 'tynn', path: workspacePath }], null, 2),
);

/*
 * MANY REPOS (beta.33 item 23). The owner: "why the fuck is any content at all behind the fucking chat panel?" — a
 * workspace header with one chip per repo overflowed its column, and the layout sweep never saw it because this seed's
 * workspace had ONE repo. A real envelope has many (the owner's has five; twelve is a hostile number, on purpose). The
 * workspace's own manifest, as an `.agi` envelope carries it: its name is the folder's, so every surface names the
 * workspace exactly as before. Never written over a project.json that is already there.
 */
const manifestPath = join(workspacePath, 'project.json');
if (existsSync(manifestPath)) throw new Error(`seed refuses to overwrite ${manifestPath}`);
const repoNames = ['genie', 'tynn-claude-tooling', 'tynn-mcp-testing', 'shared-schemas', 'api', 'web', 'docs', 'cli', 'infra', 'design', 'marketing'];
writeFileSync(manifestPath, JSON.stringify({
    name: basename(workspacePath),
    repos: [{ name: basename(workspacePath), slug: 'host', path: '.' }, ...repoNames.map((n) => ({ name: n, slug: n, path: `repos/${n}` }))],
}, null, 2));

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
                // A KEPT PLAN (identity.ts `plan`), so the Active Plan column has steps whose chat icon the smoke can click
                // (check 64c, the plan pill focusing the composer without scrolling anything).
                plan: [
                    { content: 'Read the migration brief', status: 'completed' },
                    { content: 'Migrate the accounts table', status: 'in_progress' },
                    { content: 'Run the suite', status: 'pending' },
                ],
            },
        ],
        null,
        2,
    ),
);

console.log(
    `seeded one workspace at ${workspacePath} (${repoNames.length + 1} repos in its project.json) and two agents (${id}, ${codexId}) into ${runtime}`,
);
