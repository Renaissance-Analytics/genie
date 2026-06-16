import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { listWorkspaces } from '../db';

/**
 * Bundled tynn-cli toolkit (resetme / reload / puse / sandbox / …).
 *
 * The toolkit is vendored into `resources/tynn-cli/` (committed; refreshed by
 * `scripts/bundle-tynn-cli.mjs`) and shipped beside the app as extraResources.
 * This module resolves the shipped copy and builds the env overrides that make
 * the tools available + workspace-aware inside Genie terminals.
 *
 * Mirrors `host-service.ts resolveShippedRuntime()`: probe the packaged
 * `process.resourcesPath/tynn-cli` first, then the dev tree's
 * `resources/tynn-cli`. Returns null when neither exists (env injection then
 * no-ops; the terminal still works, the tools just aren't on PATH).
 */
export interface ShippedTynnCli {
    /** The tynn-cli root (holds bin/, lib/, install.sh, tynn.config.example). */
    home: string;
    /** The bin/ directory to prepend to PATH. */
    bin: string;
}

export function resolveShippedTynnCli(): ShippedTynnCli | null {
    const roots: string[] = [];
    try {
        if (process.resourcesPath) {
            roots.push(path.join(process.resourcesPath, 'tynn-cli'));
        }
    } catch {
        /* resourcesPath unavailable outside a packaged app */
    }
    try {
        roots.push(path.join(app.getAppPath(), 'resources', 'tynn-cli'));
        roots.push(path.join(process.cwd(), 'resources', 'tynn-cli'));
    } catch {
        /* app may not be ready in some unit contexts */
    }
    for (const home of roots) {
        try {
            const bin = path.join(home, 'bin');
            if (fs.existsSync(bin) && fs.statSync(bin).isDirectory()) {
                return { home, bin };
            }
        } catch {
            /* probe next root */
        }
    }
    return null;
}

/** Whether the toolkit shipped with this build, and where it lives. */
export function tynnCliInfo(): { shipped: boolean; home: string | null } {
    const cli = resolveShippedTynnCli();
    return { shipped: !!cli, home: cli?.home ?? null };
}

function copyRecursive(src: string, dst: string): void {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dst, entry));
        }
    } else {
        fs.copyFileSync(src, dst);
    }
}

/**
 * Install the toolkit system-wide (for ALL the user's bash sessions, not just
 * Genie terminals). The shipped copy lives under the app's read-only resources,
 * but install.sh writes into its own dir (.custom/, tynn.config) and edits
 * ~/.bashrc — so we first copy the toolkit to a writable, update-stable home
 * (`~/.genie/tynn-cli`) and run install.sh from there.
 *
 * Bash-only (Git Bash on Windows). Resolves with the script output; `ok:false`
 * when the toolkit isn't shipped or bash/install fails.
 */
