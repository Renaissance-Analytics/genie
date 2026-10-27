import { createContext, useContext, type CSSProperties } from 'react';
import type { AgentRow } from '../core/dashboard-view.js';
import type { RailWorkspace } from '../core/rail-view.js';

/**
 * WORKSPACE COLOURS IN THE WINDOW (genie#1300). The snapshot carries each workspace's colour (`RailWorkspace.color`);
 * this makes it reachable from any surface that names a recipient — by workspace, or by agent (an agent is shown in its
 * workspace's colour) — without threading a prop through every layer.
 *
 * Drawing: a surface sets the colour as the CSS variable `--ws` (`wsStyle`) and its classes read `var(--ws)`, so the
 * classes stay mergeable (docs/decisions.md D2's reason for avoiding inline styles) and only the value is data. The
 * swatch or edge carries `data-workspace-color="<hex>"`. Colour is never the only cue: every surface keeps the name.
 */

export interface WorkspaceColorMap {
    /** Workspace id → `#rrggbb`. A workspace with no colour is not here. */
    readonly workspaces: Readonly<Record<string, string>>;
    /** Agent id → its workspace's colour. */
    readonly agents: Readonly<Record<string, string>>;
}

export const NO_WORKSPACE_COLORS: WorkspaceColorMap = { workspaces: {}, agents: {} };

export const WorkspaceColorsContext = createContext<WorkspaceColorMap>(NO_WORKSPACE_COLORS);

/** The window's map, from the snapshot: each workspace's colour, and each agent's by its workspace. */
export function workspaceColorMap(snapshot: { readonly workspaces: readonly RailWorkspace[] | null; readonly agents: readonly Pick<AgentRow, 'id' | 'workspaceId'>[] }): WorkspaceColorMap {
    const workspaces: Record<string, string> = {};
    for (const w of snapshot.workspaces ?? []) if (w.color) workspaces[w.id] = w.color;
    const agents: Record<string, string> = {};
    for (const a of snapshot.agents) {
        const color = workspaces[a.workspaceId];
        if (color) agents[a.id] = color;
    }
    return { workspaces, agents };
}

export function useWorkspaceColor(workspaceId: string | null | undefined): string | null {
    const map = useContext(WorkspaceColorsContext);
    return workspaceId ? map.workspaces[workspaceId] ?? null : null;
}

export function useAgentColor(agentId: string | null | undefined): string | null {
    const map = useContext(WorkspaceColorsContext);
    return agentId ? map.agents[agentId] ?? null : null;
}

/** The colour as `--ws`, for classes that read `var(--ws)`; `undefined` (no style at all) without one. */
export function wsStyle(color: string | null | undefined): CSSProperties | undefined {
    return color ? ({ '--ws': color } as CSSProperties) : undefined;
}

/** A small dot in the workspace's colour, beside a name. Nothing at all without a colour — never an empty swatch. */
export function WorkspaceSwatch({ color, className = '' }: { color: string | null | undefined; className?: string }) {
    if (!color) return null;
    return <span aria-hidden="true" data-workspace-color={color} style={wsStyle(color)} className={`inline-block size-2 shrink-0 rounded-full bg-[var(--ws)] ${className}`} />;
}
