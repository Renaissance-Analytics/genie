import type { CSSProperties } from 'react';
import type { AgentState } from '../core/dashboard-view.js';

/**
 * AN AGENT'S STATUS COLOUR — one map for every place that draws it (the Dashboard's row, fidelity dot and census chip;
 * the sidebar's agent list, Tynn #687: "status (colored like the dashboard uses, no label)").
 *
 * Cooling (core/session.ts COOLING_MS) has its own colour, not Working's green nor Idle's grey.
 */
export const AGENT_STATUS_COLOR: Readonly<Record<AgentState, string>> = {
    working: 'var(--success)', cooling: 'var(--sky-400)', waiting: 'var(--warning)', broken: 'var(--danger)',
    idle: 'var(--zinc-400)', sleeping: 'var(--fg-4)', stopped: 'var(--danger)', remote: 'var(--fg-4)',
};

/** The colour as the `--agent-status` custom property the markup reads (`text-[var(--agent-status)]`, …). */
export const agentStatusStyle = (state: AgentState): CSSProperties => ({ '--agent-status': AGENT_STATUS_COLOR[state] } as CSSProperties);
