import { HOST_TOOLS, parseVersionOutput, planUpdate, platformArgv, repairOutcome, toolStatus, type PackageManager, type Platform, type RepairOutcome, type ToolStatus } from '../core/toolchain.js';
import { LANGUAGE_LABEL, genieUpdates, installableVersions, updateChoices, type LanguageTool } from '../core/toolchain-update.js';
import { latestFromBrewOutdated, latestFromNodeIndex, latestFromNpmOutdated, latestFromWingetUpgrade, phpLatestFromReleases } from '../core/toolchain-indexes.js';

/**
 * THE MANAGED TOOLCHAIN (§6.6) — the main-side half, with the process runner INJECTED.
 *
 * `probeTools` asks every managed tool for its version and the index for the latest, and never
 * throws: a tool that is absent, unreadable or broken is `not-installed`; an index that is offline
 * leaves the tool `unknown` with its installed version intact. `shouldCheckUpdates` is the
 * six-hour cache window — a scan shells out to `winget upgrade` / `brew outdated` / `npm outdated -g`,
 * so a panel open or a finished install decides whether THAT moment scans; nothing ticks. A future
 * timestamp counts as stale so a bad clock cannot freeze the badge. `runUpdate` performs the planned
 * command as a binary + arguments (never through a shell) and judges the result by the version
 * measured AFTER — the core's honest-repair rule, applied.
 */

/**
 * Run a binary with argv (never a shell). `options.env` is added to the child's inherited environment for that call only
 * (rustup's homes, TC6b-2) — Genie's own environment is not changed.
 */
export type CommandRunner = (binary: string, args: readonly string[], options?: { readonly env?: Readonly<Record<string, string>> }) => Promise<{ stdout: string; exitCode: number }>;
export type LatestIndex = (tool: string) => Promise<{ version: string; source: string } | null>;

/** The version one tool reports here, or `null` (absent, broken, or silent). Windows `.cmd` shims go through `cmd.exe`. */
export async function probeInstalled(tool: (typeof HOST_TOOLS)[number], run: CommandRunner, platform: Platform = process.platform as Platform): Promise<string | null> {
    try {
        // `go version` is the one banner not behind `--version`; its probe lists both so the registry
        // test can see the flag, and the real call drops it.
        const args = tool.probe.args.length > 1 ? tool.probe.args.filter((a) => a !== '--version') : tool.probe.args;
        const [binary, argv] = platformArgv(tool.probe.binary, args, platform);
        const r = await run(binary, argv);
        return parseVersionOutput(tool.name, r.stdout);
    } catch {
        return null;
    }
}

export async function probeTools(run: CommandRunner, latest: LatestIndex, platform: Platform = process.platform as Platform): Promise<ToolStatus[]> {
    return Promise.all(
        HOST_TOOLS.map(async (tool) => {
            const installed = await probeInstalled(tool, run, platform);
            let idx: { version: string; source: string } | null = null;
            try {
                idx = await latest(tool.name);
            } catch {
                idx = null;
            }
            // A language Genie installs itself here (genie#1306): which versions it can move to — the patch first.
            const choices = installed !== null && genieUpdates(tool.name, platform) ? updateChoices(tool.name, installed) : undefined;
            return toolStatus({ tool: tool.name, installed, latest: idx?.version ?? null, source: idx?.source ?? null, ...(choices ? { choices } : {}) });
        }),
    );
}

/** What the "latest" lookup needs: the runner, a JSON fetch for the two web indexes, and the platform it runs on. */
export interface LatestIndexPorts {
    readonly run: CommandRunner;
    readonly fetchJson: (url: string) => Promise<unknown>;
    readonly platform: Platform;
}

/**
 * Where "latest" comes from, per tool. An unreachable or unreadable source yields null — the honest `unknown`.
 *
 * Every command goes through `platformArgv`, the same routing the probe and the update use: on Windows npm is
 * `npm.cmd`, which `execFile` cannot start, so a bare `npm outdated -g` rejected, the catch below turned it into null,
 * and claude-code and codex read `unknown` forever and never offered Update.
 */
export function latestIndex(ports: LatestIndexPorts): LatestIndex {
    const run = (binary: string, args: readonly string[]) => {
        const [b, a] = platformArgv(binary, args, ports.platform);
        return ports.run(b, a);
    };
    return async (tool) => {
        try {
            if (tool === 'node') return latestFromNodeIndex(await ports.fetchJson('https://nodejs.org/dist/index.json'));
            if (tool === 'php') return phpLatestFromReleases(await ports.fetchJson('https://www.php.net/releases/index.php?json'));
            const def = HOST_TOOLS.find((t) => t.name === tool);
            if (!def) return null;
            // npm-distributed tools (claude-code, codex): `npm outdated -g` names them by the registry's own package.
            if (def.ownUpdater?.manager === 'npm' && def.npmPackage) return latestFromNpmOutdated((await run('npm', ['outdated', '-g', '--json'])).stdout, def.npmPackage);
            if (ports.platform === 'win32' && def.packages.winget) return latestFromWingetUpgrade((await run('winget', ['upgrade', '--id', def.packages.winget])).stdout, def.packages.winget);
            if (ports.platform === 'darwin' && def.packages.brew) return latestFromBrewOutdated((await run('brew', ['outdated', '--json'])).stdout, def.packages.brew);
            return null;
        } catch {
            return null;
        }
    };
}

