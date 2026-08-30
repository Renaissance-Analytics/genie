import crypto from 'crypto';
import {
    canAccessMessageAttachment,
    normalizePurpose,
    previewText,
    AGENTINBOX_HUMAN,
    type AgentInboxAgentInfo,
    type AgentInboxAttachment,
    type AgentInboxBrokerEvent,
    type AgentInboxDmThreadInfo,
    type AgentInboxEscalation,
    type AgentInboxJoinInput,
    type AgentInboxMessage,
    type AgentInboxScope,
    type AgentInboxNotifyTarget,
    type WorkspaceAccessPolicy,
} from './types';
import { agentRef } from '../agents/identity';
import { noopAgentInboxStore, type AgentInboxStore, type StoredAttachment } from './store';
import {
    nudgeWarranted,
    shouldWakeAgent,
    wakeNudgeText,
    NUDGE_UNCHECKED_MS,
} from './wake';
import { containsHumanInput, inboxNoticeText } from './notify';
import { EMPTY_DRAFT, noteDraft, planNudge, type Draft, type NudgePlan } from './draft';

/**
 * AgentInbox broker — the in-memory registry + channels + inboxes powering the
 * local inter-agent messaging network. PURE: no electron, no db, no fs. All
 * durable identity (agent_id, purpose, scope, workspaces, chat_session_id) rides
 * `terminal_specs.meta`; the caller resolves that (+ workspace slug/name) and
 * hands the broker plain {@link AgentInboxJoinInput}s, and rehydrates them at boot.
 *
 * Delivery is PULL-based: `send` appends to each recipient's capped inbox (and a
 * capped per-channel / per-DM LOG for the human panel's history), and `receive`
 * pages an agent's inbox by cursor — optionally LONG-POLLING (one live waiter per
 * agent) until a message arrives, the agent leaves, or a timeout. The broker
 * NEVER writes into a pty; an `interrupt` DM is the only nudge, surfaced as a
 * terminal-attention event the caller maps to the glow.
 *
 * Presence + message events flow out through an injected emitter (presence.ts
 * wires the real local-broadcast + mobile push); a test passes a spy.
 */

/** Per-agent inbox cap — oldest messages age out (in-memory, reset on restart). */
export const INBOX_CAP = 200;
/** Per-channel / per-DM-pair history log cap (for the human panel). */
export const LOG_CAP = 500;
/** Default long-poll window. The real ceiling is the MCP CLIENT's idle timeout
 *  (~5min for HTTP transports); the SSE heartbeat + `notifications/progress` in
 *  server.ts keep the socket alive up to it. We sit just under that so a waiting
 *  agent BLOCKS IN ONE CALL instead of re-polling — a 55s default made agents
 *  look like they were polling in a loop when the mechanism is push-on-delivery.
 *  Raise toward MAX_WAIT_MS only once a client is confirmed to honour progress
 *  as an idle-timeout reset (claude-code#58687 says it may not). */
export const DEFAULT_WAIT_MS = 240_000;
/** Hard cap on a requested long-poll window. */
export const MAX_WAIT_MS = 600_000;
/** How long an urgent (`interrupt`) DM may sit unACKed before it escalates to the
 *  human oversight surface (Track C). ACK = the target's cursor passing the DM. */
export const ESCALATION_MS = 5 * 60_000;

/** A tracked urgent DM awaiting ACK (Track C). */
interface PendingEscalation {
    targetAgentId: string;
    seq: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** Whether the escalation event has already fired to the human. */
    fired: boolean;
    payload: AgentInboxEscalation;
}

interface Waiter {
    resolve: (msgs: AgentInboxMessage[]) => void;
    cursor: number;
    timer: ReturnType<typeof setTimeout> | null;
}

// `reachable` is a per-CALLER verdict computed at read time, never agent state —
// so the stored record deliberately omits it. `ref` is omitted for the same
// reason from the other direction: it is DERIVED from agentType + purpose +
// chatSessionId, all of which change in place (a rename, and Codex's late
// session bind), so a stored copy would be a second truth that goes stale the
// moment either one moves.
interface AgentInboxAgent extends Omit<AgentInboxAgentInfo, 'reachable' | 'ref'> {
    /** Queued messages awaiting `receive` (capped). */
    inbox: AgentInboxMessage[];
    /** The single live long-poll resolver, or null. */
    waiter: Waiter | null;
    /** Highest seq this agent has received (its ACK position). Persisted to the
     *  store so restart-survival + unACKed-urgent escalation (Track C) work. */
    cursor: number;
    /** Opt-in wake-on-DM (issue #9): a DM to an IDLE agent may inject a nudge to
     *  start a turn. Default OFF — a persisted preference (spec meta).
     *  @deprecated Reachability is protocol, not preference — see ./wake. Kept
     *  only because it is persisted in spec meta; nothing reads it to decide.
     */
    wakeOnDm: boolean;
    /** The armed 5-minute unchecked-inbox deadline, or null. Not a poll: one
     *  timer per agent, armed on a delivery the harness did not take and
     *  cleared the moment the agent's cursor moves. */
    nudgeTimer: ReturnType<typeof setTimeout> | null;
    /** Epoch ms the agent's last turn ended (imDone), or null. Wake-on-DM idle signal. */
    lastTurnEndAt: number | null;
    /** Epoch ms of the agent terminal's last output byte, or null. Wake-on-DM idle signal. */
    lastOutputAt: number | null;
    /** Epoch ms we last woke this agent, or null. One wake per idle period. */
    lastWokenAt: number | null;
    /** What Genie believes is in this terminal's input box, and whether it is
     *  sure enough to cut the draft out and put it back. See ./draft. */
    draft: Draft;
    /** Epoch ms of the last HUMAN keystroke at this terminal, or null. */
    lastUserInputAt: number | null;
}

/**
 * One nudge, ready for the host to put into a terminal. The broker decides WHAT
 * to say and HOW it may land given the state of the human's input box; the host
 * does the pty writes, the keyboard hold and the toast.
 */
export interface NudgeDelivery {
    terminalId: string;
    /** Exact bytes this terminal last emitted for a real submitting Enter. */
    submitBytes: string;
    /** The notice itself. */
    text: string;
    /** How it may be delivered — see {@link planNudge}. */
    plan: NudgePlan;
}

export interface PendingNudgeChange {
    terminalId: string;
    pending: boolean;
}

/** Normalise a DM pair into a stable, order-independent log key. */
function pairKey(a: string, b: string): string {
    return [a, b].sort().join('|');
}

/** The outcome of {@link AgentInboxBroker.send}. */
export type AgentInboxSendResult =
    | {
          ok: true;
          delivered: number;
          message: AgentInboxMessage;
      }
    | {
          ok: false;
          error: string;
          delivered?: number;
      };

export class AgentInboxBroker {
    private agents = new Map<string, AgentInboxAgent>();
    private byTerminal = new Map<string, string>(); // terminalId → agentId
    private dmLogs = new Map<string, AgentInboxMessage[]>();
    private seq = 0;
    private emit: (ev: AgentInboxBrokerEvent) => void = () => {};
    /** Durability backstop (genie.db in production, no-op for tests). */
    private store: AgentInboxStore = noopAgentInboxStore;
    /** Urgent DMs awaiting ACK, keyed by messageId (Track C). */
    private escalations = new Map<string, PendingEscalation>();
    /** Escalation delay — overridable in tests so they don't wait 5 minutes. */
    private escalationMs = ESCALATION_MS;

