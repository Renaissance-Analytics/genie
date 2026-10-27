/**
 * THE MANAGED TOOLCHAIN (§6.6) — the pure half.
 *
 * What is installed on this workstation, whether something newer exists, how an update would be
 * performed here, and HONEST REPAIR: Genie never claims a fix it did not make. The owner's hybrid
 * decision (2026-08-12) carries over from v1: host tools on PATH are update-to-latest with a
 * badge; multi-version lives with service engines, not on PATH.
 *
 * Nothing here runs a process. `main/` probes `<binary> --version` and asks a version index; this
 * file turns those answers into a status, a plan, and an outcome.
 */

import { phpAdvisoryText } from './php-advisories.js';

export type Platform = 'win32' | 'darwin' | 'linux';
export type PackageManager = 'winget' | 'brew' | 'apt' | 'dnf';

export interface HostTool {
    readonly name: string;
    readonly probe: { readonly binary: string; readonly args: readonly string[] };
    /** The id each package manager knows the tool by; absent = that manager cannot update it. */
    readonly packages: Partial<Record<PackageManager, string>>;
    /** A tool with its own updater (rustup) or distribution (npm -g) ignores the OS package manager. */
    readonly ownUpdater?: { readonly manager: 'rustup' | 'npm'; readonly command: string };
    /** The npm package an `npm`-distributed tool installs as (`npm install -g <it>`); absent = npm cannot install it. */
    readonly npmPackage?: string;
}

export const HOST_TOOLS: readonly HostTool[] = [
    { name: 'php', probe: { binary: 'php', args: ['--version'] }, packages: { winget: 'PHP.PHP.8.4', brew: 'php', apt: 'php', dnf: 'php' } },
    { name: 'composer', probe: { binary: 'composer', args: ['--version'] }, packages: { winget: 'Composer.Composer', brew: 'composer', apt: 'composer', dnf: 'composer' } },
    { name: 'node', probe: { binary: 'node', args: ['--version'] }, packages: { winget: 'OpenJS.NodeJS.LTS', brew: 'node', apt: 'nodejs', dnf: 'nodejs' } },
    { name: 'npm', probe: { binary: 'npm', args: ['--version'] }, packages: {}, ownUpdater: { manager: 'npm', command: 'npm install -g npm@latest' } },
    { name: 'python', probe: { binary: 'python', args: ['--version'] }, packages: { winget: 'Python.Python.3.13', brew: 'python', apt: 'python3', dnf: 'python3' } },
    { name: 'go', probe: { binary: 'go', args: ['version', '--version'] }, packages: { winget: 'GoLang.Go', brew: 'go', apt: 'golang-go', dnf: 'golang' } },
    { name: 'rustc', probe: { binary: 'rustc', args: ['--version'] }, packages: {}, ownUpdater: { manager: 'rustup', command: 'rustup update stable' } },
    { name: 'cargo', probe: { binary: 'cargo', args: ['--version'] }, packages: {}, ownUpdater: { manager: 'rustup', command: 'rustup update stable' } },
    { name: 'git', probe: { binary: 'git', args: ['--version'] }, packages: { winget: 'Git.Git', brew: 'git', apt: 'git', dnf: 'git' } },
    { name: 'claude-code', probe: { binary: 'claude', args: ['--version'] }, packages: {}, ownUpdater: { manager: 'npm', command: 'npm install -g @anthropic-ai/claude-code@latest' }, npmPackage: '@anthropic-ai/claude-code' },
    { name: 'codex', probe: { binary: 'codex', args: ['--version'] }, packages: {}, ownUpdater: { manager: 'npm', command: 'npm install -g @openai/codex@latest' }, npmPackage: '@openai/codex' },
    // Docker Desktop: what every hosted service engine runs on. No apt/dnf row on purpose: a distro's `docker.io` is not
    // Docker Desktop, and installing it does not put the person in the `docker` group — a row that "installs" Docker and
    // leaves it unusable is worse than none.
    { name: 'docker', probe: { binary: 'docker', args: ['--version'] }, packages: { winget: 'Docker.DockerDesktop', brew: 'docker-desktop' } },
];

