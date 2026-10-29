import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_LTS_DEFAULT } from '../core/node-versions.js';
import { HOST_TOOLS, PREREQUISITES, parseVersionOutput, planInstall, vcRuntimeFiles, type PackageManager, type Platform } from '../core/toolchain.js';
import {
    PRECEDENCE_TOOLS,
    caExportArgv,
    caIniContents,
    countCertificates,
    dirOf,
    findShadow,
    mergePersistedPath,
    missingVcRuntime,
    parseLocate,
    parsePhpTls,
    pathWithFirst,
    phpIniScanDir,
    phpTlsProblem,
    type FindingResult,
    type PhpTlsConfig,
    type RepairFinding,
    type RepairReport,
    type ToolCopy,
} from '../core/toolchain-repair.js';
import { SYSTEM_CA_BUNDLES } from '../core/php-trust.js';
import { probeInstalled, type CommandRunner } from './toolchain-prober.js';

/**
 * THE TOOLCHAIN'S ACTIONS (§6.6) — install a missing tool, check and repair — with every effect INJECTED: the runner
 * (`execFile`, never a shell), the environment Genie's own children inherit, and the filesystem. The tests drive the
 * same functions with fakes and count what ran.
 *
 * Consent is checked HERE as well as at the surface: a caller that forgot to ask cannot install anything. Results are
 * measured, never reported from a command's exit code (the core's honest-repair rule): an install is judged by the
 * re-probe after it, a repair by the tool re-resolved and the ini re-read through php-cgi itself.
 */

export interface ToolchainFs {
    exists(path: string): boolean;
    /** The file's text, or `null` when it cannot be read. */
    readText(path: string): string | null;
    writeText(path: string, content: string): void;
    mkdirp(dir: string): void;
    remove(path: string): void;
}

/** The environment Genie's own children inherit (`process.env` in the app). */
export interface EnvPort {
    get(name: string): string | undefined;
    set(name: string, value: string): void;
}

export interface ToolchainOpsPorts {
    readonly platform: Platform;
    /** Long-running: an install takes minutes. */
    readonly run: CommandRunner;
    readonly env: EnvPort;
    readonly fs: ToolchainFs;
    /** Genie's own toolchain data (the CA bundle, its ini, the remembered PATH order). */
    readonly dataDir: string;
    /** `%SystemRoot%` on Windows. */
    readonly systemRoot: string;
    readonly packageManager: () => Promise<PackageManager | null>;
    /** What is happening now (`null` = done) — the surface's progress line. */
    readonly progress?: (step: string | null) => void;
    readonly now?: () => number;
    /**
     * Genie's own Node — the newest version it manages (main/node-versions.ts), `null` when it manages none. Present =
     * Check and repair makes it the node and npm Genie runs, and the generic node shadow check stands aside (it would
     * otherwise move a newer Herd node back in front of Genie's).
     */
    readonly genieNode?: () => { readonly version: string; readonly dir: string } | null;
}