const WINDOW_MS = 6 * 3_600_000;

export function shouldCheckUpdates(lastCheckedAt: number | null, now: number, force = false): boolean {
    if (force || lastCheckedAt === null) return true;
    if (lastCheckedAt > now) return true;
    return now - lastCheckedAt >= WINDOW_MS;
}

/**
 * Split a planned command line into binary + args. The plans are Genie's own tables, so the split is plain whitespace;
 * on Windows an npm-distributed update goes through `cmd.exe` (npm is `npm.cmd`, which `execFile` cannot start).
 */
function argv(command: string, platform: Platform): [string, string[]] {
    const [binary, ...args] = command.split(/\s+/);
    return platformArgv(binary!, args, platform);
}

/**
 * genie#1306 — what updating a LANGUAGE needs: Genie's own installer for it (checksum-verified, into its own directory)
 * and the `current/<lang>` default link. `progress` is the row's step, shown while it runs.
 */
export interface LanguageUpdatePorts {
    install(tool: LanguageTool, version: string): Promise<{ readonly kind: 'installed' | 'already-installed' } | { readonly kind: 'refused' | 'not-installed'; readonly reason: string }>;
    setDefault(tool: LanguageTool, version: string): { readonly kind: 'set' | 'cleared' } | { readonly kind: 'refused'; readonly reason: string };
    progress?(step: string | null): void;
}

/**
 * THE UPDATE. A language Genie manages on this OS (php, node, python, go) — given `languages` — is Genie's own install of
 * the target version, then the default switched to it, then MEASURED: `<lang>` must answer the new version. It never
 * runs a package manager: the owner's languages were Genie-managed, and `winget upgrade` answered "no installed package"
 * (Genie 1, v0.7.0-beta.342 toolchain-adapters.ts engineToolFor: a language goes through the engine installer). With no
 * version asked for, the patch in the installed line is the target. Every other tool keeps its package-manager plan.
 */
export async function runUpdate(
    tool: string,
    where: { platform: Platform; packageManager: PackageManager | null },
    run: CommandRunner,
    wanted: string | null,
    languages?: LanguageUpdatePorts,
): Promise<RepairOutcome | { kind: 'refused'; reason: string }> {
    if (languages && genieUpdates(tool, where.platform)) return updateLanguage(tool, where.platform, run, wanted, languages);
    const plan = planUpdate({ tool, ...where });
    if ('refused' in plan) return { kind: 'refused', reason: plan.refused };
    const def = HOST_TOOLS.find((t) => t.name === tool)!;
    const before = await probeInstalled(def, run, where.platform);
    const [binary, args] = argv(plan.command, where.platform);
    let exitCode: number;
    try {
        exitCode = (await run(binary, args)).exitCode;
    } catch (error) {
        exitCode = -1;
        void error;
    }
    const after = await probeInstalled(def, run, where.platform);
    return repairOutcome({ tool, wanted, before, after, exitCode });
}

const sentence = (text: string): string => text.replace(/[. ]+$/, '');

async function updateLanguage(tool: LanguageTool, platform: Platform, run: CommandRunner, wanted: string | null, ports: LanguageUpdatePorts): Promise<RepairOutcome | { kind: 'refused'; reason: string }> {
    const label = LANGUAGE_LABEL[tool];
    const def = HOST_TOOLS.find((t) => t.name === tool)!;
    const offered = installableVersions(tool);
    if (wanted !== null && !offered.includes(wanted)) return { kind: 'refused', reason: `Genie has no installer for ${label} ${wanted}; this release installs ${offered.join(', ')}` };
    const before = await probeInstalled(def, run, platform);
    const choices = before === null ? null : updateChoices(tool, before);
    const target = wanted ?? choices?.patch ?? choices?.upgrade ?? null;
    if (target === null) return { kind: 'refused', reason: `${label} ${before} is the newest Genie installs; there is nothing to update to` };
    const say = (step: string | null) => ports.progress?.(step);
    try {
        say(`Downloading and verifying ${label} ${target}`);
        const installed = await ports.install(tool, target);
        if (installed.kind === 'refused' || installed.kind === 'not-installed') {
            return { kind: 'unchanged', installed: before, reason: `${label} ${target} could not be installed: ${sentence(installed.reason)}` };
        }
        say(`Switching ${tool} to ${target}`);
        const set = ports.setDefault(tool, target);
        if (set.kind === 'refused') return { kind: 'unchanged', installed: before, reason: `${label} ${target} is installed, but it could not be made the default: ${sentence(set.reason)}` };
        say(`Checking that ${tool} answers ${target}`);
        const after = await probeInstalled(def, run, platform);
        if (after === null) return { kind: 'unverified', reason: `${label} ${target} is installed and is the default, but ${tool} did not answer afterwards` };
        if (after !== target) {
            return { kind: 'unchanged', installed: after, reason: `${label} ${target} is installed and is Genie's default, but ${tool} still answers ${after}: another ${label} comes first on PATH` };
        }
        return { kind: 'repaired', from: before, to: after };
    } finally {
        say(null);
    }
}