/**
 * PREREQUISITES — not tools anyone picks a version of, but what a tool needs to start at all. Windows only so far: every
 * windows.php.net build links the Visual C++ runtime, which a fresh Windows does not have, so PHP installs and then
 * cannot start (Genie 1's genie#209). Installable through the same consented path as a tool; never probed by version.
 */
export interface Prerequisite {
    readonly name: string;
    readonly label: string;
    readonly platform: Platform;
    readonly packages: Partial<Record<PackageManager, string>>;
}

export const PREREQUISITES: readonly Prerequisite[] = [
    { name: 'vcredist', label: 'Microsoft Visual C++ runtime', platform: 'win32', packages: { winget: 'Microsoft.VCRedist.2015+.x64' } },
];

/**
 * The Visual C++ runtime files a windows.php.net build loads, under `%SystemRoot%\System32` — all three, because they
 * fail differently: without `vcruntime140.dll` nothing starts; without the other two PHP starts and `intl` fails to load,
 * far from its cause (read out of the import tables by Genie 1). System32 specifically, never PATH: another app's
 * private copy is not a runtime Genie can promise.
 */
export const VC_RUNTIME_DLLS: readonly string[] = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];

export function vcRuntimeFiles(systemRoot: string): string[] {
    const root = systemRoot.replace(/[\\/]+$/, '');
    return VC_RUNTIME_DLLS.map((dll) => `${root}\\System32\\${dll}`);
}

/**
 * On Windows these are `.cmd`/`.bat` shims (npm.cmd, composer.bat, claude.cmd from npm), and `execFile` without a shell
 * cannot start a batch file: the probe answered ENOENT and every one of them read `not-installed` however installed it
 * was, and `npm install -g …` never ran. They go through `cmd.exe /d /s /c` — with arguments that are Genie's own
 * constants (`--version`, a package id from the tables above), never a person's or an agent's text.
 */
const WINDOWS_SHIMS: ReadonlySet<string> = new Set(['npm', 'npx', 'composer', 'claude', 'codex']);

export function platformArgv(binary: string, args: readonly string[], platform: Platform): [string, string[]] {
    if (platform === 'win32' && WINDOWS_SHIMS.has(binary)) return ['cmd.exe', ['/d', '/s', '/c', binary, ...args]];
    return [binary, [...args]];
}

const VERSION = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/;

/**
 * The version a tool printed, or `null`. Each tool's banner differs (`PHP 8.4.11 (cli)…`,
 * `v22.23.2`, `go version go1.25.1 …`); the first dotted number is the version in all of them.
 * `null` is never turned into `0.0.0` — a tool that did not answer is not installed at 0.
 */
export function parseVersionOutput(tool: string, output: string): string | null {
    const firstLine = output.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    if (/not recognized|not found|No such file/i.test(firstLine)) return null;
    const source = tool === 'go' ? firstLine.replace(/\bgo(\d)/, '$1') : firstLine;
    const m = VERSION.exec(source);
    if (!m) return null;
    // Strip a vendor suffix like `.windows.1` by keeping at most three numeric segments.
    const [core, pre] = m[1]!.split('-', 2);
    const segs = core!.split('.').slice(0, 3).join('.');
    return pre ? `${segs}-${pre}` : segs;
}

/** Segment-wise numeric compare; a missing segment is 0; a pre-release sorts below its release. */
export function compareVersions(a: string, b: string): number {
    const [ca, pa] = a.split('-', 2);
    const [cb, pb] = b.split('-', 2);
    const sa = ca!.split('.').map(Number);
    const sb = cb!.split('.').map(Number);
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
        const d = (sa[i] ?? 0) - (sb[i] ?? 0);
        if (d !== 0) return d;
    }
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    return (pa ?? '').localeCompare(pb ?? '');
}