export type InstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string | null }
    | { readonly kind: 'installed'; readonly version: string | null; readonly note?: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

/** Where Genie keeps what the repair writes. */
export function toolchainPaths(dataDir: string) {
    const php = join(dataDir, 'php');
    const confDir = join(php, 'conf.d');
    return { bundle: join(php, 'cacert.pem'), confDir, ini: join(confDir, 'zz-genie-ca.ini'), state: join(dataDir, 'toolchain-env.json') };
}

const PM_CANDIDATES: Record<Platform, readonly { pm: PackageManager; bin: string }[]> = {
    win32: [{ pm: 'winget', bin: 'winget' }],
    darwin: [{ pm: 'brew', bin: 'brew' }],
    // apt first: on the improbable box with both, Debian's is the one a person expects, and the choice is deterministic.
    linux: [{ pm: 'apt', bin: 'apt-get' }, { pm: 'dnf', bin: 'dnf' }],
};

/** The platform's package manager that actually ANSWERS here, or `null`. Never throws. */
export async function detectPackageManager(platform: Platform, run: CommandRunner): Promise<PackageManager | null> {
    for (const { pm, bin } of PM_CANDIDATES[platform] ?? []) {
        try {
            const r = await run(bin, ['--version']);
            if (r.exitCode === 0 && r.stdout.trim().length > 0) return pm;
        } catch {
            // absent: the next candidate
        }
    }
    return null;
}

/**
 * Pick up PATH entries a winget install just persisted (Machine, then User), appended to Genie's own PATH — otherwise
 * the re-probe runs against the PATH Genie started with and calls a tool it just installed `not-installed`.
 */
export async function refreshPersistedPath(ports: Pick<ToolchainOpsPorts, 'platform' | 'run' | 'env'>): Promise<void> {
    if (ports.platform !== 'win32') return;
    try {
        const r = await ports.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine'); [Environment]::GetEnvironmentVariable('Path','User')"]);
        if (r.exitCode !== 0) return;
        const persisted = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
        ports.env.set('PATH', mergePersistedPath(ports.env.get('PATH') ?? '', persisted, ports.platform));
    } catch {
        // the re-probe still runs; it simply cannot see a PATH entry this process was never given
    }
}

function vcPresent(ports: Pick<ToolchainOpsPorts, 'platform' | 'fs' | 'systemRoot'>): boolean {
    return missingVcRuntime(ports.platform, vcRuntimeFiles(ports.systemRoot), (p) => ports.fs.exists(p)).length === 0;
}

const tail = (text: string): string => {
    const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    return line ? ` (“${line.slice(0, 200)}”)` : '';
};

/** T1: install ONE missing tool through this platform's package manager — only with the person's consent. */
export async function installTool(tool: string, consent: boolean, ports: ToolchainOpsPorts): Promise<InstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; ${tool} was not installed` };
    const def = HOST_TOOLS.find((t) => t.name === tool);
    const prereq = PREREQUISITES.find((p) => p.name === tool);
    if (!def && !prereq) return { kind: 'refused', reason: `${tool} is not a tool Genie manages` };
    const measure = async (): Promise<string | null> => (def ? probeInstalled(def, ports.run, ports.platform) : vcPresent(ports) ? 'present' : null);

    const before = await measure();
    if (before !== null) return { kind: 'already-installed', version: def ? before : null };
    const plan = planInstall({ tool, platform: ports.platform, packageManager: await ports.packageManager() });
    if ('refused' in plan) return { kind: 'refused', reason: plan.refused };

    try {
        ports.progress?.(`Installing ${tool}: ${plan.label}${plan.elevated ? ' — your system will ask for permission' : ''}`);
        let exitCode: number;
        let output = '';
        try {
            const r = await ports.run(plan.argv[0]!, plan.argv.slice(1));
            exitCode = r.exitCode;
            output = r.stdout;
        } catch (error) {
            exitCode = -1;
            output = error instanceof Error ? error.message : String(error);
        }
        ports.progress?.(`Checking that ${tool} answers`);
        await refreshPersistedPath(ports);
        const after = await measure();
        if (after === null) return { kind: 'not-installed', reason: `${plan.label} exited ${exitCode}${tail(output)}, and ${tool} still does not answer; nothing Genie can find was installed` };
        const version = def ? after : null;
        return exitCode === 0 ? { kind: 'installed', version } : { kind: 'installed', version, note: `the command exited ${exitCode}, but ${tool} now answers` };
    } finally {
        ports.progress?.(null);
    }
}

// --- check and repair ------------------------------------------------------------------------------------------------

async function locate(binary: string, ports: ToolchainOpsPorts): Promise<string[]> {
    try {
        const r = ports.platform === 'win32' ? await ports.run('where', [binary]) : await ports.run('which', ['-a', binary]);
        return parseLocate(r.stdout, ports.platform);
    } catch {
        return [];
    }
}

async function copiesOf(t: (typeof PRECEDENCE_TOOLS)[number], ports: ToolchainOpsPorts): Promise<ToolCopy[]> {
    const paths = await locate(t.binary, ports);
    if (paths.length < 2) return paths.map((path) => ({ path, version: null }));
    return Promise.all(
        paths.map(async (path) => {
            try {
                return { path, version: parseVersionOutput(t.tool, (await ports.run(path, t.args)).stdout) };
            } catch {
                return { path, version: null };
            }
        }),
    );
}

const samePath = (a: string, b: string, platform: Platform) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** php-cgi's own view of its config (what a site gets), else the CLI's; `null` when neither answers. */
async function readPhpTls(ports: ToolchainOpsPorts): Promise<PhpTlsConfig | null> {
    for (const bin of ['php-cgi', 'php']) {
        try {
            const r = await ports.run(bin, ['-i']);
            if (r.stdout.trim().length > 0) return parsePhpTls(r.stdout);
        } catch {
            // the next one
        }
    }
    return null;
}

async function repairPhpCa(ports: ToolchainOpsPorts): Promise<FindingResult> {
    const { bundle, confDir, ini } = toolchainPaths(ports.dataDir);
    ports.fs.mkdirp(confDir);
    const [bin, args] = caExportArgv(bundle);
    try {
        const r = await ports.run(bin, args);
        if (r.exitCode !== 0) return { kind: 'unchanged', reason: `exporting this machine's root certificates failed (exit ${r.exitCode})${tail(r.stdout)}; nothing was configured` };
    } catch (error) {
        return { kind: 'unchanged', reason: `exporting this machine's root certificates failed: ${error instanceof Error ? error.message : String(error)}; nothing was configured` };
    }
    // Verify what LANDED, not what the command said: a truncated or empty bundle that exists reads as "trust is solved".
    const count = countCertificates(ports.fs.readText(bundle) ?? '');
    if (count === 0) {
        ports.fs.remove(bundle);
        return { kind: 'unchanged', reason: 'the export produced no certificates, so PHP was not pointed at it (a bundle with nothing in it fixes nothing)' };
    }
    ports.fs.writeText(ini, caIniContents(bundle));
    ports.env.set('PHP_INI_SCAN_DIR', phpIniScanDir(ports.env.get('PHP_INI_SCAN_DIR'), confDir, ports.platform));
    const after = await readPhpTls(ports);
    const still = after === null ? 'PHP did not answer after the change' : phpTlsProblem(after, ports.platform, (p) => ports.fs.exists(p));
    if (still !== null) return { kind: 'unchanged', reason: `wrote ${ini}, but ${still}` };
    return { kind: 'repaired', detail: `${count} root certificates from this machine are in ${bundle}; the PHP Genie runs — sites' php-cgi included — reads it through ${ini}. Your php.ini is unchanged.` };
}