    /** Wire the outbound event sink (presence.ts installs the real one at boot). */
    setEmitter(fn: (ev: AgentInboxBrokerEvent) => void): void {
        this.emit = fn;
    }

    /** Wire the durable store (background.ts installs the genie.db one at boot). */
    setStore(store: AgentInboxStore): void {
        this.store = store;
    }

    /** Deliver a nudge to a terminal. Injected by the host at boot (it writes to
     *  the pty, holds the keyboard for the duration, and raises the toast);
     *  absent in tests → delivery is a no-op. Kept a seam so the broker stays
     *  electron-free.
     *
     *  Returns false when the host could NOT deliver — most often because a swap
     *  is already in flight on that terminal — so the caller can fall back. */
    private wakeSink: ((d: NudgeDelivery) => boolean | void) | null = null;
    private pendingNudges = new Map<string, { text: string }>();
    private pendingNudgeSink: ((d: PendingNudgeChange) => void) | null = null;
    /** Clock — injectable so wake-on-DM idle timing is deterministically testable. */
    private now: () => number = () => Date.now();

    setWakeSink(fn: (d: NudgeDelivery) => boolean | void): void {
        this.wakeSink = fn;
    }

    setPendingNudgeSink(fn: (d: PendingNudgeChange) => void): void {
        this.pendingNudgeSink = fn;
    }

    sendPendingNudge(terminalId: string): { ok: boolean; reason?: 'none' | 'input-not-empty' | 'delivery-failed' } {
        const pending = this.pendingNudges.get(terminalId);
        const target = this.agentForTerminal(terminalId);
        if (!pending || !target || !this.wakeSink) return { ok: false, reason: 'none' };
        if (planNudge(target.draft).mode !== 'submit') {
            return { ok: false, reason: 'input-not-empty' };
        }
        try {
            if (this.wakeSink({ terminalId, submitBytes: target.draft.submitBytes, text: pending.text, plan: { mode: 'submit' } }) === false) {
                return { ok: false, reason: 'delivery-failed' };
            }
        } catch {
            return { ok: false, reason: 'delivery-failed' };
        }
        this.pendingNudges.delete(terminalId);
        target.lastWokenAt = this.now();
        this.pendingNudgeSink?.({ terminalId, pending: false });
        return { ok: true };
    }

    /**
     * Server-push sink — fired on LIVE delivery of a message to an agent so the
     * host can push an MCP `notifications/message` down that agent's GET SSE
     * stream (background.ts wires it to server.ts's pushToTerminal/pushToWorkspace).
     * This is the SSE half of "the inbox delivers over a hooked connection": an
     * actively-connected, waiting agent learns a message landed without holding a
     * blocking `receive`. Absent in tests. Deliberately NOT fired on rehydrate
     * replay — a boot must not re-announce historical messages. Best-effort: a
     * sink failure never breaks delivery.
     */
    private notifySink: ((target: AgentInboxNotifyTarget, msg: AgentInboxMessage) => void) | null =
        null;
    /** Harness-native agent delivery (Claude Channel / Codex App Server).
     * This is deliberately separate from wakeSink: AgentInbox never owns PTY input. */
    private transportSink: ((target: AgentInboxNotifyTarget, msg: AgentInboxMessage) => boolean | Promise<boolean> | void) | null = null;

    setTransportSink(
        fn: (target: AgentInboxNotifyTarget, msg: AgentInboxMessage) => boolean | Promise<boolean> | void,
    ): void {
        this.transportSink = fn;
    }

    setNotifySink(fn: (target: AgentInboxNotifyTarget, msg: AgentInboxMessage) => void): void {
        this.notifySink = fn;
    }

    private notifyDelivery(agent: AgentInboxAgent, msg: AgentInboxMessage): void {
        if (!this.notifySink) return;
        try {
            this.notifySink(
                {
                    workspaceId: agent.workspaceId,
                    terminalId: agent.terminalId,
                    agentId: agent.agentId,
                },
                msg,
            );
        } catch {
            /* best-effort — a push failure must never break the durable inbox */
        }
    }

    /** Resolve a workspace's access policy (the OUTER tier). Injected by the host
     *  at boot from the `workspaces` table; absent in tests / before wiring it
     *  defaults PERMISSIVE (`all`), which is exactly the pre-feature behaviour —
     *  channels were ungoverned — so nothing silently tightens on upgrade. */
    private workspaceAccess: ((workspaceId: string) => WorkspaceAccessPolicy) | null = null;

    setWorkspaceAccessResolver(fn: (workspaceId: string) => WorkspaceAccessPolicy): void {
        this.workspaceAccess = fn;
    }

    /** Test seam for the wake-on-DM clock. */
    setClock(now: () => number): void {
        this.now = now;
    }

    /** Record that an agent's TURN ENDED (its terminal called imDone) — the
     *  wake-on-DM idle signal. No-op for a terminal with no agent. */
    markTurnEnd(terminalId: string): void {
        const a = this.agentForTerminal(terminalId);
        if (!a) return;
        a.lastTurnEndAt = this.now();
        // The agent just became idle, which is the OTHER half of the nudge
        // decision. A deadline that expired while it was mid-turn found it
        // unsafe to inject and correctly did nothing; without this the mail
        // would then sit unread forever, because nothing else would ask again.
        this.scheduleNudge(a);
    }

    /** Record that an agent terminal produced OUTPUT — any output SINCE a turn end
     *  means a new turn (or a human typing) started, which fail-closes wake-on-DM.
     *  Called from the terminal output choke point; cheap (a timestamp write). */
    noteOutput(terminalId: string): void {
        const a = this.agentForTerminal(terminalId);
        if (a) a.lastOutputAt = this.now();
    }

    /**
     * Record HUMAN keystrokes at an agent terminal — the guard for immediate
     * inbox notices ({@link notifyNow}). Called from the `terminal:write` IPC
     * (a renderer sending what a person typed), NOT from Genie's own injection
     * path, so the draft state reflects the person and never our own bytes.
     * No-op for a terminal with no agent.
     *
     * That IPC is not keystrokes ALONE, though: xterm answers the TUI's queries
     * down the same channel, and Genie writes its OSC 52 clipboard response back
     * through it. Stamping `lastUserInputAt` for those made a polling TUI look
     * like a person typing forever, so the timestamp now moves only for input a
     * human actually produced.
     */
    noteUserInput(terminalId: string, data: string): void {
        const a = this.agentForTerminal(terminalId);
        if (!a) return;
        a.draft = noteDraft(a.draft, data);
        if (containsHumanInput(data)) a.lastUserInputAt = this.now();
    }

    /** Whether a terminal is a registered agent (drives the mid-turn AgentPulse glow). */
    isAgentTerminal(terminalId: string): boolean {
        return this.byTerminal.has(terminalId);
    }

    /**
     * The agent's internal hooks are NOT engaged — it is running in a terminal
     * but not attached to Genie's services, so the durable message would sit
     * unread with the sender seeing nothing but a stale read-receipt.
     *
     * Two things, deliberately rate-limited differently:
     *
     *  - the ANNOUNCEMENT, immediately. It is the only thing that tells this
     *    agent something arrived.
     *  - the WAKE, as a backstop, if it was told and STILL has not looked. That
     *    one waits out {@link nudgeWarranted}, and the one-wake-per-idle-period
     *    gate stops it landing a second prompt on top of the announcement it
     *    just made.
     */
    private notAttached(agent: AgentInboxAgent, msg: AgentInboxMessage): void {
        this.notifyNow(agent, msg);
        this.scheduleNudge(agent);
    }

