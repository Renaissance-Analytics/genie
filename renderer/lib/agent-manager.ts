/* A ZERO-RUNTIME-IMPORT leaf — see `__tests__/renderer-main-boundary.test.ts`.
   The mode's LABEL comes from the module that words what the agent is told, so
   what a human sees on the tab and what the agent is handed cannot drift. */
import { agentModeBadge, DEFAULT_AGENT_MODE } from '../../main/agents/agent-mode';
/* The SAME decision the host makes when an agent calls `runAgent switchTui`
   (`main/mcp/host-tools.ts`) and when a human presses Switch (`agentRecordAddRuntime`).
   Shared rather than copied for the reason `flows/refusals.ts` is shared with the
   flow palette: a second copy of a rule is how two disagreeing versions ship, and
   the visible symptom here would be a button whose only outcome is the host's
   error message. Both modules are leaves, so importing them costs the renderer
   nothing. */
import { decideTuiSwitch, type SwitchRuntime } from '../../main/agents/tui-switch';
import type {
    AgentManagerMcp,
    AgentMode,
    AgentManagerPersona,
    AgentManagerSidecar,
    AgentManagerState,
    AgentMcpServer,
    SidecarAction,
} from './genie';

/**
 * The agent manager's judgement calls, kept out of the component.
 *
 * Tynn #709 / story #263. The renderer has no DOM harness, so — as everywhere
 * else in `renderer/lib` — the decisions live here and `AgentManager.tsx` only
 * draws what these return. That is what makes "the MCP list shows N servers"
 * and "removing genie is refused" checkable at all, rather than assertions
 * nobody can write.
 */

export type AgentManagerTabId = 'identity' | 'driver' | 'prompt' | 'mcp' | 'sidecar';

export interface AgentManagerTab {
    id: AgentManagerTabId;
    label: string;
    /** A count worth seeing without opening the tab. */
    badge?: string;
}

/**
 * The tabs this agent gets.
 *
 * The surface the owner opened had ONE of these — identity — which is the whole
 * complaint. The sidecar tab is dropped for an agent that IS a sidecar: a
 * sidecar has no sidecar, and a control that acts on nothing is worse than an
 * absent one because it looks like it did something.
 */
export function agentManagerTabs(state: AgentManagerState): AgentManagerTab[] {
    if (!state.ok || !state.agent) return [];
    const tabs: AgentManagerTab[] = [
        { id: 'identity', label: 'Identity' },
        // WHAT THIS AGENT RUNS UNDER, and whether it is up (genie#463, #474).
        // `switchTui` and `stop` were both agent-only verbs: an agent could
        // change its own driver and end its own run, and a human could do
        // neither — the only thing the UI offered in the other direction was
        // Delete.
        { id: 'driver', label: 'Driver' },
        {
            id: 'prompt',
            label: 'Prompt & rules',
            // WHICH agents act unprompted is the one thing about this tab
            // worth seeing without opening it (genie#408). The label comes from
            // `agent-mode.ts`, which also decides that only the EXCEPTION is
            // badged — Manual is the default and nearly every agent.
            badge: agentModeBadge(state.persona?.mode ?? DEFAULT_AGENT_MODE) ?? undefined,
        },
        {
            id: 'mcp',
            label: 'MCP',
            badge: state.mcp ? String(state.mcp.servers.length) : undefined,
        },
    ];
    if (!state.agent.isSidecar) tabs.push({ id: 'sidecar', label: 'Sidecar' });
    return tabs;
}

/* ── Driver ───────────────────────────────────────────────────────────────── */

/** One provider, and what this agent can do with it. */
export interface DriverRow {
    tui: string;
    label: string;
    /**
     * `active` — the visible driver. `sidecar` — held, parked, its conversation
     * waiting. `unused` — never run under this one.
     */
    state: 'active' | 'sidecar' | 'unused';
    /**
     * The ONE action this row offers, or null when there is nothing to press.
     *
     * `front` and `create` are the same gesture to a human — Switch — and the
     * row's `state` is what says whether a conversation is waiting on the other
     * side. Making them two controls would be making the human learn the
     * difference between flipping to a sidecar and adding a driver, which is a
     * distinction the host already makes for them.
     */
    action: { kind: 'front' | 'create'; label: string } | null;
    /** Why there is no action — the HOST's own refusal, verbatim. */
    refusal: string | null;
}