/**
 * THE CA BUNDLE GENIE'S MANAGED PHP NAMES, as it is now (genie#1334) — a path that exists with certificates in it, or
 * `null`. Windows: the machine's roots that Check and repair or {@link ensurePhpCaBundle} exported (one file for every
 * version, so an update or a version switch names the same one). Elsewhere: the platform's own bundle file. Runs nothing.
 */
export function phpCaBundleNow(ports: Pick<ToolchainOpsPorts, 'platform' | 'fs' | 'dataDir'>): string | null {
    const has = (path: string) => countCertificates(ports.fs.readText(path) ?? '') > 0;
    if (ports.platform === 'win32') {
        const { bundle } = toolchainPaths(ports.dataDir);
        return has(bundle) ? bundle : null;
    }
    return SYSTEM_CA_BUNDLES.find(has) ?? null;
}

/**
 * {@link phpCaBundleNow}, MAKING the Windows one when there is none: Genie 1's read-only export of the machine's root
 * store (Windows Update's list, then the local store — `caExportArgv`), counted after it lands; a file with no
 * certificate in it is deleted, never named (Genie 1 `writeCaBundle`). Never throws. Runs only when the bundle is missing,
 * so a restart costs a file read.
 */
export async function ensurePhpCaBundle(ports: Pick<ToolchainOpsPorts, 'platform' | 'run' | 'fs' | 'dataDir'>): Promise<string | null> {
    const now = phpCaBundleNow(ports);
    if (now !== null || ports.platform !== 'win32') return now;
    const { bundle } = toolchainPaths(ports.dataDir);
    try {
        ports.fs.mkdirp(dirOf(bundle));
        const [bin, args] = caExportArgv(bundle);
        const r = await ports.run(bin, args);
        if (r.exitCode === 0 && countCertificates(ports.fs.readText(bundle) ?? '') > 0) return bundle;
    } catch {
        // below: nothing usable is left behind
    }
    try { ports.fs.remove(bundle); } catch { /* nothing to remove */ }
    return null;
}

/** `toolchain-env.json`: the PATH order to replay, and Genie's npm prefix (see {@link preferGenieNode}). */
interface ToolchainEnvState {
    pathFirst: string[];
    npmPrefix?: string;
}

