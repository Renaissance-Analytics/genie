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

export type Platform = 'win32' | 'darwin' | 'linux';
export type PackageManager = 'winget' | 'brew' | 'apt' | 'dnf';

export interface HostTool {
    readonly name: string;
    readonly probe: { readonly binary: string; readonly args: readonly string[] };
    /** The id each package manager knows the tool by; absent = that manager cannot update it. */
    readonly packages: Partial<Record<PackageManager, string>>;
    /** A tool with its own updater (rustup) or distribution (npm -g) ignores the OS package manager. */
    readonly ownUpdater?: { readonly manager: 'rustup' | 'npm'; readonly command: string };
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
    { name: 'claude-code', probe: { binary: 'claude', args: ['--version'] }, packages: {}, ownUpdater: { manager: 'npm', command: 'npm install -g @anthropic-ai/claude-code@latest' } },
    { name: 'codex', probe: { binary: 'codex', args: ['--version'] }, packages: {}, ownUpdater: { manager: 'npm', command: 'npm install -g @openai/codex@latest' } },
];

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
}

export type Tone = 'update-available' | 'up-to-date' | 'unknown' | 'not-installed';

export interface ToolStatus {
    readonly tool: string;
    readonly installed: string | null;
    readonly latest: string | null;
    readonly tone: Tone;
    readonly source: string | null;
}

/** The badge. `unknown` when no source could name a latest — never `up-to-date` by default. */
export function toolStatus(p: ToolProbe): ToolStatus {
    let tone: Tone;
    if (p.installed === null) tone = 'not-installed';
    else if (p.latest === null) tone = 'unknown';
    else tone = compareVersions(p.latest, p.installed) > 0 ? 'update-available' : 'up-to-date';
    return { tool: p.tool, installed: p.installed, latest: p.latest, tone, source: p.source };
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
        case 'apt':
            return { command: `sudo apt-get install --only-upgrade -y ${pkg}`, manager: pm };
        case 'dnf':
            return { command: `sudo dnf upgrade -y ${pkg}`, manager: pm };
    }
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
        return { kind: 'unchanged', installed: after, reason: `the update command exited ${exitCode} but ${tool} still reports ${after}; nothing was changed` };
    }
    const notes: string[] = [];
    if (exitCode !== 0) notes.push(`the command exited ${exitCode} but ${tool} now reports ${after}`);
    if (wanted !== null && compareVersions(after, wanted) !== 0) notes.push(`wanted ${wanted}; the manager installed ${after}`);
    return { kind: 'repaired', from: before, to: after, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) };
}
