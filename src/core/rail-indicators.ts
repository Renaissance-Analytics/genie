/**
 * THE WORKSPACE ROW'S INDICATORS — GENIE 1'S ROW (the owner, 2026-10-19: "I do need an indicator on the workspace row
 * that lets me know what workspaces have working agents. We used to have the agent pulse … the new one should be based
 * on ACP activity, NOT terminals. We do need our bg process and sites indicators as well.") — pure.
 *
 * - The PULSE: how many of the workspace's agents are mid-turn, by their sessions' turn state (core/roster.ts gives a
 *   row `working` only while its session is running and its turn is working). Never terminal output.
 * - PROCESSES: Genie 1's `wsProcStatus` (v1 Chooser.tsx) — none / idle / running / crashed.
 * - SITES: Genie 1's `railSitesTone` (v1 lib/dev-server.ts) — no site: nothing; else running / starting / failed / idle.
 */

export type ProcessTone = 'none' | 'idle' | 'running' | 'crashed';
export type SiteTone = 'running' | 'starting' | 'failed' | 'idle';

type Of = { readonly workspaceId: string; readonly state: string };

export function workingAgents(rows: readonly Of[], workspaceId: string): number {
    return rows.filter((r) => r.workspaceId === workspaceId && r.state === 'working').length;
}

export function processTone(processes: readonly Of[], workspaceId: string): ProcessTone {
    const mine = processes.filter((p) => p.workspaceId === workspaceId);
    if (mine.length === 0) return 'none';
    if (mine.some((p) => p.state === 'failed')) return 'crashed';
    return mine.some((p) => p.state === 'running' || p.state === 'restarting') ? 'running' : 'idle';
}

export function processTitle(processes: readonly Of[], workspaceId: string): string {
    const n = processes.filter((p) => p.workspaceId === workspaceId).length;
    return n === 0 ? 'No background processes — click to open' : `Background processes (${n}) — click to open`;
}

export function siteTone(sites: readonly Of[], workspaceId: string): SiteTone | null {
    const mine = sites.filter((s) => s.workspaceId === workspaceId);
    if (mine.length === 0) return null;
    if (mine.some((s) => s.state === 'running')) return 'running';
    // A start in flight: something IS happening, so an idle dot would read as "nothing here".
    if (mine.some((s) => s.state === 'restarting')) return 'starting';
    // A site Genie cannot serve will not come up: failed, not quietly idle.
    if (mine.some((s) => s.state === 'failed' || s.state === 'unservable')) return 'failed';
    return 'idle';
}

export function siteTitle(sites: readonly Of[], workspaceId: string): string {
    const mine = sites.filter((s) => s.workspaceId === workspaceId);
    if (mine.length === 0) return 'No hosted sites yet — click to open the Site Manager';
    const running = mine.filter((s) => s.state === 'running').length;
    const failed = mine.filter((s) => s.state === 'failed').length;
    const parts = [`${mine.length} hosted site${mine.length === 1 ? '' : 's'}`];
    if (running) parts.push(`${running} running`);
    if (failed) parts.push(`${failed} failed`);
    return `${parts.join(' · ')} — click to open the Site Manager`;
}