function readState(ports: Pick<ToolchainOpsPorts, 'fs' | 'dataDir'>): ToolchainEnvState {
    try {
        const parsed = JSON.parse(ports.fs.readText(toolchainPaths(ports.dataDir).state) ?? '{}') as { pathFirst?: unknown; npmPrefix?: unknown };
        return {
            pathFirst: Array.isArray(parsed.pathFirst) ? parsed.pathFirst.filter((d): d is string => typeof d === 'string') : [],
            ...(typeof parsed.npmPrefix === 'string' ? { npmPrefix: parsed.npmPrefix } : {}),
        };
    } catch {
        return { pathFirst: [] };
    }
}

function remember(ports: Pick<ToolchainOpsPorts, 'platform' | 'fs' | 'dataDir'>, dirs: readonly string[], npmPrefix?: string): void {
    if (dirs.length === 0 && npmPrefix === undefined) return;
    const prior = readState(ports);
    // Replayed in order at the next launch: a directory repaired again moves to the end, so it ends up in front.
    const pathFirst = [...prior.pathFirst.filter((d) => !dirs.some((n) => samePath(n, d, ports.platform))), ...dirs];
    const prefix = npmPrefix ?? prior.npmPrefix;
    ports.fs.mkdirp(ports.dataDir);
    ports.fs.writeText(toolchainPaths(ports.dataDir).state, `${JSON.stringify({ pathFirst, ...(prefix !== undefined ? { npmPrefix: prefix } : {}) }, null, 2)}\n`);
}

/** T2: one "Check and repair". Only problems are findings; each carries its own measured result. */
export async function checkAndRepair(ports: ToolchainOpsPorts): Promise<RepairReport> {
    const findings: RepairFinding[] = [];
    try {
        ports.progress?.('Checking which copy of each tool runs');
        const moved: string[] = [];
        const genieOwnsNode = ports.platform === 'win32' && ports.genieNode !== undefined;
        for (const t of PRECEDENCE_TOOLS) {
            if (t.tool === 'node' && genieOwnsNode) continue;
            const shadow = findShadow(await copiesOf(t, ports));
            if (!shadow) continue;
            const dir = dirOf(shadow.newer.path);
            ports.env.set('PATH', pathWithFirst(ports.env.get('PATH') ?? '', dir, ports.platform));
            const nowFirst = (await locate(t.binary, ports))[0] ?? null;
            let result: FindingResult;
            if (nowFirst !== null && samePath(nowFirst, shadow.newer.path, ports.platform)) {
                moved.push(dir);
                result = { kind: 'repaired', detail: `Genie now runs ${t.tool} ${shadow.newer.version} from ${shadow.newer.path}, ahead of ${shadow.first.version} at ${shadow.first.path}. Your own PATH is unchanged; terminals and sites pick this up when Genie next starts.` };
            } else {
                result = { kind: 'unchanged', reason: `moved ${dir} to the front, but ${t.binary} still resolves to ${nowFirst ?? 'nothing'}` };
            }
            findings.push({ kind: 'path-shadow', tool: t.tool, first: shadow.first, newer: shadow.newer, result });
        }
        remember(ports, moved);

        if (genieOwnsNode) {
            ports.progress?.('Checking that Genie runs its own Node');
            const finding = await checkGenieNode(ports);
            if (finding) findings.push(finding);
        }

        ports.progress?.("Checking PHP's CA bundle");
        const tls = await readPhpTls(ports);
        const problem = tls === null ? null : phpTlsProblem(tls, ports.platform, (p) => ports.fs.exists(p));
        if (problem !== null) {
            ports.progress?.("Exporting this machine's root certificates for PHP");
            findings.push({ kind: 'php-ca', problem, result: await repairPhpCa(ports) });
        }

        const missing = missingVcRuntime(ports.platform, vcRuntimeFiles(ports.systemRoot), (p) => ports.fs.exists(p));
        if (missing.length > 0) {
            findings.push({
                kind: 'vc-runtime',
                missing,
                result: { kind: 'needs-install', tool: 'vcredist', reason: `PHP cannot start without ${missing.join(', ')}. Install the Microsoft Visual C++ runtime — Genie runs it through winget when you say so.` },
            });
        }
    } finally {
        ports.progress?.(null);
    }
    return { findings, checkedAt: (ports.now ?? Date.now)() };
}

/** Every copy `where` lists, wrappers included (npm is a .cmd), in PATH order. */
async function whereAll(name: string, ports: ToolchainOpsPorts): Promise<string[]> {
    try {
        const r = await ports.run('where', [name]);
        return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !/^INFO:/.test(l));
    } catch {
        return [];
    }
}