/**
 * The driver rows for one agent.
 *
 * Built from `decideTuiSwitch`, which is the rule the host applies to the
 * agent's own `runAgent switchTui`. So the surface cannot offer a switch that
 * would come straight back as an error, and cannot silently permit one the agent
 * itself is refused — the asymmetry genie#463 is about runs in both directions.
 */
export function driverRows(input: {
    drivers: readonly { tui: string; label: string }[];
    runtimes: readonly SwitchRuntime[];
    /** `tuis:` from the agent's AGENT.md. EMPTY is "no opinion", not "none". */
    allowed: readonly string[];
    /**
     * The agent's EFFECTIVE driver — `workspace_agents.tui`, which is what the
     * host falls back to when no runtime is fronted (`effectiveTui`).
     *
     * A registered agent that has never been started has no `agent_runtimes`
     * row at all, so without this the panel said "its driver is Claude Code"
     * and offered to switch it to Claude Code one line below.
     */
    current?: string | null;
}): DriverRow[] {
    const fronted = input.runtimes.find((r) => r.fronted);
    return input.drivers.map(({ tui, label }) => {
        const held = input.runtimes.find((r) => r.tui === tui);
        // A fronted runtime always wins: the record's `tui` is the fallback, not
        // the truth.
        const isCurrent = fronted ? held?.fronted === true : !held && input.current === tui;
        const state: DriverRow['state'] = held
            ? held.fronted
                ? 'active'
                : 'sidecar'
            : isCurrent
              ? 'active'
              : 'unused';
        const decision = decideTuiSwitch({ runtimes: input.runtimes, to: tui, allowed: input.allowed });
        if (decision.kind === 'refuse') {
            return { tui, label, state, action: null, refusal: decision.reason };
        }
        // `already` is the driver in the chair. Offering "Switch to Claude Code"
        // there is a button whose success changes nothing — and the same is true
        // of the record's own driver before anything has started.
        if (decision.kind === 'already' || isCurrent) {
            return { tui, label, state, action: null, refusal: null };
        }
        return {
            tui,
            label,
            state,
            action: { kind: decision.kind, label: `Switch to ${label}` },
            refusal: null,
        };
    });
}

/** One line saying what this agent is driven by, and whether it is up. */
export function driverSummary(
    agent: { name: string; tui: string | null; running: boolean },
    drivers: readonly { tui: string; label: string }[],
): string {
    const label = drivers.find((d) => d.tui === agent.tui)?.label ?? agent.tui;
    if (!label) return `${agent.name} is not running, and has no driver yet.`;
    return agent.running
        ? `${agent.name} is running under ${label}.`
        : `${agent.name} is not running. Its driver is ${label}.`;
}

/**
 * The agent's RUN control — genie#474.
 *
 * The renderer had no stop-an-agent path at all, so a roster that showed an
 * agent running offered exactly one control for the other direction: Delete.
 * The note is not decoration — it is the sentence that distinguishes the two
 * verbs at the point where somebody is about to press one.
 */
export interface AgentRunControl {
    action: 'stop' | 'start';
    label: string;
    note: string;
}

export function agentRunControl(agent: { name: string; running: boolean }): AgentRunControl {
    return agent.running
        ? {
              action: 'stop',
              label: `Stop ${agent.name}`,
              note: 'Ends this agent’s run and its sidecars’. It keeps its identity, its AGENT.md, its inbox and its history — starting it again is the same agent, not a new one.',
          }
        : {
              action: 'start',
              label: `Start ${agent.name}`,
              note: 'Brings this agent back. It reattaches rather than creating a second one.',
          };
}

export interface McpDriftNotice {
    tone: 'warn' | 'info' | 'none';
    text: string;
    canRestart: boolean;
}

