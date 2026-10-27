import { formatRoute, parseRoute } from './route.js';
import type { Activation } from './window-activation.js';

/**
 * AN AGENT NEVER MOVES THE PERSON'S VIEW (genie#1265; the owner, 2026-10-27: "when an agent opens a file in the file
 * browser or a tab or does anything that right now draws my focus to whatever workspace it was done in, [it] should not
 * change my view or cursor focus, the workspace row in the sidebar and dashboard (if open) should pulse until I navigate
 * there").
 *
 * window-activation.ts decides who may put a WINDOW in front (genie#1235); this decides who may move what the window
 * SHOWS, by the same split. `user-gesture` — the tray, a menu, a notification the person clicked — navigates
 * (`genie:navigate`). `background` — an agent's `openFileForUser`, `workspaceTabs`, `sites open` — never navigates: it
 * marks the workspace it acted in (`genie:workspace-pulse`), with the file it opened there, if any. The window keeps the
 * mark; the workspace's rail row (and its Dashboard header, when the Dashboard is open) pulses until the person ARRIVES at
 * that workspace, and the arrival is what opens the file in the workspace's file panel.
 *
 * Genie 1 did the opposite for a file (v0.7.0-beta.342 main/background.ts `sendOpenFile`: `showMasterWindow()` and an
 * editor panel opened in front) and had the row-glow for imDone / ForceTheQuestion (renderer/lib/attention.ts
 * `workspaceNeedsAttention`, Chooser.tsx `wsAttention`, master.css `attention-row-glow`, cleared when the person focused
 * the terminal). Genie 2 keeps the glow and drives it with what an agent did instead of moving the person.
 *
 * Main reaches the window's view through `showToPerson(request)` and nothing else (agent-actions-pulse-wiring.test.ts).
 */

/** What an agent did in a workspace, for the window: which workspace, what asked, and the file it opened there, if any. */
export interface WorkspacePulse {
    readonly workspaceId: string;
    /** The tool, as a log reader would search for it: `openFileForUser`, `workspaceTabs`, `sites open`. */
    readonly reason: string;
    readonly file: string | null;
    readonly line: number | null;
}

export type ViewRequest =
    | { readonly activation: Extract<Activation, 'user-gesture'>; readonly route: string; readonly reason: string }
    | { readonly activation: Extract<Activation, 'background'>; readonly workspaceId: string; readonly reason: string; readonly file?: string | null; readonly line?: number | null };

export type ViewDelivery =
    | { readonly channel: 'genie:navigate'; readonly payload: string }
    | { readonly channel: 'genie:workspace-pulse'; readonly payload: WorkspacePulse };

/** The person's gesture navigates; anything else marks its workspace and moves nothing. */
export function viewDelivery(request: ViewRequest): ViewDelivery {
    if (request.activation === 'user-gesture') return { channel: 'genie:navigate', payload: request.route };
    return { channel: 'genie:workspace-pulse', payload: { workspaceId: request.workspaceId, reason: request.reason, file: request.file ?? null, line: request.line ?? null } };
}

/** The workspaces marked and not yet visited, each with what waits there. */
export type Pulses = Readonly<Record<string, WorkspacePulse>>;

export const NO_PULSES: Pulses = Object.freeze({});

/** A mark kept. A later file replaces an earlier one; a later change with no file keeps the file opened before it. */
export function pulse(pulses: Pulses, p: WorkspacePulse): Pulses {
    const before = pulses[p.workspaceId];
    const next: WorkspacePulse = p.file === null && before && before.file !== null ? { ...p, file: before.file, line: before.line } : p;
    return { ...pulses, [p.workspaceId]: next };
}

/**
 * The person is at `route` (their click, a key, the palette, Back — every way the route moves, since an agent no longer
 * moves it). At a marked workspace's own page the mark clears, and what the agent opened is shown: `show` is the same page
 * with the file panel on that file — unless the person's route already names a file, which wins. Anywhere else: the
 * same `pulses` object back, so nothing re-renders.
 */
export function arrive(pulses: Pulses, route: string): { pulses: Pulses; show: string | null } {
    const at = parseRoute(route);
    if (at.surface !== 'workspace') return { pulses, show: null };
    const waiting = pulses[at.workspaceId];
    if (!waiting) return { pulses, show: null };
    const rest: Record<string, WorkspacePulse> = { ...pulses };
    delete rest[at.workspaceId];
    const show = waiting.file !== null && at.file === null && !at.detached
        ? formatRoute({ ...at, panel: 'files', file: waiting.file, line: waiting.line })
        : null;
    return { pulses: rest, show };
}

export function pulsingIds(pulses: Pulses): ReadonlySet<string> {
    return new Set(Object.keys(pulses));
}
