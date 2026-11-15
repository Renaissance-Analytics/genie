import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRow } from '../../src/core/dashboard-view.js';
import type { DeckItem, SignalAction, SignalState } from '../../src/core/deck.js';
import type { ApprovalAnswering } from '../../src/core/approval-answering.js';
import { Dashboard } from '../../src/renderer/components/Dashboard.js';

/**
 * THE WAITING ITEMS AS THE DASHBOARD DRAWS THEM (Tynn #730: the Deck is not a page). The Deck page is gone; its rows are the
 * Dashboard's waiting items under each agent's row, and the tests that read those rows draw them through this helper: one agent
 * row per agent named by an item, every row opened (an item with no agent is on the Genie row, opened), the Deck's own props.
 */
export interface DeckOnDashboardProps {
    items: readonly DeckItem[];
    signals: SignalState;
    answering: ApprovalAnswering | null;
    onAnswer: (item: DeckItem, optionId: string, note?: string) => void;
    onOpenItem: (item: DeckItem) => void;
    onNavigate?: ((route: string) => void) | undefined;
    onSignalAction?: ((action: SignalAction) => void) | undefined;
    onAnswerForm?: ((item: DeckItem, selections: string[][], notes: string[]) => void) | undefined;
    formRefusal?: { itemId: string; reason: string } | null | undefined;
    focusId?: string | null | undefined;
    onDismiss?: ((item: DeckItem, notes: string[]) => void) | undefined;
    onDismissOlder?: ((olderThanMs: number) => void) | undefined;
    onDismissStale?: ((ids: string[]) => void) | undefined;
    onTrustWorkspace?: ((workspaceId: string) => Promise<unknown>) | undefined;
    initiallyExpanded?: readonly string[] | undefined;
    busy?: { itemId: string; optionId: string } | null | undefined;
    toastIds?: ReadonlySet<string> | undefined;
    now?: number | undefined;
}

const rowFor = (item: DeckItem): AgentRow => ({
    id: item.agentId!, name: item.agentName ?? item.agentId!, provider: 'claude', workspaceId: item.workspaceId ?? 'ws_none', fidelity: 'declared', state: 'working',
    duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});

export function DeckOnDashboard(props: DeckOnDashboardProps) {
    const withAgent = props.items.filter((i) => i.agentId !== null);
    const rows = [...new Map(withAgent.map((i) => [i.agentId!, rowFor(i)])).values()];
    const workspaceIds = [...new Set(['ws_none', ...rows.map((r) => r.workspaceId)])];
    // A workspace is named as the rail says it (its NAME, never its id); one this machine has no name for is said as such.
    const nameOf = (id: string): string => props.items.find((i) => i.workspaceId === id && i.workspaceName)?.workspaceName ?? 'A workspace not known here';
    const { onNavigate, focusId, ...waiting } = props;
    return (
        <Dashboard
            rows={rows}
            workspaces={workspaceIds.map((id) => ({ id, path: `/w/${id}`, name: nameOf(id) }))}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onNavigate={onNavigate}
            waiting={{ ...waiting, focusItemId: focusId ?? null, initiallyOpen: [...rows.map((r) => r.id), 'genie:'] }}
        />
    );
}

export const drawDeck = (props: DeckOnDashboardProps): string => renderToStaticMarkup(<DeckOnDashboard {...props} />);