/**
 * What to say about the gap between the config on disk and the session running.
 *
 * All three TUIs read their MCP servers ONCE, at session start. Nothing anywhere
 * said so, and an afternoon went into an agent that looked healthy and was
 * toolless because a `.mcp.json` edit never reached it.
 *
 * `stale` is a proof (`main/agents/agent-mcp.ts` explains the arithmetic) and is
 * stated as one. `unproven` is NOT turned into "up to date": the data cannot
 * support that, and a false all-clear is the failure mode this surface exists to
 * remove, not one to add.
 */
export function mcpDriftNotice(mcp: AgentManagerMcp): McpDriftNotice {
    if (mcp.drift === 'stale') {
        return {
            tone: 'warn',
            text: `This agent has been running since before ${mcp.configPath} last changed, so it is still using the servers it loaded at start. Restart it to pick these up.`,
            canRestart: true,
        };
    }
    if (mcp.drift === 'unproven') {
        return {
            tone: 'info',
            text: `MCP servers are loaded once, at session start. If you change this list while the agent is running, restart it before expecting the change to reach it.`,
            canRestart: true,
        };
    }
    return { tone: 'none', text: '', canRestart: false };
}

export interface McpRowAction {
    canRemove: boolean;
    /** Why not, for the control's title — never a silent disable. */
    reason: string | null;
}

/**
 * Whether this row's Remove control does anything, and why not when it does not.
 *
 * `genie` (and its AgentInbox channel, which main marks the same way) is the one
 * hard refusal in this surface. It is a refusal rather than a warning because
 * the consequence is invisible: the agent still starts, still draws a square,
 * still looks healthy, and can no longer report that it finished or ask the
 * human anything.
 */
export function mcpRowAction(server: AgentMcpServer, editable: boolean): McpRowAction {
    if (!editable) {
        return {
            canRemove: false,
            reason: `Genie reads this file but does not rewrite it. Edit ${server.source === 'codex' ? '.codex/config.toml' : 'the config file'} directly to change this.`,
        };
    }
    if (server.required) {
        return {
            canRemove: false,
            reason: `The genie server is how this agent tells you it has finished, asks you a question, and reaches every host tool. Without it the agent still starts and still looks healthy — it just cannot reach you.`,
        };
    }
    return { canRemove: true, reason: null };
}

/** Why a managed server is worth a note even though it can be removed. */
export function mcpManagedNote(server: AgentMcpServer): string | null {
    return server.managed && !server.required
        ? 'Genie writes this entry, so removing it comes back on the next workspace sync.'
        : null;
}

/** The editable half of an `AGENT.md`, as the form holds it. */
export interface PersonaDraft {
    purpose: string;
    /** '' means the whole workspace — the file omits the key entirely. */
    scope: string;
    tuis: string[];
    /** Automated or Manual (genie#408). Never blank: an undeclared file reads
     *  as Manual, and a control showing "unset" would ask the human to reason
     *  about a default instead of telling them how their agent is spoken to. */
    mode: AgentMode;
    body: string;
}

/** The draft an `AGENT.md` opens with. */
export function personaDraftFrom(persona: AgentManagerPersona): PersonaDraft {
    return {
        purpose: persona.purpose,
        scope: persona.scope ?? '',
        tuis: persona.tuis,
        mode: persona.mode,
        body: persona.body,
    };
}

/**
 * Whether Save should be enabled.
 *
 * Driver ORDER is not an edit — `tuis` is a set here, and the array is rebuilt
 * on every render, so comparing it positionally would leave Save permanently
 * lit, which is the same as no signal at all. An empty `scope`, on the other
 * hand, IS an edit against a set one: it clears the agent back to the whole
 * workspace.
 */
export function personaIsDirty(loaded: AgentManagerPersona, draft: PersonaDraft): boolean {
    if (draft.purpose !== loaded.purpose) return true;
    if (draft.scope !== (loaded.scope ?? '')) return true;
    if (draft.mode !== loaded.mode) return true;
    if (draft.body !== loaded.body) return true;
    const a = [...draft.tuis].sort();
    const b = [...loaded.tuis].sort();
    return a.length !== b.length || a.some((tui, i) => tui !== b[i]);
}

/** The edit to send, with `undefined` for everything untouched so a save can
 *  never reset a field the human did not open. */
