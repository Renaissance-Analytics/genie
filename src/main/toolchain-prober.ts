import { HOST_TOOLS, parseVersionOutput, planUpdate, repairOutcome, toolStatus, type PackageManager, type Platform, type RepairOutcome, type ToolStatus } from '../core/toolchain.js';

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

export type CommandRunner = (binary: string, args: readonly string[]) => Promise<{ stdout: string; exitCode: number }>;
export type LatestIndex = (tool: string) => Promise<{ version: string; source: string } | null>;

async function probeInstalled(tool: (typeof HOST_TOOLS)[number], run: CommandRunner): Promise<string | null> {
    try {
        // `go version` is the one banner not behind `--version`; its probe lists both so the registry
        // test can see the flag, and the real call drops it.
        const args = tool.probe.args.length > 1 ? tool.probe.args.filter((a) => a !== '--version') : tool.probe.args;
        const r = await run(tool.probe.binary, args);
        return parseVersionOutput(tool.name, r.stdout);
    } catch {
        return null;
    }
}

export async function probeTools(run: CommandRunner, latest: LatestIndex): Promise<ToolStatus[]> {
    return Promise.all(
        HOST_TOOLS.map(async (tool) => {
            const installed = await probeInstalled(tool, run);
            let idx: { version: string; source: string } | null = null;
            try {
                idx = await latest(tool.name);
            } catch {
                idx = null;
            }
            return toolStatus({ tool: tool.name, installed, latest: idx?.version ?? null, source: idx?.source ?? null });
        }),
    );
}

const WINDOW_MS = 6 * 3_600_000;

export function shouldCheckUpdates(lastCheckedAt: number | null, now: number, force = false): boolean {
    if (force || lastCheckedAt === null) return true;
    if (lastCheckedAt > now) return true;
    return now - lastCheckedAt >= WINDOW_MS;
}

/** Split a planned command line into binary + args. The plans are Genie's own tables, so the split is plain whitespace. */
function argv(command: string): [string, string[]] {
    const [binary, ...args] = command.split(/\s+/);
    return [binary!, args];
}

export async function runUpdate(
    tool: string,
    where: { platform: Platform; packageManager: PackageManager | null },
    run: CommandRunner,
    wanted: string | null,
): Promise<RepairOutcome | { kind: 'refused'; reason: string }> {
    const plan = planUpdate({ tool, ...where });
    if ('refused' in plan) return { kind: 'refused', reason: plan.refused };
    const def = HOST_TOOLS.find((t) => t.name === tool)!;
    const before = await probeInstalled(def, run);
    const [binary, args] = argv(plan.command);
    let exitCode: number;
    try {
        exitCode = (await run(binary, args)).exitCode;
    } catch (error) {
        exitCode = -1;
        void error;
    }
    const after = await probeInstalled(def, run);
    return repairOutcome({ tool, wanted, before, after, exitCode });
}
