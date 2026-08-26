import { get } from 'node:https';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { URL } from 'node:url';
import type { CommandResult } from './container-runtime';
import { defaultCommandRunner, hostToolCommandRunner } from './seams';
import { INSTALL_BUDGET_MS, INSTALL_RUN_OPTIONS } from './run-budget';
import { elevationLauncherArgv, isProcessElevated } from './elevate';
import { resolveDownloadUrl } from './toolchain-resolve';
import { artifactInstallPlan } from './toolchain-artifact';
import type { ArtifactContext } from './toolchain-artifact';
import type { ToolchainEffectPrimitives } from './toolchain-effects';

/**
 * The REAL machine primitives the install executor runs through — the one place
 * that actually spawns, elevates and downloads. Everything above it is tested
 * against fakes; this is the impure floor, so it is kept small and boring:
 * `run`/`verify` come from the tested effect assembly, and the three impure
 * verbs here (`runElevated`, `download`, `installArtifact`) each do exactly one
 * thing. Its correctness is a CI/owner concern — the Genie installer is not
 * buildable on the Windows dev box — which is why the DECISIONS it carries out
 * (what to run, which URL, which argv) live in tested pure modules and not here.
 */

/** A hung installer must not wedge the wizard forever; generous because an MSI
 *  or a Docker Desktop install legitimately takes minutes. Imported rather than
 *  redeclared — a private copy per module is how the unelevated install path
 *  ended up on the 120-second probe default while this one had fifteen minutes
 *  (see `run-budget.ts`). */
const INSTALL_TIMEOUT_MS = INSTALL_BUDGET_MS;
const FETCH_TIMEOUT_MS = 30_000;

/** Run a command with OS elevation. Already-privileged (root/CI) spawns direct;
 *  otherwise through the OS launcher (UAC / osascript / pkexec), which `-Wait`s
 *  so the exit code reflects the installer. The real success signal is still the
 *  post-install `verify` re-probe — an elevated launch can obscure the child's
 *  own code. */
async function runElevated(command: string, args: string[]): Promise<CommandResult> {
    const platform = process.platform;
    if (isProcessElevated(platform)) {
        return defaultCommandRunner.run(command, args, INSTALL_RUN_OPTIONS);
    }
    const launcher = elevationLauncherArgv(command, args, platform);
    return defaultCommandRunner.run(launcher[0], launcher.slice(1), INSTALL_RUN_OPTIONS);
}

/** GET a URL, following redirects, returning the parsed body. GitHub's API
 *  demands a User-Agent, so every request carries one. Rejects on a non-2xx or a
 *  parse failure; the resolver/caller turns that into a null/failed outcome. */
function httpGet(url: string, asJson: boolean, redirectsLeft = 5): Promise<{ body: string }> {
    return new Promise((resolve, reject) => {
        const req = get(
            url,
            { headers: { 'user-agent': 'Genie-Toolchain-Setup', accept: asJson ? 'application/json' : '*/*' } },
            (res) => {
                const status = res.statusCode ?? 0;
                const location = res.headers.location;
                if (status >= 300 && status < 400 && location) {
                    res.resume();
                    if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
                    return resolve(httpGet(new URL(location, url).toString(), asJson, redirectsLeft - 1));
                }
                if (status < 200 || status >= 300) {
                    res.resume();
                    return reject(new Error(`HTTP ${status} for ${url}`));
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ body }));
            },
        );
        req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`timed out fetching ${url}`)));
        req.on('error', reject);
    });
}

/** Fetch + JSON.parse — the resolver's injected seam. */
async function fetchJson(url: string): Promise<unknown> {
    const { body } = await httpGet(url, true);
    return JSON.parse(body);
}

/** Stream a URL to a temp file. Follows redirects itself (installers live behind
 *  CDNs). Returns the local path, or an error — never throws. Exported so the
 *  per-VERSION installer (`toolchain-manager.ts`) fetches through the same
 *  hardened path rather than growing a second HTTP client. */
export async function download(url: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
        const dir = await mkdtemp(join(tmpdir(), 'genie-toolchain-'));
        const name = basename(new URL(url).pathname) || 'download';
        const path = join(dir, name);
        await streamTo(url, path);
        return { ok: true, path };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

function streamTo(url: string, path: string, redirectsLeft = 5): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = get(url, { headers: { 'user-agent': 'Genie-Toolchain-Setup' } }, (res) => {
            const status = res.statusCode ?? 0;
            const location = res.headers.location;
            if (status >= 300 && status < 400 && location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
                return resolve(streamTo(new URL(location, url).toString(), path, redirectsLeft - 1));
            }
            if (status < 200 || status >= 300) {
                res.resume();
                return reject(new Error(`HTTP ${status} for ${url}`));
            }
            const file = createWriteStream(path);
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
            file.on('error', reject);
        });
        req.setTimeout(INSTALL_TIMEOUT_MS, () => req.destroy(new Error(`timed out downloading ${url}`)));
        req.on('error', reject);
    });
}

