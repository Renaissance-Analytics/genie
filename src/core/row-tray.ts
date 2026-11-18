import type { AgentRow, DeliveryKind } from './dashboard-view.js';

/**
 * THE ROW TRAY (§4.1 `Space`; `genie-2-dashboard-design.md` §2.3): what the row's one-line columns cannot hold,
 * READ-ONLY plus three doors. Each section is present only when the row measured it (the null rule — absent, never
 * empty); the doors are always there. `Terminal →` opens a SHELL in the agent's workspace, in a window of its own (Tynn
 * #857: the row's terminal opener, `scratchTerminal`, as the sidebar button and Open window → Terminal since #851; an
 * agent has no terminal of its own). It has no route: it never navigates. `Files →` opens that workspace's file panel.
 */
export interface RowTray {
    readonly target: { step: string | null; text: string } | null;
    readonly delivered: { kind: DeliveryKind; main: string; plus: number | null; minus: number | null; age: string } | null;
    readonly context: { used: number; size: number } | null;
    readonly doors: readonly RowTrayDoor[];
}

/** The navigating doors carry a route; the terminal door opens a window and carries none. */
export type RowTrayDoor = { door: 'agent' | 'files'; label: string; route: string } | { door: 'terminal'; label: string };

export function trayOf(row: AgentRow): RowTray {
    return {
        target: row.target === null ? null : { step: row.step, text: row.target },
        delivered: row.delivery === null ? null : { kind: row.delivery.kind, main: row.delivery.main, plus: row.delivery.plus, minus: row.delivery.minus, age: row.delivery.age },
        context: row.contextUsed === null || row.contextSize === null ? null : { used: row.contextUsed, size: row.contextSize },
        doors: [
            { door: 'agent', label: 'Open agent →', route: `genie://agent/${row.id}` },
            { door: 'terminal', label: 'Terminal →' },
            { door: 'files', label: 'Files →', route: `genie://workspace/${row.workspaceId}?files=` },
        ],
    };
}