    /**
     * Announce a just-delivered message in the agent's own chat, IMMEDIATELY —
     * the owner's beta.248 behaviour, now scoped to agents that need it.
     *
     * ONLY reached when the agent's internal hooks are not engaged: the harness
     * declined delivery, threw, or there is no transport at all. An ATTACHED
     * agent already has the message natively, and injecting a notice on top of
     * that would be a second copy of something it is already holding.
     *
     * For an unattached agent this stays immediate on purpose. It is the only
     * thing that tells it something arrived, so delaying it behind the wake's
     * five-minute rule would leave it blind for five minutes. Mid-turn is fine —
     * a TUI queues text, which is how a human interjects — and it carries the
     * urgency so the agent decides whether to break off.
     *
     * What holds it back is the HUMAN's draft, and only as far as it must:
     * {@link planNudge} takes an empty box and submits; cuts out a draft Genie is
     * CERTAIN of, submits, and pastes it back; and when Genie is not certain,
     * appends WITHOUT submitting so nothing of theirs is cut, raising a toast
     * instead. Returns whether the notice actually landed.
     */
    private notifyNow(target: AgentInboxAgent, msg: AgentInboxMessage): boolean {
        if (!this.wakeSink || !target.terminalId) return false;
        const text = inboxNoticeText({
            from: msg.fromLabel,
            priority: msg.interrupt ? 'high' : 'normal',
        });
        const plan = planNudge(target.draft);
        if (plan.mode === 'defer') {
            this.pendingNudges.set(target.terminalId, { text });
            this.pendingNudgeSink?.({ terminalId: target.terminalId, pending: true });
            return true;
        }
        try {
            // The host refuses when a swap is already in flight on this terminal —
            // two notices must never both cut the same box.
            if (
                this.wakeSink({
                    terminalId: target.terminalId,
                    submitBytes: target.draft.submitBytes,
                    text,
                    plan,
                }) === false
            ) {
                return false;
            }
            // Submitting text to an idle TUI IS what starts a turn, so a delivered
            // notice is also a wake: record it, and the one-wake-per-idle-period
            // gate keeps the backstop from firing a second prompt on top of it.
            target.lastWokenAt = this.now();
            return true;
        } catch {
            /* a failed notice still leaves the message in the inbox to be pulled */
            return false;
        }
    }

    /**
     * The PTY-nudge FALLBACK, and when it is allowed to fire.
     *
     * `deliverToHarness` owns live delivery: an agent attached to Genie's
     * services gets its mail natively and its cursor moves, so none of this
     * runs. What this covers is the case the owner named — an agent RUNNING in a
     * terminal but not attached, where the durable message would otherwise sit
     * unread with the sender seeing nothing but a stale read-receipt.
     *
     * Two gates, and both must pass:
     *
     *  - {@link nudgeWarranted} — WHETHER. Unchecked for five minutes after
     *    delivery, or three or more stacked. Delivery on its own is not an
     *    interruption; this is what stopped every DM to an idle agent from
     *    starting a turn on arrival.
     *  - {@link shouldWakeAgent} — WHETHER IT IS SAFE. Unchanged, and still
     *    fail-closed: injecting into an agent that is mid-turn corrupts it.
     *
     * The five-minute rule needs something to happen at five minutes, which a
     * delivery event cannot provide. That is ONE timer per agent, armed here and
     * cleared the moment the cursor moves — a deadline, not a poll.
     */
    private scheduleNudge(target: AgentInboxAgent): void {
        if (!this.wakeSink || !target.terminalId) return;
        const unread = target.inbox.filter((m) => m.seq > target.cursor);
        if (unread.length === 0) {
            this.clearNudge(target);
            return;
        }
        const oldestUnreadAt = unread[0]!.ts;
        if (nudgeWarranted({ unread: unread.length, oldestUnreadAt, now: this.now() })) {
            this.fireNudge(target);
            return;
        }
        // Not yet warranted: come back when the unchecked window is up. Re-arming
        // on every delivery would push the deadline out forever on a busy inbox,
        // so an armed timer is left alone — it is already counting from the
        // OLDEST unread, which is the message that has waited longest.
        if (target.nudgeTimer) return;
        const due = oldestUnreadAt + NUDGE_UNCHECKED_MS - this.now();
        // Evaluate ONCE when it expires and never re-arm from inside itself.
        // A callback that re-schedules whenever the answer is still 'not yet'
        // spins forever against a clock that has not moved -- which is not
        // hypothetical: it is what a fake-timer test does, and `runAllTimers`
        // hung on it. Nothing is lost by stopping, because the two things that
        // can change the answer -- another message, or the agent going idle --
        // both call back in here on their own.
        target.nudgeTimer = setTimeout(() => {
            target.nudgeTimer = null;
            const still = target.inbox.filter((m) => m.seq > target.cursor);
            if (still.length === 0) return;
            if (
                nudgeWarranted({
                    unread: still.length,
                    oldestUnreadAt: still[0]!.ts,
                    now: this.now(),
                })
            ) {
                this.fireNudge(target);
            }
        }, Math.max(0, due));
    }

    /** Drop an armed deadline — the agent read its mail, or has none left. */
    private clearNudge(target: AgentInboxAgent): void {
        if (!target.nudgeTimer) return;
        clearTimeout(target.nudgeTimer);
        target.nudgeTimer = null;
    }

    /** Warranted AND safe: put the nudge in the box. Best-effort by design — a
     *  failed inject leaves the mail queued for the next deadline. */
    private fireNudge(target: AgentInboxAgent): void {
        if (!this.wakeSink || !target.terminalId) return;
        const safe = shouldWakeAgent({
            lastTurnEndAt: target.lastTurnEndAt,
            lastOutputAt: target.lastOutputAt,
            lastUserInputAt: target.lastUserInputAt,
            lastWokenAt: target.lastWokenAt,
            now: this.now(),
        });
        if (!safe) return;
        const unread = target.inbox.filter((m) => m.seq > target.cursor).length;
        target.lastWokenAt = this.now();
        try {
            this.wakeSink({
                terminalId: target.terminalId,
                submitBytes: target.draft.submitBytes,
                text: wakeNudgeText(unread),
                plan: planNudge(target.draft),
            });
        } catch {
            /* a failed nudge just leaves the mail for read-receipts + the next deadline */
        }
    }

    private agentForTerminal(terminalId: string): AgentInboxAgent | null {
        const id = this.byTerminal.get(terminalId);
        return id ? this.agents.get(id) ?? null : null;
    }