export interface ToolProbe {
    readonly tool: string;
    readonly installed: string | null;
    readonly latest: string | null;
    /** Who said `latest`. `null` when nobody could. */
    readonly source: string | null;
    /**
     * A language Genie installs itself (genie#1306): the versions it can update to — the patch in the installed line, and
     * another line (core/toolchain-update.ts updateChoices). Absent for every other tool.
     */
    readonly choices?: { readonly patch: string | null; readonly upgrade: string | null };
}

export type Tone = 'security-update' | 'update-available' | 'up-to-date' | 'unknown' | 'not-installed';

export interface ToolStatus {
    readonly tool: string;
    readonly installed: string | null;
    readonly latest: string | null;
    readonly tone: Tone;
    readonly source: string | null;
    /** Why the installed version is unsafe (`security-update` only): the CVEs and the version to move to. */
    readonly advisory?: string;
    /**
     * genie#1306 — a language Genie installs itself: the PATCH in the installed line (8.4.24 → 8.4.27; a security
     * notice's fix), the row's primary action. Absent when there is none.
     */
    readonly patch?: string;
    /** …and a NEWER LINE (8.5.12), a separate, secondary choice. Absent when there is none. */
    readonly upgrade?: string;
}

/** What is known to be unsafe, per tool. Only PHP has a floor today (core/php-advisories.ts); the shape takes more. */
function advisoryFor(tool: string, installed: string): string | null {
    return tool === 'php' ? phpAdvisoryText(installed) : null;
}

/**
 * The badge. `unknown` when no source could name a latest — never `up-to-date` by default. A version under its
 * security floor is `security-update` BEFORE any comparison with "latest": the owner's PHP read "update available" for
 * three days of PHP2Shell, which is the wording of a nicety, not of a hole (the owner, 2026-10-22).
 */
export function toolStatus(p: ToolProbe): ToolStatus {
    const choices = p.installed === null ? {} : { ...(p.choices?.patch ? { patch: p.choices.patch } : {}), ...(p.choices?.upgrade ? { upgrade: p.choices.upgrade } : {}) };
    const advisory = p.installed === null ? null : advisoryFor(p.tool, p.installed);
    if (advisory !== null) return { tool: p.tool, installed: p.installed, latest: p.latest, tone: 'security-update', source: p.source, advisory, ...choices };
    let tone: Tone;
    if (p.installed === null) tone = 'not-installed';
    else if (p.latest === null) tone = 'unknown';
    else tone = compareVersions(p.latest, p.installed) > 0 ? 'update-available' : 'up-to-date';
    return { tool: p.tool, installed: p.installed, latest: p.latest, tone, source: p.source, ...choices };
}

export type UpdatePlan =
    | { readonly command: string; readonly manager: PackageManager | 'rustup' | 'npm' }
    | { readonly refused: string };

/** The update command for THIS platform, from Genie's own tables — never a guess. */
export function planUpdate(input: { tool: string; platform: Platform; packageManager: PackageManager | null }): UpdatePlan {
    const tool = HOST_TOOLS.find((t) => t.name === input.tool);
    if (!tool) return { refused: `${input.tool} is not a tool Genie manages` };
    if (tool.ownUpdater) return { command: tool.ownUpdater.command, manager: tool.ownUpdater.manager };
    const pm = input.packageManager;
    if (pm === null) return { refused: `no package manager found on this machine to update ${input.tool} with` };
    const pkg = tool.packages[pm];
    if (!pkg) return { refused: `${pm} cannot update ${input.tool} on this machine` };
    switch (pm) {
        case 'winget':
            return { command: `winget upgrade --id ${pkg} --silent --accept-package-agreements --accept-source-agreements`, manager: pm };
        case 'brew':
            return { command: `brew upgrade ${pkg}`, manager: pm };
        // `pkexec`, not `sudo`: Genie runs commands with no terminal, so `sudo` could never ask for the password and a
        // Linux update failed before it started. pkexec asks through the desktop's own polkit prompt.
        case 'apt':
            return { command: `pkexec apt-get install --only-upgrade -y ${pkg}`, manager: pm };
        case 'dnf':
            return { command: `pkexec dnf upgrade -y ${pkg}`, manager: pm };
    }
}