export function personaEditFrom(
    loaded: AgentManagerPersona,
    draft: PersonaDraft,
): { purpose?: string; scope?: string | null; tuis?: string[]; mode?: AgentMode; body?: string } {
    const edit: {
        purpose?: string;
        scope?: string | null;
        tuis?: string[];
        mode?: AgentMode;
        body?: string;
    } = {};
    if (draft.purpose !== loaded.purpose) edit.purpose = draft.purpose;
    if (draft.scope !== (loaded.scope ?? '')) edit.scope = draft.scope.trim() || null;
    // Sent only when it CHANGED, so an agent whose file has never carried the
    // key keeps it that way and an empty save stays a genuine no-op.
    if (draft.mode !== loaded.mode) edit.mode = draft.mode;
    // Sent only when it CHANGED, so an agent whose file has never carried the
    // key keeps it that way and an empty save stays a genuine no-op.
    if (draft.body !== loaded.body) edit.body = draft.body;
    const a = [...draft.tuis].sort();
    const b = [...loaded.tuis].sort();
    if (a.length !== b.length || a.some((tui, i) => tui !== b[i])) edit.tuis = draft.tuis;
    return edit;
}

/**
 * One line saying what the sidecar is and whether it is up.
 *
 * The empty case used to read *"switching drivers creates one"*, and that is not
 * true of THIS sidecar. Two different things carry the word — genie#463 reads
 * them as one, which is the easiest mistake in this area to make:
 *
 *   - a parked TUI RUNTIME of this agent — what `switchTui` creates, and what
 *     the Driver tab manages;
 *   - a separate AGENT named `<name>-slave` — what this tab manages, and what
 *     NOTHING in Genie creates. `agents/sidecar.ts` says so outright: the
 *     convention was *"already in use by hand before it was expressed in code"*.
 *
 * So the old sentence sent a person to a control that would never produce what
 * they had just been promised. It names the shape instead, which is the only
 * thing that distinguishes the two.
 */
export function sidecarSummary(sidecar: AgentManagerSidecar): string {
    if (!sidecar.exists || !sidecar.name) {
        return 'This agent has no sidecar. A sidecar is a SECOND AGENT named <name>-slave that works the same ground under its own driver — registered by hand, not by switching drivers. (For a second driver on THIS agent, see the Driver tab.)';
    }
    return sidecar.running
        ? `${sidecar.name} is running.`
        : `${sidecar.name} is registered and not running.`;
}

/**
 * The BUTTON for a sidecar action, and the line shown when it lands.
 *
 * These were derived from the action id — `Restart sidecar`, and
 * `` `${action[0].toUpperCase()}${action.slice(1)}ed` `` for the confirmation.
 * That is fine for three one-word verbs and produces "Restart-fresheed" for the
 * fourth (genie#443), so the words are written out. A restart is also the one
 * action here that does not simply happen: the host tears the old TUI down and
 * hands a command to a fresh terminal, and everything after that is inside the
 * pty, so the line says "relaunching" rather than a recovery nobody watched
 * (genie#364).
 */
export function sidecarActionLabel(action: SidecarAction): string {
    switch (action) {
        case 'start':
            return 'Start sidecar';
        case 'stop':
            return 'Stop sidecar';
        case 'restart':
            return 'Restart sidecar (resume)';
        case 'restart-fresh':
            return 'Restart sidecar (fresh)';
    }
}

export function sidecarDoneMessage(action: SidecarAction, name: string | null): string {
    const who = name ?? 'the sidecar';
    switch (action) {
        case 'start':
            return `Started ${who}.`;
        case 'stop':
            return `Stopped ${who}.`;
        case 'restart':
            return `Relaunching ${who} — it resumes the same conversation.`;
        case 'restart-fresh':
            return `Relaunching ${who} from scratch — it starts a new conversation.`;
    }
}

/** How this sidecar was matched, spelled out — the FK and the name convention
 *  mean different things, and #708 turns one into the other. */
export function sidecarMatchNote(sidecar: AgentManagerSidecar): string | null {
    if (!sidecar.exists) return null;
    return sidecar.matchedBy === 'parent'
        ? 'Matched by its parent link, so a rename cannot lose it.'
        : 'Matched by the -slave name convention — it carries no parent link yet.';
}