/**
 * Where Genie puts the tools it installs ITSELF (#205).
 *
 * A Genie-owned directory under its data dir: no elevation, nothing of the
 * user's is overwritten, and uninstalling a tool is deleting a folder. Electron
 * is resolved lazily so this module still loads in the headless build and in
 * tests, falling back to the home directory when there is no app.
 */
function genieToolsContext(): ArtifactContext {
    let base: string;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        base = (require('electron') as typeof import('electron')).app.getPath('userData');
    } catch {
        base = join(homedir(), '.genie');
    }
    const toolsDir = join(base, 'tools');
    return { toolsDir, binDir: join(toolsDir, 'bin'), os: process.platform };
}

/** Compare two PATH entries the way the OS does: trailing separators and, on
 *  Windows, case are not meaningful. */
function samePathEntry(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

/**
 * The directory Genie installs its own HOST TOOLS into. Language ENGINES live
 * elsewhere, under `toolchainRoot()/<tool>/<version>` — see
 * {@link managedPathDirs}, which is what a repair must actually reorder.
 *
 * Exported so callers ASK for it rather than recomputing it: a second derivation
 * is how a repair ends up reordering a directory the installer never writes to,
 * reporting success against an unchanged machine.
 */
export function genieToolsDir(): string {
    return genieToolsContext().toolsDir;
}

/**
 * PURE. PATH with every Genie-managed directory FIRST, in the given order.
 *
 * Precedence is the whole point. The previous operator APPENDED, which meant a
 * runtime Genie had just installed lost to whatever happened to be earlier — and
 * on the reporting machine that was Herd, which had been UNINSTALLED but left its
 * binaries and its PATH entry behind. `php` resolved to Herd's, and so did its
 * `php.ini`: on Windows PHP reads its config from the directory of the binary, so
 * "running with Herd's config" and "resolving to Herd's binary" are ONE fault
 * with one fix, not two.
 *
 * Every terminal, agent and dev server Genie spawns inherits this environment.
 *
 * An existing entry is MOVED rather than duplicated: a PATH that lists the same
 * directory twice is one someone will later "clean up" by deleting the wrong one.
 * Entries Genie does not manage keep their order — this reorders Genie's own
 * entries to the front and touches nothing else, because the rest of PATH belongs
 * to software Genie did not install.
 */
export function pathWithToolsFirst(current: string, dirs: string | string[], sep: string): string {
    const wanted = (Array.isArray(dirs) ? dirs : [dirs]).filter((d) => d.length > 0);
    const kept = current
        .split(sep)
        .filter((p) => p.length > 0 && !wanted.some((d) => samePathEntry(p, d)));
    // Dedupe the survivors too: the reporting machine's PATH carried 92 entries
    // of which only 57 were distinct. Keeping the FIRST occurrence of each cannot
    // change what any command resolves to.
    const seen: string[] = [];
    for (const entry of kept) {
        if (!seen.some((e) => samePathEntry(e, entry))) seen.push(entry);
    }
    return [...wanted, ...seen].join(sep);
}

/** What a toolchain diagnosis found. Empty arrays and `toolsFirst: true` mean
 *  nothing needs repairing. */
export interface ToolchainPathReport {
    /** True when a Genie-managed directory is the first entry on PATH. */
    toolsFirst: boolean;
    /** Tools resolving to something OUTSIDE Genie's managed directories — a
     *  foreign install winning over the one Genie manages. */
    shadowed: string[];
    /** PATH entries whose directory no longer exists — an uninstalled tool that
     *  left its entry behind. */
    stale: string[];
}

/**
 * PURE. Diagnose why Genie's tools are not the ones being used.
 *
 * Three findings, deliberately separate because they have different fixes:
 *   - `toolsFirst: false` — reordering PATH fixes it;
 *   - `shadowed` — a foreign install is winning, and the user should be told
 *     WHICH tool, because "php is wrong" is actionable and "PATH is wrong" is not;
 *   - `stale` — a directory that no longer exists, left by an uninstall. Harmless
 *     to resolution but it is the fingerprint of the failure, so it is worth
 *     naming rather than silently dropping.
 *
 * `resolved` is what each tool ACTUALLY resolves to right now — supplied by the
 * caller rather than probed here, so this stays pure and testable.
 */
export function diagnoseToolchainPath(input: {
    path: string;
    /** Every directory Genie manages: the host-tools dir plus one per installed
     *  engine version. A tool resolving into ANY of them is not shadowed. */
    toolsDirs: string[];
    sep: string;
    resolved: Record<string, string>;
    exists?: (dir: string) => boolean;
}): ToolchainPathReport {
    const entries = input.path.split(input.sep).filter((p) => p.length > 0);
    const managed = input.toolsDirs.filter((d) => d.length > 0);
    const toolsFirst =
        managed.length > 0 && entries.length > 0 && managed.some((d) => samePathEntry(entries[0]!, d));

    const under = (exe: string) =>
        managed.some((d) => exe.toLowerCase().startsWith(d.replace(/[\/]+$/, '').toLowerCase()));

    const shadowed = Object.entries(input.resolved)
        .filter(([, exe]) => !under(exe))
        .map(([tool]) => tool)
        .sort();

    const exists = input.exists;
    const stale = exists ? entries.filter((e) => !exists(e)) : [];

    return { toolsFirst, shadowed, stale };
}

/**
 * Put a Genie-installed tool's directory on PATH.
 *
 * TWO scopes, and both matter:
 *   - `process.env.PATH` right now, so every terminal, agent and dev server
 *     Genie spawns AFTER this finds the tool without restarting anything;
 *   - the persisted USER PATH on Windows, or the tool vanishes the next time
 *     Genie starts and re-inherits the system environment. (mac/Linux installs
 *     go through brew/apt, which own PATH themselves.)
 *
 * Never fails the install over PATH: the bytes ARE on disk, and reporting a
 * successful install as failed would send the user to reinstall something they
 * already have.
 */
export async function addToolsPathEntry(dir: string): Promise<CommandResult> {
    const current = process.env.PATH ?? '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const already = current
        .split(sep)
        .some(
            (p) =>
                p.replace(/[\\/]+$/, '').toLowerCase() === dir.replace(/[\\/]+$/, '').toLowerCase(),
        );
    // PREPEND, always — and re-prepend even when the entry is already present but
    // not first, which is exactly the Herd case: the dir was on PATH and losing.
    if (!already || !current.split(sep)[0] || !samePathEntry(current.split(sep)[0]!, dir)) {
        process.env.PATH = pathWithToolsFirst(current, dir, sep);
    }

    if (process.platform !== 'win32') return { code: 0, stdout: '', stderr: '' };
    // Read-modify-write the USER Path (never the machine one, which needs
    // elevation, and never `setx`, which truncates a long PATH at 1024 chars).
    const ps =
        `$p = [Environment]::GetEnvironmentVariable('Path','User'); ` +
        `if ($p -notlike '*${dir}*') { ` +
        `[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${dir}'), 'User') }`;
    const res = await defaultCommandRunner.run(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeoutMs: 60_000 },
    );
    return res.code === 0
        ? res
        : {
              code: 0,
              stdout: '',
              stderr: `Installed, but could not add ${dir} to your PATH permanently — new terminals in this Genie session will still find it.`,
          };
}