/**
 * HOW A MISSING TOOL WOULD BE INSTALLED HERE — the exact argv, shown to the person BEFORE anything runs (their click on
 * it is the consent), from Genie's own tables and never a guess. The package manager Genie 1 used per platform: winget
 * on Windows, Homebrew on macOS, apt or dnf on Linux through `pkexec` (one polkit prompt; `apt-get update` rides in the
 * same prompt, because installing against a stale index is the classic "no installation candidate"). npm-distributed
 * agent CLIs install with npm. `elevated` says a system prompt will appear — never a surprise.
 */
export type InstallPlan =
    | { readonly argv: readonly string[]; readonly label: string; readonly manager: PackageManager | 'npm'; readonly elevated: boolean }
    | { readonly refused: string };

/** A Debian package name; anything else never reaches `sh -c`. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9.+-]*$/;

export function planInstall(input: { tool: string; platform: Platform; packageManager: PackageManager | null }): InstallPlan {
    const tool = HOST_TOOLS.find((t) => t.name === input.tool);
    const prereq = PREREQUISITES.find((p) => p.name === input.tool);
    if (!tool && !prereq) return { refused: `${input.tool} is not a tool Genie manages` };
    if (prereq && prereq.platform !== input.platform) return { refused: `the ${prereq.label} is only needed on ${prereq.platform}` };
    if (tool?.npmPackage) {
        const [binary, args] = platformArgv('npm', ['install', '-g', tool.npmPackage], input.platform);
        return { argv: [binary, ...args], label: `npm install -g ${tool.npmPackage}`, manager: 'npm', elevated: false };
    }
    if (tool?.ownUpdater?.manager === 'npm') return { refused: `${input.tool} comes with Node; install node and it is there` };
    if (tool?.ownUpdater?.manager === 'rustup') return { refused: `${input.tool} is installed with rustup (rustup.rs); once it is there, Genie keeps it updated` };
    const pm = input.packageManager;
    if (pm === null) return { refused: `no package manager found on this machine to install ${input.tool} with` };
    const pkg = (tool?.packages ?? prereq?.packages ?? {})[pm];
    if (!pkg) return { refused: `${pm} cannot install ${input.tool} on this machine` };
    switch (pm) {
        case 'winget': {
            const argv = ['winget', 'install', '--id', pkg, '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'];
            return { argv, label: argv.join(' '), manager: pm, elevated: false };
        }
        case 'brew':
            return { argv: ['brew', 'install', pkg], label: `brew install ${pkg}`, manager: pm, elevated: false };
        case 'apt':
            if (!PACKAGE_NAME.test(pkg)) return { refused: `${pkg} is not a package name Genie will hand to a shell` };
            return { argv: ['pkexec', 'sh', '-c', `apt-get update && apt-get install -y ${pkg}`], label: `apt-get update && apt-get install -y ${pkg} (as administrator)`, manager: pm, elevated: true };
        case 'dnf':
            return { argv: ['pkexec', 'dnf', 'install', '-y', pkg], label: `dnf install -y ${pkg} (as administrator)`, manager: pm, elevated: true };
    }
}

/**
 * Known winget results, by HRESULT (genie#1306). winget exits with its HRESULT, which Node reads as an unsigned
 * (2316632084) or signed (-1978335212) number — the owner read "exited 2316632084" and learned nothing. Only codes named
 * by winget's own return-code list are worded; any other winget code is still said to be winget's, in hex.
 */
const WINGET_RESULTS: Readonly<Record<number, string>> = {
    0x8a150014: 'no installed package matched — winget did not install this copy',
    0x8a15002b: 'no applicable update was found',
};

