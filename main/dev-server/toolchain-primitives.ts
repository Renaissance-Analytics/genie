import { get } from 'node:https';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { URL } from 'node:url';
import type { CommandResult } from './container-runtime';
import { defaultCommandRunner, hostToolCommandRunner } from './seams';
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
 *  or a Docker Desktop install legitimately takes minutes. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

/** Run a command with OS elevation. Already-privileged (root/CI) spawns direct;
 *  otherwise through the OS launcher (UAC / osascript / pkexec), which `-Wait`s
 *  so the exit code reflects the installer. The real success signal is still the
 *  post-install `verify` re-probe — an elevated launch can obscure the child's
 *  own code. */
async function runElevated(command: string, args: string[]): Promise<CommandResult> {
    const platform = process.platform;
    if (isProcessElevated(platform)) {
        return defaultCommandRunner.run(command, args, { timeoutMs: INSTALL_TIMEOUT_MS });
    }
    const launcher = elevationLauncherArgv(command, args, platform);
    return defaultCommandRunner.run(launcher[0], launcher.slice(1), { timeoutMs: INSTALL_TIMEOUT_MS });
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
async function addToolsPathEntry(dir: string): Promise<CommandResult> {
    const current = process.env.PATH ?? '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const already = current
        .split(sep)
        .some(
            (p) =>
                p.replace(/[\\/]+$/, '').toLowerCase() === dir.replace(/[\\/]+$/, '').toLowerCase(),
        );
    if (!already) process.env.PATH = current ? `${current}${sep}${dir}` : dir;

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
export function createToolchainPrimitives(): ToolchainEffectPrimitives {
    return {
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
                        : defaultCommandRunner.run(plan.command, plan.args, {
                              timeoutMs: INSTALL_TIMEOUT_MS,
                          });
                case 'extract': {
                    // php/node on Windows arrive as a zip of loose binaries: unpack
                    // into a Genie-owned dir (no elevation, nothing of the user's
                    // overwritten) and put that dir on PATH, or the files are there
                    // and nothing can find them.
                    const res = await defaultCommandRunner.run(plan.command, plan.args, {
                        timeoutMs: INSTALL_TIMEOUT_MS,
                    });
                    if (res.code !== 0) return res;
                    return addToolsPathEntry(plan.pathAdd);
                }
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
