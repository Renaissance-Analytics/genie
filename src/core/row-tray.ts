import type { AgentRow, DeliveryKind } from './dashboard-view.js';

/**
 * THE ROW TRAY (§4.1 `Space`; `genie-2-dashboard-design.md` §2.3): what the row's one-line columns cannot hold,
 * READ-ONLY plus three doors. Each section is present only when the row measured it (the null rule — absent, never
 * empty); the doors are always there. `Terminal →` opens the agent's workspace, where its terminals live (an agent
 * has none of its own); `Files →` opens that workspace's file panel.
 */
export interface RowTray {
    readonly target: { step: string | null; text: string } | null;
    readonly delivered: { kind: DeliveryKind; main: string; plus: number | null; minus: number | null; age: string } | null;
    readonly context: { used: number; size: number } | null;
    readonly doors: readonly { door: 'agent' | 'terminal' | 'files'; label: string; route: string }[];
}

export function trayOf(row: AgentRow): RowTray {
    return {
        target: row.target === null ? null : { step: row.step, text: row.target },
        delivered: row.delivery === null ? null : { kind: row.delivery.kind, main: row.delivery.main, plus: row.delivery.plus, minus: row.delivery.minus, age: row.delivery.age },
        context: row.contextUsed === null || row.contextSize === null ? null : { used: row.contextUsed, size: row.contextSize },
        doors: [
            { door: 'agent', label: 'Open agent →', route: `genie://agent/${row.id}` },
            { door: 'terminal', label: 'Terminal →', route: `genie://workspace/${row.workspaceId}` },
            { door: 'files', label: 'Files →', route: `genie://workspace/${row.workspaceId}?files=` },
        ],
    };
}