/** An exit code in words: an HRESULT in hex (a winget one by name); an ordinary code as the number it is. */
export function exitWords(exitCode: number): string {
    if (exitCode >= 0 && exitCode <= 0x7fffffff) return `exited ${exitCode}`;
    const unsigned = exitCode >>> 0;
    const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`;
    const known = WINGET_RESULTS[unsigned];
    if (known) return `failed: winget says ${known} (${hex})`;
    return (unsigned & 0xffff0000) >>> 0 === 0x8a150000 ? `failed: winget error ${hex}` : `failed (${hex})`;
}

export type RepairOutcome =
    | { readonly kind: 'repaired'; readonly from: string | null; readonly to: string; readonly note?: string }
    | { readonly kind: 'unchanged'; readonly installed: string | null; readonly reason: string }
    | { readonly kind: 'unverified'; readonly reason: string };

/**
 * HONEST REPAIR. The outcome is the version MEASURED AFTER the command, never the command's exit
 * code: package managers exit 0 having done nothing, and exit non-zero having done the job.
 */
export function repairOutcome(input: { tool: string; wanted: string | null; before: string | null; after: string | null; exitCode: number }): RepairOutcome {
    const { tool, wanted, before, after, exitCode } = input;
    if (after === null) return { kind: 'unverified', reason: `${tool} could not be probed after the update; the result is unknown` };
    if (before !== null && compareVersions(after, before) === 0) {
        return { kind: 'unchanged', installed: after, reason: `the update command ${exitWords(exitCode)} but ${tool} still reports ${after}; nothing was changed` };
    }
    const notes: string[] = [];
    if (exitCode !== 0) notes.push(`the command ${exitWords(exitCode)} but ${tool} now reports ${after}`);
    if (wanted !== null && compareVersions(after, wanted) !== 0) notes.push(`wanted ${wanted}; the manager installed ${after}`);
    return { kind: 'repaired', from: before, to: after, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) };
}

/**
 * THE TOOLCHAIN'S GROUPS (the owner, 2026-10-18: "the items managed by the toolchain should be grouped by their type").
 * Every tool in HOST_TOOLS is in exactly one; the surface draws one section per group, in this order. A tool not in the
 * table (a newer Genie's, read by an older one) goes under Other rather than vanishing.
 */
export type ToolGroup = 'languages' | 'package-managers' | 'version-control' | 'containers' | 'agents' | 'other';

export const TOOL_GROUPS: readonly { readonly group: Exclude<ToolGroup, 'other'>; readonly label: string; readonly tools: readonly string[] }[] = [
    { group: 'languages', label: 'Languages and runtimes', tools: ['php', 'node', 'python', 'go', 'rustc'] },
    { group: 'package-managers', label: 'Package managers', tools: ['composer', 'npm', 'cargo'] },
    { group: 'version-control', label: 'Version control', tools: ['git'] },
    { group: 'containers', label: 'Containers', tools: ['docker'] },
    { group: 'agents', label: 'Agent CLIs', tools: ['claude-code', 'codex'] },
];

export function groupTools<T extends { readonly tool: string }>(tools: readonly T[]): Array<{ group: ToolGroup; label: string; tools: T[] }> {
    const known = new Set(TOOL_GROUPS.flatMap((g) => g.tools));
    const out: Array<{ group: ToolGroup; label: string; tools: T[] }> = TOOL_GROUPS.map((g) => ({
        group: g.group,
        label: g.label,
        tools: tools.filter((t) => g.tools.includes(t.tool)).sort((a, b) => g.tools.indexOf(a.tool) - g.tools.indexOf(b.tool)),
    }));
    out.push({ group: 'other', label: 'Other', tools: tools.filter((t) => !known.has(t.tool)) });
    return out.filter((g) => g.tools.length > 0);
}

/**
 * What a row's badge says. `unknown` says nothing: it was Genie not knowing the newest version, never the tool's state,
 * and a badge reading "unknown" made a working tool look broken (the owner's screenshot, 2026-10-18).
 */
export function toneLabel(tone: Tone): string | null {
    switch (tone) {
        case 'security-update':
            return 'Security update required';
        case 'update-available':
            return 'Update available';
        case 'up-to-date':
            return 'Up to date';
        case 'not-installed':
            return 'Not installed';
        default:
            return null;
    }
}
