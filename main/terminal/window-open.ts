import type { AgentType } from '../mcp/protocol';
import { planTerminalWindow, type TerminalWindowRequest } from './window-plan';

/**
 * Open a terminal or a TUI agent in its OWN WINDOW — the acting half of Tynn #447.
 *
 * Owner direction: every workspace can open a terminal, or start an agent in TUI mode, and
 * it opens as a window so TheFloor stays clean under the Genie 2 UX.
 *
 * `window-plan.ts` already decided WHAT a window should be; until now nothing called it.
 * This is the bridge from that decision to a registered spec and an open window.
 *
 * ## The order is the whole point
 *
 * **Spec first, window second.** The renderer attaches by spec id, so a window opened
 * before its spec exists renders an empty panel with nothing to recover from — and if spec
 * creation then fails, the real reason ("no command configured for that agent") never
 * reaches anyone because the window is already up and looks like Genie broke.
 *
 * So there is no partial success here: either a spec exists and a window is addressed to
 * it, or nothing opened at all and the caller has the underlying error verbatim.
 */

export interface WindowOpenPorts {
    /** `createTerminalSpec` — a plain pty spec in a workspace. */
    createTerminal: (o: { workspaceId: string; cwd?: string }) => SpecResult;
    /**
     * `createSpecializedAgentTerminal` — a spec with `meta.agent` set.
     *
     * Separate from `createTerminal` on purpose. An agent needs the identity that only this
     * path mints: `GENIE_TERMINAL_ID`, the per-terminal MCP token, AgentInbox identity, a
     * roster entry, cap accounting and revival. A plain spec with a command typed into it
     * has none of them.
     */
    createAgent: (o: { workspaceId: string; agent: AgentType; command?: string }) => SpecResult;
    /** Open the window on `main/acp`-free renderer route `?spec=<id>`. */
    openWindow: (route: string, title: string) => void;
    /** For the window title, so several windows are tellable apart. */
    workspaceName: (workspaceId: string) => string | null;
}

export type SpecResult = { ok: true; specId: string; cwd?: string } | { ok: false; error: string };

export type OpenResult =
    | { ok: true; specId: string }
    | { ok: false; reason: 'no-workspace' }
    | { ok: false; reason: 'create-failed'; error: string };

export function openTerminalWindow(req: TerminalWindowRequest, ports: WindowOpenPorts): OpenResult {
    const plan = planTerminalWindow(req);
    // Refused before anything is created. `planTerminalWindow` owns this decision and is
    // tested separately; re-deriving it here would be two places to get it wrong.
    if (!plan.ok) return { ok: false, reason: plan.reason };

    const created: SpecResult =
        plan.create === null
            ? // TAKING OVER: the spec exists, so nothing is created and the request's own id
              // is what the window is addressed to. Routing this through the create branch
              // would have started a second agent beside the one being taken over — see
              // `window-plan.test.ts`, which states that hazard in full.
              {
                  ok: true,
                  specId: req.kind === 'existing' ? req.specId : '',
                  ...(req.kind === 'existing' && req.cwd ? { cwd: req.cwd } : {}),
              }
            : plan.create.kind === 'agent'
              ? ports.createAgent({
                    workspaceId: plan.create.workspaceId,
                    agent: plan.create.agent,
                    ...(plan.create.command ? { command: plan.create.command } : {}),
                })
              : ports.createTerminal({
                    workspaceId: plan.create.workspaceId,
                    ...(plan.create.cwd ? { cwd: plan.create.cwd } : {}),
                });

    // No window on failure, and the error travels unchanged — it is the only thing that
    // explains what went wrong, and paraphrasing it loses the fix.
    if (!created.ok) return { ok: false, reason: 'create-failed', error: created.error };

    const ws = ports.workspaceName(req.workspaceId);
    // `existing` says "agent" rather than naming one: this layer has the spec id, not the
    // roster, and inventing a name for a title bar is the kind of small guess that later
    // reads as a fact.
    const subject = req.kind === 'agent' ? req.agent : req.kind === 'existing' ? 'agent' : 'terminal';
    ports.openWindow(
        plan.routeFor(created.specId, {
            ...(created.cwd ? { cwd: created.cwd } : {}),
            workspaceId: req.workspaceId,
        }),
        ['Genie', subject, ws].filter(Boolean).join(' · '),
    );

    return { ok: true, specId: created.specId };
}