export function installTynnCliSystemWide(): Promise<{
    ok: boolean;
    output: string;
}> {
    return new Promise((resolve) => {
        const cli = resolveShippedTynnCli();
        if (!cli) {
            resolve({ ok: false, output: 'tynn-cli is not bundled with this build.' });
            return;
        }
        let dest: string;
        try {
            dest = path.join(app.getPath('home'), '.genie', 'tynn-cli');
            fs.rmSync(dest, { recursive: true, force: true });
            copyRecursive(cli.home, dest);
        } catch (e) {
            resolve({
                ok: false,
                output: `Could not stage tynn-cli to a writable location: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            });
            return;
        }
        const installScript = path.join(dest, 'install.sh');
        // `bash` resolves to Git Bash when it's on PATH (the common case).
        const child = spawn('bash', [installScript], {
            cwd: dest,
            env: process.env,
        });
        let out = '';
        child.stdout?.on('data', (d) => (out += d.toString()));
        child.stderr?.on('data', (d) => (out += d.toString()));
        child.on('error', (e) =>
            resolve({
                ok: false,
                output: `Could not run bash (Git Bash required): ${e.message}`,
            }),
        );
        child.on('close', (code) =>
            resolve({ ok: code === 0, output: out.trim() || `exit ${code}` }),
        );
    });
}

/** Find the process.env key for PATH (Windows uses 'Path'); default 'PATH'. */
function pathEnvKey(): string {
    for (const k of Object.keys(process.env)) {
        if (k.toLowerCase() === 'path') return k;
    }
    return 'PATH';
}

/**
 * Walk up from `start` looking for the `.agi` envelope root — the folder that
 * carries both `project.json` and `.git` (the Aionima envelope marker). Returns
 * the envelope root or null when `start` isn't inside one.
 */
function findEnvelopeRoot(start: string): string | null {
    let dir = start;
    // Bound the walk so a stray cwd never climbs the whole filesystem.
    for (let i = 0; i < 40; i++) {
        try {
            if (
                fs.existsSync(path.join(dir, 'project.json')) &&
                fs.existsSync(path.join(dir, '.git'))
            ) {
                return dir;
            }
        } catch {
            /* unreadable — stop */
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** The workspace whose path contains `cwd` (longest prefix wins), or null. */
function workspaceForCwd(cwd: string): { path: string; name: string } | null {
    const norm = path.resolve(cwd).toLowerCase();
    let best: { path: string; name: string } | null = null;
    let bestLen = -1;
    for (const ws of listWorkspaces()) {
        const wp = path.resolve(ws.path).toLowerCase();
        if ((norm === wp || norm.startsWith(wp + path.sep)) && wp.length > bestLen) {
            best = { path: ws.path, name: ws.project_name };
            bestLen = wp.length;
        }
    }
    return best;
}

/** Pure inputs for {@link shapeTynnCliEnv} — gathered impurely by buildTynnCliEnv. */
export interface TynnCliEnvInputs {
    /** tynn-cli bin dir to prepend to PATH. */
    binDir: string;
    /** tynn-cli home (GENIE_CLI_HOME). */
    home: string;
    /** The terminal's working directory. */
    cwd: string;
    /** The matched workspace, or null. */
    workspace: { path: string; name?: string } | null;
    /** The `.agi` envelope root containing cwd, or null. */
    envelopeRoot: string | null;
    /** The current PATH value to preserve. */
    existingPath: string;
    /** The PATH env key to write ('PATH' / 'Path'). */
    pathKey: string;
    /** PATH separator (path.delimiter). */
    delimiter: string;
}

/**
 * Pure: shape the env overrides from already-resolved inputs. Prepends binDir
 * to PATH (under the host's PATH key casing) and derives the GENIE_* context.
 * Kept pure so the PATH/repo-derivation rules are unit-testable.
 */
export function shapeTynnCliEnv(i: TynnCliEnvInputs): Record<string, string> {
    const env: Record<string, string> = {};
    env[i.pathKey] = i.existingPath
        ? `${i.binDir}${i.delimiter}${i.existingPath}`
        : i.binDir;
    env.GENIE_CLI_HOME = i.home;

    const workspacePath = i.workspace?.path ?? i.cwd;
    env.GENIE_WORKSPACE = workspacePath;
    if (i.workspace?.name) env.GENIE_WORKSPACE_NAME = i.workspace.name;

    if (i.envelopeRoot) {
        env.GENIE_ENVELOPE_ROOT = i.envelopeRoot;
        // Inside an envelope, repos live at <envelope>/repos/<name>; derive the
        // active repo from the cwd's position under repos/.
        const reposDir = path.join(i.envelopeRoot, 'repos');
        const rel = path.relative(reposDir, path.resolve(i.cwd));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            env.GENIE_REPO = rel.split(path.sep)[0];
        }
    }
    if (!env.GENIE_REPO) env.GENIE_REPO = path.basename(workspacePath);

    return env;
}

/**
 * Build the env overrides for a Genie terminal: prepend the bundled tynn-cli
 * bin to PATH and inject GENIE_* workspace context the tools (and agents) can
 * read. Additive — returns `{}` when the toolkit isn't shipped or the feature
 * is disabled, so terminals work unchanged.
 *
 * @param cwd      The terminal's working directory.
 * @param enabled  The `cli_tools_in_terminals` setting (default on).
 */
export function buildTynnCliEnv(
    cwd: string,
    enabled: boolean,
): Record<string, string> {
    if (!enabled) return {};
    const cli = resolveShippedTynnCli();
    if (!cli) return {};
    const key = pathEnvKey();
    return shapeTynnCliEnv({
        binDir: cli.bin,
        home: cli.home,
        cwd,
        workspace: workspaceForCwd(cwd),
        envelopeRoot: findEnvelopeRoot(cwd),
        existingPath: process.env[key] ?? '',
        pathKey: key,
        delimiter: path.delimiter,
    });
}