const firstOf = (paths: readonly string[], ext: RegExp): string | null => paths.find((p) => ext.test(p)) ?? null;
const sameDir = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const inDir = (file: string | null, dir: string) => file !== null && sameDir(dirOf(file), dir);

/**
 * GENIE'S OWN NODE FIRST (the owner, 2026-10-23: "we better not be using herds node. genie has its own install path").
 * Finds a node or npm that is not Genie's winning on PATH, proves Genie's own npm runs (a node whose npm crashes is what
 * this machine had), moves Genie's directory to the front of what Genie runs, and MEASURES both again with `where`.
 */
async function checkGenieNode(ports: ToolchainOpsPorts): Promise<RepairFinding | null> {
    const genie = ports.genieNode?.() ?? null;
    const firstNode = firstOf(await whereAll('node', ports), /\.exe$/i);
    const firstNpm = firstOf(await whereAll('npm', ports), /\.(cmd|exe)$/i);
    if (genie === null) {
        return {
            kind: 'genie-node',
            problem: `the node Genie runs is ${firstNode ?? 'none (no node on PATH)'}, not Genie's own`,
            result: { kind: 'unchanged', reason: `Install Node ${NODE_LTS_DEFAULT} in Toolchain → Node versions, then run Check and repair again` },
        };
    }
    let npmSaid = '';
    let npmRuns = false;
    try {
        const r = await ports.run(`${genie.dir}\\node.exe`, [`${genie.dir}\\node_modules\\npm\\bin\\npm-cli.js`, '-v']);
        npmRuns = r.exitCode === 0;
        npmSaid = r.stdout;
    } catch (error) {
        npmSaid = error instanceof Error ? error.message : String(error);
    }
    const genieNpm = npmRuns ? lastLine(npmSaid) : null;
    // `npm -v` as a command line runs it: npm.cmd hands over to the npm in its configured global prefix when there is one
    // (measured on the Windows test VM: Genie's npm.cmd first, an inherited npm_config_prefix, and 10.9.9 answered), so
    // where npm.cmd sits is not the whole answer.
    const answer = await npmAnswer(ports);
    const healthy = (node: string | null, npm: string | null, said: string | null) => inDir(node, genie.dir) && inDir(npm, genie.dir) && genieNpm !== null && said === genieNpm;
    if (healthy(firstNode, firstNpm, answer)) return null;
    const problem = `${[
        inDir(firstNode, genie.dir) ? null : `node runs ${firstNode ?? 'from nowhere (none on PATH)'}`,
        inDir(firstNpm, genie.dir) ? null : `npm runs ${firstNpm ?? 'from nowhere (none on PATH)'}`,
        genieNpm !== null && answer !== genieNpm ? `npm -v answers ${answer ?? 'nothing'}` : null,
    ].filter(Boolean).join(' and ') || 'Genie’s npm does not run'}, not Genie's Node ${genie.version}${genieNpm ? ` with npm ${genieNpm}` : ''}`;
    if (!npmRuns) {
        return { kind: 'genie-node', problem, result: { kind: 'unchanged', reason: `Genie's Node ${genie.version} is there, but its npm does not run${tail(npmSaid)}, so it was not put first; Remove and reinstall it in Toolchain → Node versions` } };
    }
    preferGenieNode(ports, genie.dir);
    const nodeNow = firstOf(await whereAll('node', ports), /\.exe$/i);
    const npmNow = firstOf(await whereAll('npm', ports), /\.(cmd|exe)$/i);
    const answerNow = await npmAnswer(ports);
    if (healthy(nodeNow, npmNow, answerNow)) {
        return { kind: 'genie-node', problem, result: { kind: 'repaired', detail: `Genie now runs Node ${genie.version} and its own npm ${genieNpm} from ${genie.dir}, with its own global prefix. Your own PATH and npm settings are unchanged; terminals and agents pick this up when Genie next starts them.` } };
    }
    return { kind: 'genie-node', problem, result: { kind: 'unchanged', reason: `moved ${genie.dir} to the front and set Genie's npm prefix, but node resolves to ${nodeNow ?? 'nothing'}, npm to ${npmNow ?? 'nothing'}, and npm -v answers ${answerNow ?? 'nothing'}` } };
}

const lastLine = (text: string): string | null => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? null;

