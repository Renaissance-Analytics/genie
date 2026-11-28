import type { CallContext } from '../core/remote-protocol.js';
import type { ToolStatus } from '../core/toolchain.js';
import type { FeatureAction, FeatureData, ToolchainSection } from '../renderer/features.js';

/**
 * THE HOST'S TOOLS IN THE LAUNCHER'S UPDATES (Tynn #1058 L7, #716). The launcher's Updates list shows this host's toolchain
 * rows beside its tracks, and its Update is this host's own installer: `toolchain.update` through HostFeatures, the very
 * action Settings → Toolchain's Update runs (its update-risk guard, its drain of the agents on a CLI, its elevation). The
 * launcher only reads and asks, over its link (`engine.toolchain`): `state`, `check`, `update`. It installs nothing.
 *
 * The launcher opens a new link for each call, so it asks as ONE feature caller (`genie-launcher`): a refusal, a warning
 * to confirm or the version an update reached is still there on its next read.
 */

export const LAUNCHER_FEATURE_CALLER = 'genie-launcher';

/** Who the launcher is to HostFeatures: this machine's own, its owner, the whole host. Never a window (it presents nothing). */
const LAUNCHER_CONTEXT: CallContext = Object.freeze({
    connectionId: LAUNCHER_FEATURE_CALLER, origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'Genie’s launcher',
});

export interface LauncherToolchainFeatures {
    snapshot(context: CallContext): Promise<FeatureData>;
    act(action: FeatureAction, context: CallContext): Promise<FeatureData>;
}

export interface LauncherToolchain {
    call(method: string, args: readonly unknown[]): Promise<unknown>;
}

/** One row of the launcher's list: a tool with an update, and what it is doing now. */
export interface LauncherToolRow {
    readonly tool: string;
    readonly label: string;
    readonly installed: string | null;
    readonly to: string | null;
    readonly tone: 'update-available' | 'security-update';
    readonly advisory?: string;
    readonly updating?: string;
    readonly warning?: string;
    readonly refused?: string;
    readonly updated?: string;
}

export interface LauncherToolsAnswer {
    readonly rows: readonly LauncherToolRow[];
    readonly checkedAt: number | null;
    readonly checking: boolean;
}

/** The names the Toolchain page uses for the rows a launcher shows (an unknown tool reads as its id). */
const LABELS: Readonly<Record<string, string>> = {
    php: 'PHP', node: 'Node', python: 'Python', go: 'Go', dotnet: '.NET', rust: 'Rust', ruby: 'Ruby', java: 'Java',
    'claude-code': 'Claude Code', codex: 'Codex', git: 'Git', docker: 'Docker', composer: 'Composer', playwright: 'Playwright',
};

const HAS_UPDATE = (t: ToolStatus): t is ToolStatus & { tone: LauncherToolRow['tone'] } => t.tone === 'update-available' || t.tone === 'security-update';

/** What a tool updates to: the patch in its line first (a security notice's fix), else the newest (as the Toolchain page). */
const target = (t: ToolStatus): string | null => t.patch ?? t.latest ?? null;

export function launcherRows(section: ToolchainSection | null): LauncherToolsAnswer {
    if (!section) return { rows: [], checkedAt: null, checking: false };
    const rows = section.tools.filter(HAS_UPDATE).map((t): LauncherToolRow => {
        const refusal = section.refusals?.find((r) => r.tool === t.tool && r.version === undefined);
        return {
            tool: t.tool, label: LABELS[t.tool] ?? t.tool, installed: t.installed, to: target(t), tone: t.tone,
            ...(t.advisory ? { advisory: t.advisory } : {}),
            ...(section.updating?.tool === t.tool ? { updating: section.updating.step } : {}),
            ...(section.warning?.tool === t.tool ? { warning: section.warning.reason } : {}),
            ...(refusal ? { refused: refusal.reason } : {}),
            ...(section.updated?.tool === t.tool ? { updated: section.updated.version } : {}),
        };
    });
    return { rows, checkedAt: section.checkedAt, checking: section.checkRun?.running === true };
}

export function launcherToolchain(features: () => LauncherToolchainFeatures | null): LauncherToolchain {
    const own = (): LauncherToolchainFeatures => {
        const f = features();
        if (!f) throw new Error('This host has no toolchain yet.');
        return f;
    };
    /** An update whose action threw (not a refusal the toolchain said itself): its reason, until it is asked again. */
    const threw = new Map<string, string>();
    const state = async (): Promise<LauncherToolsAnswer> => {
        const answer = launcherRows((await own().snapshot(LAUNCHER_CONTEXT)).toolchain);
        return { ...answer, rows: answer.rows.map((r) => (threw.has(r.tool) && !r.refused ? { ...r, refused: threw.get(r.tool)! } : r)) };
    };
    return {
        async call(method, args) {
            switch (method) {
                case 'state':
                    return state();
                case 'check':
                    await own().act({ kind: 'toolchain.check', force: true }, LAUNCHER_CONTEXT);
                    return state();
                case 'update': {
                    const a = (args[0] ?? {}) as { tool?: unknown; version?: unknown; confirmed?: unknown };
                    if (typeof a.tool !== 'string' || a.tool === '') throw new Error('update needs {tool}');
                    const f = own();
                    const row = launcherRows((await f.snapshot(LAUNCHER_CONTEXT)).toolchain).rows.find((r) => r.tool === a.tool);
                    if (!row) throw new Error(`${a.tool} has no update to install.`);
                    const version = typeof a.version === 'string' && a.version !== '' ? a.version : row.to;
                    const action: FeatureAction = { kind: 'toolchain.update', tool: a.tool, ...(version ? { version } : {}), ...(a.confirmed === true ? { confirmed: true } : {}) };
                    // Answered once it has started: an install takes minutes, and its step is read back with `state`. What
                    // it ends in (updated, refused, a warning to confirm) is this caller's, read the same way.
                    const tool = a.tool;
                    threw.delete(tool);
                    void f.act(action, LAUNCHER_CONTEXT).catch((error: unknown) => { threw.set(tool, error instanceof Error ? error.message : String(error)); });
                    return { started: true, tool: a.tool, version };
                }
                default:
                    throw new Error(`Genie’s launcher may not ask the toolchain for ${method}.`);
            }
        },
    };
}