    /**
     * Wake-on-DM (issue #9): if `target` opted in AND is PROVABLY idle at its
     * prompt, inject a nudge so a dormant agent actually starts a turn. Fail-safe —
     * {@link shouldWakeAgent} refuses on any output since the last turn ended (a new
     * turn / a human typing), so this can never inject mid-turn. A refused wake is
     * harmless: the sender still sees the DM unseen via `receipts` and can nudge by
     * hand. Best-effort; a failed inject is swallowed.
     */
    private maybeWake(target: AgentInboxAgent): void {
        if (!this.wakeSink || !target.terminalId) return;
        const wake = shouldWakeAgent({
            lastTurnEndAt: target.lastTurnEndAt,
            lastOutputAt: target.lastOutputAt,
            lastUserInputAt: target.lastUserInputAt,
            lastWokenAt: target.lastWokenAt,
            now: this.now(),
        });
        if (!wake) return;
        const unread = target.inbox.filter((m) => m.seq > target.cursor).length;
        target.lastWokenAt = this.now();
        try {
            // Provably idle, so the box is empty: submit it and start the turn.
            this.wakeSink({
                terminalId: target.terminalId,
                submitBytes: target.draft.submitBytes,
                text: wakeNudgeText(unread),
                plan: planNudge(target.draft),
            });
        } catch {
            /* a failed wake just leaves the DM for read-receipts + a manual nudge */
        }
    }