/** Assemble the real primitives. `runner`/`verify` come from the tested effect
 *  assembly ({@link createToolchainPerformDeps}); the three impure verbs are the
 *  ones above. */
export function createToolchainPrimitives(
    installEngine: ToolchainEffectPrimitives['installEngine'],
): ToolchainEffectPrimitives {
    return {
        installEngine,
        async addToPath(dir: string) {
            await addToolsPathEntry(dir);
        },
        // The SHIM-aware runner (genie#205): an `npm-global` step runs `npm`,
        // which on Windows is `npm.cmd` — unspawnable without a shell, which is
        // why installing the agent TUIs failed there. The elevated + artifact
        // paths below run real executables, so they keep the no-shell runner.
        runner: hostToolCommandRunner,
        runElevated,
        download,
        resolveDownloadUrl: (source, ctx) => resolveDownloadUrl(source, ctx, fetchJson),
        async installArtifact(command, localPath) {
            const plan = artifactInstallPlan(command, localPath, genieToolsContext());
            switch (plan.kind) {
                case 'unsupported':
                    return {
                        code: 1,
                        stdout: '',
                        stderr: `Genie can't install a ${plan.artifact} artifact automatically yet — install ${command.tool} manually and re-run setup.`,
                    };
                case 'run':
                    return command.requiresElevation
                        ? runElevated(plan.command, plan.args)
                        : defaultCommandRunner.run(plan.command, plan.args, INSTALL_RUN_OPTIONS);
                case 'phar': {
                    // composer is a phar — not executable by itself, so it is placed
                    // beside a launcher that feeds it to php.
                    try {
                        await mkdir(dirname(plan.to), { recursive: true });
                        await copyFile(plan.from, plan.to);
                        await writeFile(plan.shimPath, plan.shimBody, {
                            ...(plan.executable ? { mode: 0o755 } : {}),
                        });
                    } catch (e) {
                        return { code: 1, stdout: '', stderr: `Could not place ${command.tool}: ${String(e)}` };
                    }
                    return addToolsPathEntry(plan.pathAdd);
                }
            }
        },
    };
}
