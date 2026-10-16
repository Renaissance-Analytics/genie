import { groupByWorkspace, statusOf, targetOf, type AgentRow, type AgentState, type Fidelity, type StatusCell } from './dashboard-view.js';
import type { ChangedGroup } from './files-panel.js';

/**
 * THE WORKSPACE'S HOME — its agents, then what changed. No React in sight.
 *
 * The owner, 2026-10-12, on beta.8: *"when I select a workspace, I should not see the workspace settings, I
 * should see the agent lanes and all of the agents. This is still not built to the design doc spec."* The board's
 * workspace surface (`Workspace Files.dc.html`) is a 56px header — name, path, repo chips, an **agents strip**, the
 * Files button — over the file panel and a **320px rail "AGENTS IN <workspace>"**: one card per agent (fidelity dot,
 * name, provider, the state word, a second "doing" line), then **"CHANGES THIS SESSION"** (file · who). No terminal
 * and no setting is on that route; both are views you ask for.
 *
 * Every rule the rail follows is a pure function here, so it is tested without a DOM:
 *  - the same sort and the same vocabulary as the Dashboard (`statusOf` — `Working` is a claim, `Active` a
 *    measurement);
 *  - the "doing" line is the ONE fact worth reading, in a fixed order: the question, the failure, the target, the
 *    last delivery — else `null`, which renders as nothing (§5: never a dash, never a zero);
 *  - the changes come from the file host's own groups (§4.3: the agents' reports, you, and "changed on disk with
 *    no report" as `?`), one row per file, with **no time and no ± because the host reports neither**.
 */

export interface HomeAgent {
    id: string;
    name: string;
    /** `claude`; for an observed agent `aider · pty` — the board names the pty, because that is all Genie sees of it. */
    provider: string;
    fidelity: Fidelity;
    state: AgentState;
    word: string;
    tone: StatusCell['tone'];
    /** The second line; `null` = nothing worth saying, which renders as NOTHING. */
    doing: string | null;
}

export interface HomeChange {
    /** `you`, an agent's name, or `?` for a change nobody reported. */
    who: string;
    file: string;
}

export interface WorkspaceHomeView {
    agents: readonly HomeAgent[];
    /** True when the workspace has no agents — the rail says so and offers "+ Add agent". */
    noAgents: boolean;
    /** `null` = ABSENT: no file state, or nothing changed. Never an empty list standing in for either. */
    changes: readonly HomeChange[] | null;
}

/** The slice of the file host's state the rail reads; structurally `FilesState` without binding core to main. */
export interface HomeFilesState {
    readonly changed: readonly ChangedGroup[] | null;
}

function doingOf(row: AgentRow): string | null {
    if (row.state === 'waiting') return row.ask ? `Asks: ${row.ask}` : null;
    if (row.state === 'broken') return row.reason;
    if (row.fidelity === 'remote') return row.reason;
    const target = targetOf(row);
    if (target?.kind === 'target') return target.step ? `${target.step} · ${target.text}` : target.text;
    // Bytes are a measurement; all-zero bars are "nothing", not "0 B of output".
    if (target?.kind === 'activity') return target.bars.some((b) => b > 0) ? 'Terminal output' : null;
    if (row.delivery) return `Last: ${row.delivery.main} · ${row.delivery.age}`;
    return null;
}

export function workspaceHome(rows: readonly AgentRow[], workspaceId: string, files: HomeFilesState | null): WorkspaceHomeView {
    const [group] = groupByWorkspace(rows, [workspaceId]);
    const mine = group?.rows ?? [];
    const agents = mine.map((row): HomeAgent => {
        const status = statusOf(row);
        return {
            id: row.id,
            name: row.name,
            provider: row.fidelity === 'observed' ? `${row.provider} · pty` : row.provider,
            fidelity: row.fidelity,
            state: row.state,
            word: status.word,
            tone: status.tone,
            doing: doingOf(row),
        };
    });
    const changed = files?.changed ?? null;
    const changes = changed && changed.length > 0 ? changed.flatMap((g) => g.files.map((file): HomeChange => ({ who: g.who, file }))) : null;
    return { agents, noAgents: agents.length === 0, changes };
}
