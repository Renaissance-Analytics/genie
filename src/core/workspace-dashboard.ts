import { groupByWorkspace, statusOf, type AgentRow, type AgentState, type Fidelity, type StatusCell } from './dashboard-view.js';
import { deckBand, isStale, type DeckItem } from './deck.js';
import { ageOf } from './delivery.js';

/**
 * THE WORKSPACE DASHBOARD — the workspace's first tab. No React in sight.
 *
 * The owner, 2026-10-19: *"get rid of the fucking Agents in the workspace. That should be a Workspace dashboard showing all
 * work being done by any running agents, not some lame agent list with file changes."* The design he approved
 * (q_09d1f4a0, "build that"):
 *
 *   - a card per agent of THIS workspace that is running or waiting: what it was asked, the tool it is in now, its plan
 *     step, how long it has been working; a card opens its agent;
 *   - above the cards: what waits on YOU in this workspace — its questions and approvals, as the Deck counts them
 *     (`deckBand`, minus the stale ones);
 *   - below: the last finished turns with their handoffs, newest first;
 *   - no file-change lists.
 *
 * What was not reported is `null` and renders as nothing (§5: never a dash, never a zero).
 */

export interface DashCard {
    id: string;
    name: string;
    provider: string;
    fidelity: Fidelity;
    state: AgentState;
    word: string;
    tone: StatusCell['tone'];
    /** What started its turn. */
    asked: string | null;
    /** The tool it is in now — never claimed for an agent that is waiting on you. */
    tool: string | null;
    /** `3/7`, and what that step is. */
    step: string | null;
    doing: string | null;
    duration: string | null;
    /** What it asks you, when waiting. */
    ask: string | null;
}

export interface DashWaiting {
    id: string;
    title: string;
    agentName: string | null;
}

export interface DashHandoff {
    agentId: string;
    name: string;
    text: string;
    age: string;
}

export interface WorkspaceDashboardView {
    /** EVERY agent of the workspace, for the header's agents strip (a pill each, idle ones too), in the board's order. */
    strip: ReadonlyArray<{ id: string; name: string; fidelity: Fidelity; state: AgentState; word: string }>;
    waiting: readonly DashWaiting[];
    cards: readonly DashCard[];
    handoffs: readonly DashHandoff[];
    /** The workspace has no agents at all: "No agents in X." and + Add agent. */
    noAgents: boolean;
    /** It has agents and none is running or waiting: "Nothing is running in X." */
    quiet: boolean;
}

/** The last finished turns shown — the newest few, not a log. */
export const DASH_HANDOFFS = 5;

export function workspaceDashboard(input: { rows: readonly AgentRow[]; workspaceId: string; deckItems: readonly DeckItem[]; now: number }): WorkspaceDashboardView {
    const [group] = groupByWorkspace(input.rows, [input.workspaceId]);
    const mine = group?.rows ?? [];
    const cards = mine
        .filter((row) => row.state === 'working' || row.state === 'waiting')
        .map((row): DashCard => {
            const status = statusOf(row);
            return {
                id: row.id,
                name: row.name,
                provider: row.provider,
                fidelity: row.fidelity,
                state: row.state,
                word: status.word,
                tone: status.tone,
                asked: row.asked ?? null,
                tool: row.state === 'working' ? row.tool ?? null : null,
                step: row.step,
                doing: row.target,
                duration: row.duration,
                ask: row.state === 'waiting' ? row.ask : null,
            };
        });
    const waiting = deckBand(input.deckItems)
        .filter((item) => item.workspaceId === input.workspaceId && !isStale(item))
        .map((item): DashWaiting => ({ id: item.id, title: item.title, agentName: item.agentName }));
    const handoffs = mine
        .flatMap((row) => (row.handoff ? [{ row, handoff: row.handoff }] : []))
        .sort((a, b) => b.handoff.at - a.handoff.at)
        .slice(0, DASH_HANDOFFS)
        .map(({ row, handoff }): DashHandoff => ({ agentId: row.id, name: row.name, text: handoff.text, age: ageOf(handoff.at, input.now) }));
    const strip = mine.map((row) => ({ id: row.id, name: row.name, fidelity: row.fidelity, state: row.state, word: statusOf(row).word }));
    return { strip, waiting, cards, handoffs, noAgents: mine.length === 0, quiet: mine.length > 0 && cards.length === 0 };
}
