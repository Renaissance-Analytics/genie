import type { AgentType } from '../mcp/protocol';

/**
 * What a "new terminal window" opens — Tynn #447.
 *
 * Owner direction (2026-10-05): every workspace can open a terminal, or start an agent in
 * TUI mode, and it opens as its OWN WINDOW so TheFloor stays clean under the Genie 2 UX.
 * This is the other half of "demote the terminal, don't delete it" — Session view is the
 * default, and a window is where the pty goes when you deliberately want one.
 *
 * ## The trap this module exists to close
 *
 * `showTerminalWindow()` (`background.ts:802`) already opens a standalone window, and its
 * own docstring anticipated this: *"used by the tray menu's 'New terminal' entry and
 * (later) by the workspace UI."* But the page it loads renders `<Terminal cwd={home} />` —
 * a bare pty with **no `terminal_specs` row**, rooted at `$HOME`.
 *
 * A terminal with no spec has no identity, and therefore none of:
 * `GENIE_TERMINAL_ID`, the per-terminal MCP token (`registerTerminalEndpoint`), AgentInbox
 * identity (`AgentInboxJoinInput.terminalId` is required), a roster entry, agent-cap
 * accounting, revival, or triage. It can host a shell. It can never host an agent.
 *
 * So this is a DECISION module, kept pure and tested, that says: a terminal window is
 * spec-backed or it does not open. The Electron wiring reads the plan; it does not decide.
 */

export type TerminalWindowRequest =
    | { kind: 'terminal'; workspaceId: string; cwd?: string }
    | { kind: 'agent'; workspaceId: string; agent: AgentType; command?: string }
    /**
     * A window onto a spec that ALREADY EXISTS — taking over a running agent.
     *
     * Its own kind rather than a flag on `agent`, because the difference is whether a pty is
     * created, and that is the difference between reaching the agent you meant and starting a
     * second one beside it. The two other kinds create; this one never does.
     */
    | { kind: 'existing'; workspaceId: string; specId: string; cwd?: string };

/** What the caller must create — mapped 1:1 onto the EXISTING spec builders, so no
 *  parallel implementation of identity exists. */
export type SpecCreate =
    | { kind: 'terminal'; workspaceId: string; cwd?: string }
    | { kind: 'agent'; workspaceId: string; agent: AgentType; command?: string };

export type TerminalWindowPlan =
    | {
          ok: true;
          /** What to create, or `null` when the spec already exists and must not be remade. */
          create: SpecCreate | null;
          /**
           * The window's query, once the spec exists. Takes the id as an argument because
           * the id does not exist until creation has happened.
           *
           * `cwd` and `ws` ride along because the window has to ATTACH to the spec's pty,
           * and the renderer would otherwise need a round trip to learn where it lives.
           * The spec id is what makes it attach; these two only save the lookup.
           */
          routeFor: (specId: string, ctx?: { cwd?: string; workspaceId?: string }) => string;
      }
    | { ok: false; reason: 'no-workspace' };

export function planTerminalWindow(req: TerminalWindowRequest): TerminalWindowPlan {
    // No workspace, no window. The diagnostic page falls back to $HOME; that fallback is
    // precisely why it cannot be the product surface — a terminal that belongs to nothing
    // cannot be revived, counted, or addressed by an agent.
    if (!req.workspaceId) return { ok: false, reason: 'no-workspace' };

    const create: SpecCreate | null =
        req.kind === 'existing'
            ? // NOTHING is created. The spec is the one already carrying the agent's pty,
              // its identity and its conversation; making another would start a second
              // agent beside the one you asked to reach.
              null
            : req.kind === 'agent'
              ? {
                    kind: 'agent',
                    workspaceId: req.workspaceId,
                    agent: req.agent,
                    command: req.command,
                }
              : { kind: 'terminal', workspaceId: req.workspaceId, cwd: req.cwd };

    return {
        ok: true,
        create,
        // The spec id, not the workspace. If the route carried only a workspace the
        // renderer would create its own terminal — two ptys for one window, and the agent
        // in whichever one the race favoured.
        routeFor: (specId: string, ctx?: { cwd?: string; workspaceId?: string }) => {
            const q = [`spec=${encodeURIComponent(specId)}`];
            // Encoded, because a Windows cwd carries backslashes and spaces.
            if (ctx?.cwd) q.push(`cwd=${encodeURIComponent(ctx.cwd)}`);
            if (ctx?.workspaceId) q.push(`ws=${encodeURIComponent(ctx.workspaceId)}`);
            return `?${q.join('&')}`;
        },
    };
}

export type ClosePolicy = 'detach' | 'kill';

/**
 * What closing the window does.
 *
 * An agent DETACHES: the pty stays live so take-over remains instant, and closing a view
 * must never end work that is in flight. A plain shell has nothing to outlive its window,
 * so it is killed rather than left as an invisible orphan — the class of leak that burned
 * 18.4 CPU-hours over nine days when nothing reaped what an agent spawned.
 */
export function closePolicyFor(kind: TerminalWindowRequest['kind']): ClosePolicy {
    // `existing` detaches for the same reason `agent` does, and more strongly: it is by
    // definition a pty with work already in it, so killing it on close would end the very
    // session the window was opened to reach.
    return kind === 'agent' || kind === 'existing' ? 'detach' : 'kill';
}