    /**
     * Wake a terminal's agent for a NON-AgentInbox reason (e.g. an IssueWatch ping),
     * reusing the EXACT same fail-safe idle gate + pty injection as wake-on-DM.
     * The caller's OWN opt-in is the gate here (an agent whose `issuewatch_action`
     * is `wake`), so `wakeOnDm` is forced true — but every other safety condition
     * ({@link shouldWakeAgent}: turn ended, quiet window, no output since, one wake
     * per idle period) still applies, so this can never inject mid-turn. Works for
     * any agent terminal, since every agent terminal registers an AgentInbox identity
     * (its idle timestamps are tracked via markTurnEnd/noteOutput). Returns true
     * iff a nudge was actually sent (the agent was provably idle).
     */
    wakeTerminalIfIdle(terminalId: string, text: string): boolean {
        if (!this.wakeSink) return false;
        const a = this.agentForTerminal(terminalId);
        if (!a) return false;
        const wake = shouldWakeAgent({
            lastTurnEndAt: a.lastTurnEndAt,
            lastOutputAt: a.lastOutputAt,
            lastUserInputAt: a.lastUserInputAt,
            lastWokenAt: a.lastWokenAt,
            now: this.now(),
        });
        if (!wake) return false;
        if (planNudge(a.draft).mode !== 'submit') return false;
        a.lastWokenAt = this.now();
        try {
            this.wakeSink({
                terminalId,
                submitBytes: a.draft.submitBytes,
                text,
                plan: planNudge(a.draft),
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Deliver a message FROM the human straight to the agent on `terminalId` — the
     * transport for a DND-deferred ForceTheQuestion answer (the asking agent already
     * returned the deferred notice; this hands its answer back so it isn't lost).
     * Reuses the DM path, so it behaves exactly like the inbox: appended to the store
     * (the agent PULLs it), MCP-stream-notified, and it wakes the terminal if idle
     * (`interrupt`) — ping, poll, pull. Returns false if the terminal has no
     * registered agent identity (nothing to deliver to yet).
     */
    deliverHumanMessageToTerminal(terminalId: string, text: string): boolean {
        const target = this.agentForTerminal(terminalId);
        if (!target) return false;
        const r = this.send({ human: true, toAgentId: target.agentId, text, interrupt: true });
        return r.ok;
    }

    /**
     * Rehydrate the in-memory logs + inboxes from the store at boot — call AFTER
     * {@link rehydrate} (identities) and {@link setStore}. Resumes the global seq
     * (so cursors stay valid), rebuilds the human-panel DM history, and
     * re-queues each known agent's undelivered messages so a message sent while
     * the app was down still lands on the next `receive`.
     */
    rehydrateMessages(limit = 2000): void {
        this.seq = Math.max(this.seq, this.store.maxSeq());
        for (const msg of this.store.loadRecent(limit)) {
            if (msg.kind === 'dm' && msg.to) {
                this.appendLog(this.dmLogs, pairKey(msg.from, msg.to), msg);
            }
        }
        for (const agent of this.agents.values()) {
            agent.cursor = this.store.getCursor(agent.agentId);
            for (const msg of this.store.undeliveredFor(agent.agentId, [], agent.cursor)) {
                this.push(agent, msg);
            }
        }
        // Boot restores a real backlog — the badge must reflect it immediately.
        this.emitLagIfChanged();
    }

    /**
     * AGENT-LAG — how many delivered messages agents have NOT received/ACKed,
     * summed across every registered agent. This is the header badge's signal
     * (genie #64), and it answers a different question from the panel's own
     * unread marks: "are my agents keeping up?", not "what haven't I read?".
     *
     * Normal chatter an agent promptly drains never raises it; an agent falling
     * behind does, because that is the actionable case — the owner only wants to
     * be pulled into the inbox by a problem. An agent that HARD-LEFT drops out
     * (its terminal is gone, there is nothing to chase); an AWAY agent still
     * counts, since it is revivable and its mail is still waiting.
     *
     * The human's own read state is deliberately NOT part of this — it lives
     * client-side (renderer/lib/agentinbox-view.ts) and never touches the host.
     */
    agentLagCount(): number {
        let count = 0;
        for (const a of this.agents.values()) {
            for (const m of a.inbox) if (m.seq > a.cursor) count++;
        }
        return count;
    }

    /** Last lag level pushed. The badge is a LEVEL, so only transitions emit —
     *  re-pushing an unchanged count would make it a message stream again. */
    private lastLagCount = 0;

    private emitLagIfChanged(): void {
        const count = this.agentLagCount();
        if (count === this.lastLagCount) return;
        this.lastLagCount = count;
        this.emit({ type: 'lag', count });
    }

    /** Does the agent have unreceived mail (seq beyond its cursor)? Cheap — no
     *  long-poll. The signal a harness hook checks between turns (Track A). */
    hasMail(agentId: string): boolean {
        const a = this.agents.get(agentId);
        if (!a) return false;
        return a.inbox.some((m) => m.seq > a.cursor);
    }

    /** Unread summary for the agent bound to a TERMINAL — powers the turn-boundary
     *  nudge folded into `imDone` (Track A): surface waiting messages at the exact
     *  point an agent hands back, without ever writing into its pty. Empty when the
     *  terminal isn't an AgentInbox agent or has nothing waiting. */
    unreadForTerminal(terminalId: string): { count: number; fromLabels: string[] } {
        const agentId = this.byTerminal.get(terminalId);
        const a = agentId ? this.agents.get(agentId) : undefined;
        if (!a) return { count: 0, fromLabels: [] };
        const unread = a.inbox.filter((m) => m.seq > a.cursor);
        return { count: unread.length, fromLabels: [...new Set(unread.map((m) => m.fromLabel))] };
    }

    /** Advance + persist an agent's ACK cursor (monotonic), and resolve any urgent
     *  DMs the agent has now received (Track C). */
    private ackCursor(agent: AgentInboxAgent, cursor: number): void {
        if (cursor > agent.cursor) {
            agent.cursor = cursor;
            // It looked. Whatever deadline was counting is moot -- and leaving it
            // armed would nudge an agent that is up to date.
            this.clearNudge(agent);
            this.store.setCursor(agent.agentId, cursor);
            this.resolveEscalations(agent.agentId, cursor);
            // The agent just caught up — the header's agent-lag level dropped.
            this.emitLagIfChanged();
        }
    }

    /** Track an urgent DM: if the target hasn't received it within the escalation
     *  window, surface a "waiting on X" alert to the human (Track C). */
    private registerEscalation(msg: AgentInboxMessage, target: AgentInboxAgent): void {
        const payload: AgentInboxEscalation = {
            messageId: msg.id,
            targetAgentId: target.agentId,
            targetLabel: target.label || `${target.slug}:${target.purpose}`,
            fromLabel: msg.fromLabel,
            preview: previewText(msg.text),
            sinceTs: msg.ts,
        };
        const timer = setTimeout(() => {
            const esc = this.escalations.get(msg.id);
            if (!esc) return; // already acked/cleared
            const a = this.agents.get(esc.targetAgentId);
            if (a && a.cursor >= esc.seq) {
                this.escalations.delete(msg.id); // acked in the meantime
                return;
            }
            esc.fired = true;
            this.emit({ type: 'escalation', escalation: esc.payload });
        }, this.escalationMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
        }
        this.escalations.set(msg.id, {
            targetAgentId: target.agentId,
            seq: msg.seq,
            timer,
            fired: false,
            payload,
        });
    }

    /** Clear (and, if already surfaced, resolve) the urgent DMs an agent has now
     *  received — its cursor passed their seq. */
    private resolveEscalations(agentId: string, cursor: number): void {
        for (const [id, esc] of this.escalations) {
            if (esc.targetAgentId === agentId && esc.seq <= cursor) {
                if (esc.timer) clearTimeout(esc.timer);
                this.escalations.delete(id);
                if (esc.fired) {
                    this.emit({ type: 'escalation-resolved', messageId: id, targetAgentId: agentId });
                }
            }
        }
    }

    /** Test hook — shorten the escalation window so tests don't wait minutes. */
    _setEscalationMs(ms: number): void {
        this.escalationMs = ms;
    }

    /**
     * Public view of an agent. `reachable` defaults true — the human panel owns
     * the workstation and an agent always sees itself in full. Agent-facing
     * directory entries pass the composed verdict, and an UNREACHABLE entry has
     * its `scopeWorkspaces` ACL redacted: a caller the agent excluded has no
     * business reading the allow-list that excluded it.
     */
    private toInfo(a: AgentInboxAgent, reachable = true): AgentInboxAgentInfo {
        return {
            agentId: a.agentId,
            terminalId: a.terminalId,
            workspaceId: a.workspaceId,
            workspaceName: a.workspaceName,
            slug: a.slug,
            agentType: a.agentType,
            label: a.label,
            purpose: a.purpose,
            scope: a.scope,
            scopeWorkspaces: reachable ? [...a.scopeWorkspaces] : [],
            reachable,
            status: a.status,
            chatSessionId: a.chatSessionId,
            // The CANONICAL machine-facing identity (Tynn #254). Composed here,
            // once, from the pieces the record already holds — the alternative is
            // every consumer assembling its own and one of them getting the order
            // or the separator wrong.
            ref: agentRef({
                provider: a.agentType,
                name: a.purpose,
                chatSessionId: a.chatSessionId,
            }),
        };
    }

    private emitPresence(a: AgentInboxAgent): void {
        this.emit({ type: 'presence', agent: this.toInfo(a) });
    }

    // --- membership --------------------------------------------------------

    /**
     * Register (or re-register) an agent. Idempotent per agentId: a second join
     * with the same id updates the record in place (e.g. rehydrate, or a spec
     * edit). Auto-joins the agent's own `workspaceId:purpose` channel, PLUS every
     * channel in `input.channels` — the explicitly-joined rooms the host persisted
     * to spec meta (genie #65). Returns the public info.
     *
     * Restoring those rooms is what makes membership survive a restart or an
     * agent-terminal relaunch. Without it a re-registered agent came back holding
     * only its purpose room — silently evicted from every shared channel it had
     * joined, with its next channel send reporting a delivered-to-nobody success.
     */
    join(input: AgentInboxJoinInput): AgentInboxAgentInfo {
        const purpose = normalizePurpose(input.purpose);
        const existing = this.agents.get(input.agentId);
        const agent: AgentInboxAgent = {
            agentId: input.agentId,
            terminalId: input.terminalId,
            workspaceId: input.workspaceId,
            workspaceName: input.workspaceName,
            slug: input.slug,
            agentType: input.agentType,
            label: input.label,
            purpose,
            scope: input.scope,
            scopeWorkspaces: [...(input.scopeWorkspaces ?? [])],
            status: input.status ?? 'online',
            chatSessionId: input.chatSessionId ?? null,
            inbox: existing?.inbox ?? [],
            waiter: existing?.waiter ?? null,
            cursor: existing?.cursor ?? 0,
            // Inbox announcements: a persisted preference (from the join input, e.g.
            // spec meta) that survives a re-join; the idle-signal timestamps are
            // runtime state carried across a re-join, never reset by it. Defaults ON
            // (owner, beta.248) — an agent is told about its mail unless someone
            // explicitly turned it off.
            wakeOnDm: input.wakeOnDm ?? existing?.wakeOnDm ?? true,
            nudgeTimer: existing?.nudgeTimer ?? null,
            lastTurnEndAt: existing?.lastTurnEndAt ?? null,
            lastOutputAt: existing?.lastOutputAt ?? null,
            lastWokenAt: existing?.lastWokenAt ?? null,
            // The human's draft state at this terminal — runtime state, carried
            // across a re-join like the idle timestamps.
            draft: existing?.draft ?? EMPTY_DRAFT,
            lastUserInputAt: existing?.lastUserInputAt ?? null,
        };
        this.agents.set(agent.agentId, agent);
        this.byTerminal.set(agent.terminalId, agent.agentId);
        this.emitPresence(agent);
        return this.toInfo(agent);
    }

    /** Re-register a set of agents at boot (from persisted specs). */
    rehydrate(inputs: AgentInboxJoinInput[]): void {
        for (const input of inputs) {
            this.join({ ...input, status: input.status ?? 'away' });
        }
    }

    /** Mark an agent's terminal alive again (it's actively calling agentinbox). */
    markOnline(agentId: string): void {
        const a = this.agents.get(agentId);
        if (!a || a.status === 'online') return;
        a.status = 'online';
        this.emitPresence(a);
    }

    /** The pty exited but the spec is retained — soft offline, revivable. Resolves
     *  any live waiter so a blocked `receive` unblocks. */
    away(terminalId: string): void {
        const agentId = this.byTerminal.get(terminalId);
        const a = agentId ? this.agents.get(agentId) : undefined;
        if (!a) return;
        a.status = 'away';
        this.settleWaiter(a);
        this.emitPresence(a);
    }

    /** The terminal was killed / spec removed — hard leave. Resolves its waiter
     *  and emits an offline presence. */
    leaveByTerminal(terminalId: string): void {
        const agentId = this.byTerminal.get(terminalId);
        if (agentId) this.leave(agentId);
    }

    /** Hard leave by agent id. */
    leave(agentId: string): void {
        const a = this.agents.get(agentId);
        if (!a) return;
        this.settleWaiter(a);
        this.clearNudge(a);
        this.agents.delete(agentId);
        this.byTerminal.delete(a.terminalId);
        if (this.pendingNudges.delete(a.terminalId)) {
            this.pendingNudgeSink?.({ terminalId: a.terminalId, pending: false });
        }
        this.emit({ type: 'offline', agentId });
        // A departed agent's backlog is no longer chaseable — drop it from the lag.
        this.emitLagIfChanged();
    }

    /** Update a captured chat-session id (detect strategy resolved it post-launch). */
    setChatSession(agentId: string, chatSessionId: string): void {
        const a = this.agents.get(agentId);
        if (!a) return;
        a.chatSessionId = chatSessionId;
        this.emitPresence(a);
    }

    /** Change an agent's accessibility and identity metadata. */
    setAccessibility(
        agentId: string,
        patch: {
            scope?: AgentInboxScope;
            workspaces?: string[];
            purpose?: string;
            wakeOnDm?: boolean;
            label?: string;
        },
    ): AgentInboxAgentInfo | null {
        const a = this.agents.get(agentId);
        if (!a) return null;
        if (patch.purpose !== undefined) a.purpose = normalizePurpose(patch.purpose);
        if (patch.scope !== undefined) a.scope = patch.scope;
        if (patch.workspaces !== undefined) a.scopeWorkspaces = [...patch.workspaces];
        if (patch.wakeOnDm !== undefined) a.wakeOnDm = patch.wakeOnDm;
        // Keep the display label in sync so AgentInbox reflects a renamed purpose
        // (the broker prefers `label` over `slug:purpose` everywhere it renders).
        if (patch.label !== undefined) a.label = patch.label;
        this.emitPresence(a);
        return this.toInfo(a);
    }

    /** The agent's current wake-on-DM opt-in — the host persists this to spec meta
     *  so it survives a restart (restored via the join input). */
    wakeOnDmFor(agentId: string): boolean {
        return this.agents.get(agentId)?.wakeOnDm ?? false;
    }

    // --- discovery ---------------------------------------------------------

    /**
     * OUTER TIER — may an agent in `callerWorkspaceId` reach into
     * `targetWorkspaceId` at all? Governs channel join/post AND agent discovery.
     * Same-workspace access is always allowed (a workspace never locks itself
     * out). With no resolver wired this is permissive — see `workspaceAccess`.
     */
    workspaceAllows(callerWorkspaceId: string, targetWorkspaceId: string): boolean {
        if (callerWorkspaceId === targetWorkspaceId) return true;
        if (!this.workspaceAccess) return true; // unwired → pre-feature behaviour
        const policy = this.workspaceAccess(targetWorkspaceId);
        switch (policy.access) {
            case 'all':
                return true;
            case 'specific':
                return policy.workspaces.includes(callerWorkspaceId);
            case 'self':
            case 'none':
            default:
                return false;
        }
    }

    /** INNER TIER — does `target`'s own scope admit a DM from `caller`? */
    private scopeAllows(caller: AgentInboxAgent, target: AgentInboxAgent): boolean {
        switch (target.scope) {
            case 'all':
                return true;
            case 'self':
                return caller.workspaceId === target.workspaceId;
            case 'specific':
                return (
                    caller.workspaceId === target.workspaceId ||
                    target.scopeWorkspaces.includes(caller.workspaceId)
                );
            case 'none':
            case 'hidden':
            default:
                return false;
        }
    }

    /** Whether `target` appears in `caller`'s directory at all. */
    private visible(caller: AgentInboxAgent, target: AgentInboxAgent): boolean {
        if (caller.agentId === target.agentId) return true; // always sees itself
        if (target.scope === 'hidden') return false;
        if (!this.workspaceAllows(caller.workspaceId, target.workspaceId)) return false;
        // An agent is always discoverable by peers in its own workspace. Across
        // workspaces, its mailbox scope is also its roster-visibility boundary:
        // private agents must not leak their identity or presence.
        return (
            caller.workspaceId === target.workspaceId ||
            target.scope === 'all' ||
            (target.scope === 'specific' && target.scopeWorkspaces.includes(caller.workspaceId))
        );
    }

    private deliverToHarness(agent: AgentInboxAgent, msg: AgentInboxMessage): void {
        if (!this.transportSink) {
            // No native transport at all: this agent is not attached to Genie's
            // services, which is precisely the case the PTY fallback exists for.
            this.notAttached(agent, msg);
            return;
        }
        try {
            const accepted = this.transportSink(
                {
                    workspaceId: agent.workspaceId,
                    terminalId: agent.terminalId,
                    agentId: agent.agentId,
                },
                msg,
            );
            if (accepted && typeof (accepted as Promise<boolean>).then === 'function') {
                void Promise.resolve(accepted).then((ok) => {
                    if (ok) this.acknowledge(agent.agentId, msg.seq);
                    else this.notAttached(agent, msg);
                }).catch(() => this.notAttached(agent, msg));
            } else if (accepted === true) {
                this.acknowledge(agent.agentId, msg.seq);
            } else if (accepted === false) {
                // Declined outright: the harness is there and said no. Only
                // `false` means that. Returning NOTHING is an adapter that took
                // the message and leaves the ACK to the agent's own fetch — it
                // is attached, and treating that as a refusal would inject a
                // PTY notice for mail the agent already has.
                this.notAttached(agent, msg);
            }
        } catch {
            /* durable inbox remains queued; the PTY is the only way to say so */
            this.notAttached(agent, msg);
        }
    }

    /** Commit native-harness acceptance after a non-acknowledging fetch. */
    acknowledge(agentId: string, cursor: number): boolean {
        const agent = this.agents.get(agentId);
        const highestDelivered = agent?.inbox.at(-1)?.seq ?? agent?.cursor ?? 0;
        if (!agent || !Number.isInteger(cursor) || cursor < 0 || cursor > highestDelivered) {
            return false;
        }
        this.ackCursor(agent, cursor);
        return true;
    }

    /** Whether `caller` may DM `target`, including replies in an existing thread. */
    private reachable(caller: AgentInboxAgent, target: AgentInboxAgent): boolean {
        if (caller.agentId === target.agentId) return true;
        if (!this.workspaceAllows(caller.workspaceId, target.workspaceId)) return false;
        // A private agent may initiate a conversation with a public peer. Once
        // that durable DM pair exists, the recipient can reply without making
        // the private initiator discoverable to the rest of its workspace.
        const thread = this.dmLogs.get(pairKey(caller.agentId, target.agentId));
        const opener = thread?.[0];
        if (opener?.from === target.agentId && opener.to === caller.agentId) return true;
        return this.scopeAllows(caller, target);
    }

    /** Every agent (the human panel's directory — the human sees all, no scope). */
    directory(): AgentInboxAgentInfo[] {
        return [...this.agents.values()].map((a) => this.toInfo(a));
    }

    /**
     * The peers an agent can discover (excludes itself). Private agents outside
     * the caller's workspace are omitted rather than exposed as unavailable.
     */
    discoverableFor(callerAgentId: string): AgentInboxAgentInfo[] {
        const caller = this.agents.get(callerAgentId);
        if (!caller) return [];
        const out: AgentInboxAgentInfo[] = [];
        for (const target of this.agents.values()) {
            if (target.agentId === callerAgentId) continue;
            if (!this.visible(caller, target)) continue;
            out.push(this.toInfo(target, this.scopeAllows(caller, target)));
        }
        return out;
    }

    /** The public info for one agent (or null). */
    getInfo(agentId: string): AgentInboxAgentInfo | null {
        const a = this.agents.get(agentId);
        return a ? this.toInfo(a) : null;
    }

    // --- delivery ----------------------------------------------------------

    private push(agent: AgentInboxAgent, msg: AgentInboxMessage): void {
        agent.inbox.push(msg);
        if (agent.inbox.length > INBOX_CAP) {
            agent.inbox.splice(0, agent.inbox.length - INBOX_CAP);
        }
        this.settleWaiter(agent);
    }

    private appendLog(map: Map<string, AgentInboxMessage[]>, key: string, msg: AgentInboxMessage): void {
        let log = map.get(key);
        if (!log) {
            log = [];
            map.set(key, log);
        }
        log.push(msg);
        if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    }

    private emitMessage(msg: AgentInboxMessage): void {
        this.emit({
            type: 'message',
            preview: {
                kind: msg.kind,
                toAgentId: msg.kind === 'dm' ? msg.to : undefined,
                from: msg.from,
                fromLabel: msg.fromLabel,
                seq: msg.seq,
                ts: msg.ts,
                preview: previewText(msg.text),
            },
        });
    }

    /**
     * Deliver a message. Exactly one of `toAgentId` (a DM) or `channelArg` (a
     * channel broadcast) must be set. `human:true` posts as the human panel; else
     * `fromAgentId` is the sending agent. Returns how many recipients it reached
     * (`delivered`) or an error. No self-echo on channels.
     *
     * A channel broadcast from an AGENT that reaches NOBODY is reported as a
     * FAILURE (genie #65). It used to return `{ ok: true, delivered: 0 }` —
     * indistinguishable from a delivered report, so an agent whose membership had
     * lapsed believed it had reported while the message reached no one. The text
     * is still recorded in the channel log (the human panel keeps it); only the
     * VERDICT changes, because "nobody received this" is not a success. The human
     * panel's own posts are exempt: the human can see their message land, so an
     * empty room is not an error for them.
     */
    send(input: {
        fromAgentId?: string;
        human?: boolean;
        system?: boolean;
        toAgentId?: string;
        text: string;
        interrupt?: boolean;
        /** Files riding the message. The CALLER has already read + stored the
         *  bytes (the broker owns no fs — see the class doc); this is metadata. */
        attachments?: AgentInboxAttachment[];
    }): AgentInboxSendResult {
        const text = String(input.text ?? '');
        if (!text.trim()) return { ok: false, error: 'A message needs non-empty text.' };

        let from: string;
        let fromLabel: string;
        let sender: AgentInboxAgent | null = null;
        if (input.system) {
            from = 'genie:system';
            fromLabel = 'Genie (no reply)';
        } else if (input.human) {
            from = AGENTINBOX_HUMAN;
            fromLabel = 'You';
        } else {
            sender = input.fromAgentId ? this.agents.get(input.fromAgentId) ?? null : null;
            if (!sender) return { ok: false, error: 'Unknown sender.' };
            from = sender.agentId;
            fromLabel = sender.label || `${sender.slug}:${sender.purpose}`;
        }


        const attachments = input.attachments ?? [];
        const base = {
            seq: 0, // assigned below
            id: crypto.randomUUID(),
            from,
            fromLabel,
            ts: Date.now(),
            // Absent rather than `[]` when nothing is attached, so a plain
            // message stays exactly the shape it has always been on the wire.
            ...(attachments.length ? { attachments } : {}),
        };

        // --- DM ---
        if (input.toAgentId) {
            const target = this.agents.get(input.toAgentId);
            if (!target) return { ok: false, error: `No agent "${input.toAgentId}".` };
            // Agent senders may only DM a peer REACHABLE at send time (workspace
            // tier AND the target's own scope). Re-checked here rather than
            // trusted from a possibly-stale `list`. The human panel owns the
            // workstation, so it can DM anyone.
            if (sender && !this.reachable(sender, target)) {
                return { ok: false, error: 'That agent is not reachable from your workspace.' };
            }
            const msg: AgentInboxMessage = {
                ...base,
                seq: ++this.seq,
                kind: 'dm',
                to: target.agentId,
                text,
                ...(input.interrupt ? { interrupt: true } : {}),
            };
            this.push(target, msg);
            this.appendLog(this.dmLogs, pairKey(from, target.agentId), msg);
            this.store.append(msg);
            this.emitMessage(msg);
            // Server-push: nudge the recipient's MCP GET stream (if it has one)
            // so a connected, waiting agent sees the DM without re-polling.
            this.notifyDelivery(target, msg);
            this.deliverToHarness(target, msg);
            // The native harness transport owns live delivery. Failure leaves
            // the durable message queued; PTY input is never a fallback.
            if (input.interrupt) {
                if (target.terminalId) {
                    this.emit({ type: 'interrupt', terminalId: target.terminalId });
                }
                // Track C: escalate to the human if the target doesn't drain it.
                this.registerEscalation(msg, target);
            }
            this.emitLagIfChanged();
            return { ok: true, delivered: 1, message: msg };
        }

        return { ok: false, error: 'Send needs `to` (an agent).' };
    }

    // --- receive (pull + long-poll) ---------------------------------------

    private settleWaiter(agent: AgentInboxAgent): void {
        const w = agent.waiter;
        if (!w) return;
        agent.waiter = null;
        if (w.timer) clearTimeout(w.timer);
        const pending = agent.inbox.filter((m) => m.seq > w.cursor);
        w.resolve(pending);
    }

    /**
     * Page an agent's inbox from `cursor` (exclusive). With `wait:true` and
     * nothing new, LONG-POLL: park a single waiter that resolves when a message
     * arrives, the agent leaves/goes away, or `timeoutMs` elapses (returning
     * empty). Always resolves; the returned `cursor` is the highest seq seen (so
     * the caller pages forward). A second concurrent wait supersedes the first
     * (resolving it empty) — one live waiter per agent.
     */
    receive(
        agentId: string,
        opts: { cursor?: number; wait?: boolean; timeoutMs?: number; acknowledge?: boolean } = {},
    ): Promise<{ messages: AgentInboxMessage[]; cursor: number }> {
        const agent = this.agents.get(agentId);
        const cursor = opts.cursor ?? 0;
        if (!agent) return Promise.resolve({ messages: [], cursor });

        const pending = agent.inbox.filter((m) => m.seq > cursor);
        const nextCursor = (msgs: AgentInboxMessage[]): number =>
            msgs.length ? msgs[msgs.length - 1].seq : cursor;

        if (pending.length > 0 || !opts.wait) {
            const c = nextCursor(pending);
            if (opts.acknowledge !== false) this.ackCursor(agent, c);
            return Promise.resolve({ messages: pending, cursor: c });
        }

        // Long-poll: supersede any existing waiter, then park a new one.
        if (agent.waiter) this.settleWaiter(agent);
        const waitMs = Math.min(
            Math.max(1, opts.timeoutMs ?? DEFAULT_WAIT_MS),
            MAX_WAIT_MS,
        );
        return new Promise((resolve) => {
            const finish = (msgs: AgentInboxMessage[]): void => {
                const c = nextCursor(msgs);
                if (opts.acknowledge !== false) this.ackCursor(agent, c);
                resolve({ messages: msgs, cursor: c });
            };
            const timer = setTimeout(() => {
                if (agent.waiter && agent.waiter.resolve === finish) agent.waiter = null;
                finish([]);
            }, waitMs);
            if (typeof (timer as { unref?: () => void }).unref === 'function') {
                (timer as { unref: () => void }).unref();
            }
            agent.waiter = { resolve: finish, cursor, timer };
        });
    }

    // --- attachments -------------------------------------------------------

    /**
     * Resolve an attachment FOR a caller — the authorization gate behind
     * `saveAttachment`. Null when the id is unknown, its message is gone (the
     * human wiped that conversation), or the caller was never party to it.
     *
     * An attachment id is a HANDLE, not a capability: possession of the id is
     * not permission to fetch the bytes. Channel access is judged against LIVE
     * membership — the same set delivery uses — so leaving a room ends access to
     * what was posted in it, exactly as it ends delivery.
     *
     * The lookup goes through the STORE rather than the broker's own logs
     * because those are capped: an attachment must stay fetchable for as long as
     * the message exists, not just while it sits in the last 500.
     */
    attachmentFor(agentId: string, attachmentId: string): StoredAttachment | null {
        const att = this.store.getAttachment(String(attachmentId ?? ''));
        if (!att) return null;
        const msg = this.store.getMessage(att.messageId);
        if (!msg) return null;
        return canAccessMessageAttachment({ msg, agentId, channelKeys: [] }) ? att : null;
    }

    /**
     * Read-receipts for the DMs an agent SENT — each with whether the recipient
     * has SEEN it (their ACK cursor passed the message's seq). Lets a sender tell
     * 'queued' from 'seen' and decide whether to escalate to a nudge (issue #9).
     * Durable-store backed (survives restart); newest first, capped.
     */
    receipts(agentId: string, limit = 20): ReturnType<AgentInboxStore['sentDmReceipts']> {
        const cap = Math.min(Math.max(1, limit), 100);
        return this.store.sentDmReceipts(agentId, cap);
    }

    // --- history (human panel) --------------------------------------------

    /**
     * Resolve a display label for a DM participant, tolerating a departed agent.
     * The human is always `You`; a live agent uses its current label; an agent
     * that has already LEFT is recovered from the label it stamped on a message
     * in `log` (else the raw id, so the thread is never label-less).
     */
    private dmLabelFor(id: string, log: AgentInboxMessage[]): string {
        if (id === AGENTINBOX_HUMAN) return 'You';
        const live = this.agents.get(id);
        if (live) return live.label || `${live.slug}:${live.purpose}`;
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].from === id) return log[i].fromLabel;
        }
        return id;
    }

    /**
     * Every DM thread that has messages — human↔agent AND agent↔agent — for the
     * human panel's DMs list. The human owns the workstation, so (like
     * {@link directory}) there is NO scope filter. Each entry carries both
     * participants' labels and a last-message preview, sorted newest-first.
     */
    dmThreads(): AgentInboxDmThreadInfo[] {
        const out: AgentInboxDmThreadInfo[] = [];
        for (const [key, log] of this.dmLogs) {
            if (log.length === 0) continue;
            const sep = key.indexOf('|');
            const a = key.slice(0, sep);
            const b = key.slice(sep + 1);
            const last = log[log.length - 1];
            out.push({
                key,
                a,
                b,
                aLabel: this.dmLabelFor(a, log),
                bLabel: this.dmLabelFor(b, log),
                withHuman: a === AGENTINBOX_HUMAN || b === AGENTINBOX_HUMAN,
                lastFromLabel: last.fromLabel,
                lastPreview: previewText(last.text),
                lastSeq: last.seq,
                lastTs: last.ts,
                count: log.length,
            });
        }
        // Newest-first by ts, tie-broken by seq (monotonic — never ties, so the
        // order is deterministic even for messages within the same millisecond).
        return out.sort((x, y) => y.lastTs - x.lastTs || y.lastSeq - x.lastSeq);
    }

    /**
     * The message log for an arbitrary DM pair (`dmPair: [idA, idB]` — either
     * may be the human; covers agent↔agent), or —
     * for back-compat — the human↔agent thread (`agentId`). Newest-last, capped
     * by `limit`, optionally paged with `before` (only messages with seq <
     * before).
     */
    history(opts: {
        agentId?: string;
        dmPair?: [string, string];
        limit?: number;
        before?: number;
    }): AgentInboxMessage[] {
        let log: AgentInboxMessage[] = [];
        if (opts.dmPair) {
            log = this.dmLogs.get(pairKey(opts.dmPair[0], opts.dmPair[1])) ?? [];
        } else if (opts.agentId) {
            log = this.dmLogs.get(pairKey(AGENTINBOX_HUMAN, opts.agentId)) ?? [];
        }
        let out = log;
        if (opts.before !== undefined) out = out.filter((m) => m.seq < opts.before!);
        const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
        return out.slice(-limit);
    }

    // --- delete / clear (human panel, genie #64) ---------------------------

    /**
     * Delete a whole DM THREAD by its pair key (`<idA>|<idB>`, sorted — the same
     * key {@link dmThreads} reports). Covers human↔agent AND agent↔agent. The
     * thread disappears from the DM list entirely rather than lingering empty.
     * Agent inboxes and cursors are untouched.
     */
    deleteThread(pairKeyArg: string): { ok: boolean; cleared: number } {
        const key = String(pairKeyArg ?? '').trim();
        const sep = key.indexOf('|');
        if (sep <= 0 || sep === key.length - 1) return { ok: false, cleared: 0 };
        const a = key.slice(0, sep);
        const b = key.slice(sep + 1);
        // Normalise so a caller passing the pair unsorted still hits the log.
        const normalized = pairKey(a, b);
        const inMemory = this.dmLogs.get(normalized)?.length ?? 0;
        this.dmLogs.delete(normalized);
        const persisted = this.store.deleteDmThread(a, b);
        const cleared = Math.max(inMemory, persisted);
        if (cleared > 0) this.emit({ type: 'cleared', scope: 'dm', key: normalized });
        return { ok: true, cleared };
    }

    /**
     * MASS delete (genie #66) — wipe many conversations in ONE host call so the
     * panel doesn't fire N round trips (which on a remote Host means N requests
     * over the relay).
     *
     * Deliberately a BATCH OVER the existing ops rather than a second
     * implementation: every target goes through {@link deleteThread}, so the
     * durable semantics and the non-interference
     * rule (agent inboxes and ACK cursors untouched) hold by construction, and a
     * `cleared` event still fires per target so per-key cache invalidation stays
     * exact for every listening window.
     *
     * Keys are deduped. A malformed key is skipped without aborting the batch —
     * one bad entry must not cost the user the other twenty deletions.
     */
    wipeMany(input: { pairKeys?: string[] }): {
        ok: boolean;
        cleared: number;
        channels: number;
        threads: number;
    } {
        let cleared = 0;
        let threads = 0;
        for (const key of new Set(input.pairKeys ?? [])) {
            const r = this.deleteThread(key);
            if (r.ok && r.cleared > 0) {
                cleared += r.cleared;
                threads++;
            }
        }
        return { ok: true, cleared, channels: 0, threads };
    }

    // --- test / diagnostic accessors --------------------------------------

    /** Reset all state — test-only. */
    _reset(): void {
        this.agents.clear();
        this.byTerminal.clear();
        this.dmLogs.clear();
        this.seq = 0;
        this.lastLagCount = 0;
    }
}

/**
 * The process-wide singleton. Everyone (MCP host-tools, terminal lifecycle, IPC
 * handlers) shares this instance; presence.ts installs the real emitter at boot.
 */
export const agentInboxBroker = new AgentInboxBroker();