/** What `npm -v` answers as a command line, through cmd.exe with Genie's PATH — the npm an agent actually gets. */
async function npmAnswer(ports: ToolchainOpsPorts): Promise<string | null> {
    try {
        const r = await ports.run('cmd.exe', ['/d', '/s', '/c', 'npm -v']);
        return r.exitCode === 0 ? lastLine(r.stdout) : null;
    } catch {
        return null;
    }
}

/** Genie's global npm prefix for a Node directory: `npm-global` beside the versions (core/node-versions.ts nodeNpmGlobalDir). */
function npmGlobalFor(dir: string, platform: Platform): string {
    return `${dirOf(dir.replace(/[\\/]+$/, ''))}${platform === 'win32' ? '\\' : '/'}npm-global`;
}

/**
 * Put Genie's Node directory at the front of what Genie runs NOW — its `npm-global` (where `npm i -g` puts commands)
 * right behind it — and give Genie's processes that prefix (`NPM_CONFIG_PREFIX`), so Node's npm.cmd does not hand over to
 * the npm in a prefix set elsewhere: an inherited `npm_config_prefix` (`npx` exports one to everything it runs), or a
 * `.npmrc` `prefix=` such as `%APPDATA%\npm`. Remembered for the next launch. The person's own PATH and .npmrc are not
 * written.
 */
export function preferGenieNode(ports: Pick<ToolchainOpsPorts, 'platform' | 'env' | 'fs' | 'dataDir'>, dir: string): void {
    const npmGlobal = npmGlobalFor(dir, ports.platform);
    ports.env.set('PATH', pathWithFirst(pathWithFirst(ports.env.get('PATH') ?? '', npmGlobal, ports.platform), dir, ports.platform));
    ports.env.set('NPM_CONFIG_PREFIX', npmGlobal);
    remember(ports, [npmGlobal, dir], npmGlobal);
}

/**
 * At launch, BEFORE anything is spawned: re-apply the PATH order a repair chose and point PHP at Genie's CA ini — so the
 * pty host, terminals, sites and agent sessions all start with them. Reads two files; runs nothing. A remembered
 * directory that no longer exists is skipped (the tool was uninstalled; its order is nothing to restore).
 */
export function restoreToolchainEnv(ports: Pick<ToolchainOpsPorts, 'platform' | 'env' | 'fs' | 'dataDir'>): { pathFirst: string[]; phpIni: boolean } {
    const { ini, bundle, confDir } = toolchainPaths(ports.dataDir);
    const applied: string[] = [];
    const saved = readState(ports);
    for (const dir of saved.pathFirst) {
        if (!ports.fs.exists(dir)) continue;
        ports.env.set('PATH', pathWithFirst(ports.env.get('PATH') ?? '', dir, ports.platform));
        applied.push(dir);
    }
    // Genie's npm prefix comes back with Genie's Node: only while a Node directory beside it was restored.
    const prefix = saved.npmPrefix;
    if (prefix !== undefined && applied.some((d) => sameDir(dirOf(d), dirOf(prefix)) && !sameDir(d, prefix))) ports.env.set('NPM_CONFIG_PREFIX', prefix);
    const phpIni = ports.fs.exists(ini) && ports.fs.exists(bundle);
    if (phpIni) ports.env.set('PHP_INI_SCAN_DIR', phpIniScanDir(ports.env.get('PHP_INI_SCAN_DIR'), confDir, ports.platform));
    return { pathFirst: applied, phpIni };
}

/** What a site's php-cgi worker is given on top of the pty host's environment: Genie's ini directory, when there is one. */
export function phpWorkerEnv(env: EnvPort): Record<string, string> {
    const dir = env.get('PHP_INI_SCAN_DIR');
    return dir ? { PHP_INI_SCAN_DIR: dir } : {};
}

/** The real filesystem. */
export function nodeToolchainFs(): ToolchainFs {
    return {
        exists: (p) => {
            try {
                return existsSync(p);
            } catch {
                return false;
            }
        },
        readText: (p) => {
            try {
                return readFileSync(p, 'utf8');
            } catch {
                return null;
            }
        },
        writeText: (p, c) => writeFileSync(p, c, 'utf8'),
        mkdirp: (d) => {
            mkdirSync(d, { recursive: true });
        },
        remove: (p) => rmSync(p, { force: true }),
    };
}

/** `process.env` as a port. On Windows its keys are case-insensitive, so `PATH` is `Path`. */
export const processEnv: EnvPort = {
    get: (name) => process.env[name],
    set: (name, value) => {
        process.env[name] = value;
    },
};
