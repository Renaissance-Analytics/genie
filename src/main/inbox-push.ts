import type { AgentId, AgentRecord } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import type { PromptContext } from '../core/session.js';
import type { NoticeMail } from '../core/stream-event.js';
import { AppTurnBudget, appDelivery, isAppSender, type AppDelivery } from '../core/app-inbox.js';

/**
 * §6.4 THE INBOX PUSH — GENIE'S, FOR EVERY PROVIDER. When mail lands for an agent, Genie puts the notice into that
 * agent's own session as a turn (`by: genie`): at once when the session can take one; when it is mid-turn or still
 * starting, the moment it can (its turn ending, its driver ready, it being started at all). Exactly once per arrival
 * batch (core/inbox-reminders.ts).
 *
 * Nothing here asks a provider for anything but a prompt: no hook, no MCP notification, no provider interrupt. Both
 * events are Genie's own — a message landing (`inbox.onSend`) and the session changing (`host.subscribe`: a turn
 * ending, ready, started, stopped) — so nothing polls.
 *
 * TOLD MEANS DELIVERED: a notice is settled as told only when ITS turn ends cleanly. A prompt that throws or is not
 * taken, a turn that crashes, a session stopped under it — each leaves the batch untold, and the next moment the
 * agent can take a turn tells it. While a notice is out the book holds it as sending, so two events in one tick never
 * both prompt.
 *
 * NOBODY HAS TO TYPE (genie#1379; the owner on beta.53: "Users should not have to drive chat for agents to get
 * notifications they need"). Every agent with a session is told — app mail, agent mail, replies alike: an idle one after
 * a short COALESCING window (`coalesceMs`), so a burst is one turn naming them all; a busy one when its turn ends. #1350
 * gave a manual agent no turn of its own for an app's message, so it heard only after the person's next turn. What
 * stays mode-shaped is only whether a STOPPED agent is started (`appMail`), and THE APP WAKE CAP (`appBudget`): a turn
 * for mail that is all from apps is spent from it; past it the mail waits for the window, then one turn.
 *
 * It was inline in main.ts and keyed on `turnState === 'idle'`. A session just started reads `working` until a turn
 * ends, with no turn running, so an agent started and mailed at once (a sidecar, the moment `runAgent` answered) was
 * told only after somebody else had prompted it and that turn had ended (B26, a Codex sidecar in beta.27).
 */
export interface InboxPushPorts {
    readonly inbox: { onSend(listener: (to: string, message?: { readonly from: string }) => void): () => void };
    readonly host: {
        subscribe(listener: (agentId: AgentId) => void): () => void;
        /** The agent's run when its session can take a turn now, else `null` (SessionHost.promptable). */
        promptable(agentId: AgentId): number | null;
        /** The agent's current run while it has a session at all, else `null`. */
        runOf(agentId: AgentId): number | null;
        /** Turns ended in the agent's current run. */
        turnsEndedThisRun(agentId: AgentId): number;
        probe(agentId: AgentId): LiveSession | null;
        prompt(agentId: AgentId, text: string, by?: string | null, context?: PromptContext): boolean;
    };
    /**
     * The notices due (compose's `inboxReminders`): decides and marks them sending; never sends. `mail`: the messages a
     * notice tells about, carried on its ledger row so the chat shows who wrote and what (beta.33 item 18).
     */
    readonly reminders: (input: { run: (agentId: string) => number | null }) => Array<{ agentId: string; text: string; mail?: readonly NoticeMail[] }>;
    /** A notice settled (compose's `inboxNoticeSettled`): delivered, or its batch untold. */
    readonly settled: (agentId: string, delivered: boolean) => void;
    /**
     * MAIL WAKES THE AGENT (the owner, 2026-10-17: "agents don't wake up from inbox pushes unless I go to their screen").
     * Start the session of an agent that has none — main's open-agent path, refusing by name for an asleep workspace or
     * the agent cap. Answers whether it started; its start event then delivers the notice. Absent = mail waits.
     */
    readonly wake?: ((agentId: AgentId) => boolean) | undefined;
    /**
     * APP MAIL (genie#1345; genie#1379): whether a STOPPED agent is started for a message an APP sent — `push` (started,
     * as mail does) or `push-no-wake` (not: a manual agent, or the app wake cap is spent; its mail waits). Either way an
     * agent with a session is told exactly as for any mail. `null` = not an app's message. Absent = every message as mail.
     */
    readonly appMail?: ((to: AgentId, message: { readonly from: string }) => AppDelivery | null) | undefined;
    /**
     * THE APP WAKE CAP (core/app-inbox.ts AppTurnBudget): a notice whose mail is ALL from apps is a turn an app caused —
     * sent only while `waitMs` is 0, then `spend`; otherwise it waits `waitMs` (needs `schedule`) and is told then. A
     * notice with any person's or agent's mail in it is never held. Absent = no cap.
     */
    readonly appBudget?: { waitMs(agentId: AgentId): number; spend(agentId: AgentId): void } | undefined;
    /** Genie's timer (main: setTimeout), answering a cancel. Absent = no coalescing and no deferred app turns. */
    readonly schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
    /**
     * THE COALESCING WINDOW: mail arriving for an agent with a session is told this long after the FIRST arrival, so a
     * burst is one turn naming them all, not one per message. 0 or absent = at once.
     */
    readonly coalesceMs?: number | undefined;
}

export function wireInboxPush(ports: InboxPushPorts): () => void {
    const { inbox, host, reminders, settled } = ports;
    /** The notice out per agent: the run it went to and how many of that run's turns had ended when it was sent. */
    const out = new Map<string, { run: number; endedBefore: number }>();
    /** An arrival's coalescing window, per agent: while one is open the agent is told when it closes, not before. */
    const coalescing = new Map<string, () => void>();
    /** An app-only notice held by the app wake cap, per agent: told when the window allows. */
    const deferred = new Map<string, () => void>();
    const { schedule } = ports;
    const coalesceMs = ports.coalesceMs ?? 0;

    /** Settle the agent's notice if its fate is known now. Answers whether one is still out. */
    const settle = (id: AgentId): boolean => {
        const sent = out.get(id);
        if (!sent) return false;
        if (host.runOf(id) !== sent.run) {
            // Stopped (or restarted) under it: the run it went to never finished its turn.
            out.delete(id);
            settled(id, false);
            return false;
        }
        // Sent only when no turn was in flight, so the next turn to end in that run is the notice's own.
        if (host.turnsEndedThisRun(id) <= sent.endedBefore) return true;
        out.delete(id);
        settled(id, host.probe(id)?.turnState !== 'failed');
        return false;
    };

    // Only the agent the event is about is considered: another agent's batch is told on ITS events, not on this one's.
    const push = (only: string): void => {
        if (settle(only as AgentId)) return;
        // An arrival's window is open: its close tells everything that came in it, once.
        if (coalescing.has(only)) return;
        for (const r of reminders({ run: (id) => (id === only ? host.promptable(id as AgentId) : null) })) {
            const id = r.agentId as AgentId;
            const run = host.runOf(id);
            if (run === null) { settled(id, false); continue; }
            // A turn only apps' mail would cause is spent from the app wake cap; past it, told when the window allows.
            const appCaused = ports.appBudget !== undefined && r.mail !== undefined && r.mail.length > 0 && r.mail.every((m) => isAppSender(m.from));
            if (appCaused) {
                const wait = ports.appBudget!.waitMs(id);
                if (wait > 0) {
                    settled(id, false);
                    if (schedule && !deferred.has(id)) deferred.set(id, schedule(() => { deferred.delete(id); push(id); }, wait));
                    continue;
                }
            }
            // Out BEFORE the prompt: the prompt itself announces a change, and that re-entry must see it in flight.
            out.set(id, { run, endedBefore: host.turnsEndedThisRun(id) });
            let taken = false;
            try {
                taken = host.prompt(id, r.text, 'genie', r.mail ? { mail: r.mail } : {});
            } catch {
                taken = false;
            }
            if (!taken) {
                out.delete(id);
                settled(id, false);
            } else if (appCaused) {
                ports.appBudget!.spend(id);
            }
        }
    };
    /** Mail arrived for an agent with a session: told when the coalescing window closes (at once without one). */
    const arrived = (to: string): void => {
        if (!schedule || coalesceMs <= 0 || host.runOf(to as AgentId) === null) { push(to); return; }
        if (coalescing.has(to)) return;
        coalescing.set(to, schedule(() => { coalescing.delete(to); push(to); }, coalesceMs));
    };
    // Only an ARRIVAL wakes an agent with no session: on the host's own events (its stop among them) it is not restarted.
    const offSend = inbox.onSend((to, message) => {
        if (to === 'human') return;
        const app = message ? ports.appMail?.(to as AgentId, message) ?? null : null;
        // Only WHETHER a stopped agent is started differs for an app's message; one with a session is told as for any.
        if (host.runOf(to as AgentId) === null && ports.wake && app !== 'push-no-wake') {
            let started = false;
            try { started = ports.wake(to as AgentId); } catch { started = false; }
            if (started) return; // its start announces itself, and that event delivers the notice
        }
        arrived(to);
    });
    const offHost = host.subscribe((agentId) => push(agentId));
    return () => {
        offSend();
        offHost();
        for (const cancel of [...coalescing.values(), ...deferred.values()]) cancel();
        coalescing.clear();
        deferred.clear();
    };
}

/** THE COALESCING WINDOW main gives the mail push: a burst arriving inside it is one turn (genie#1379). */
export const INBOX_COALESCE_MS = 1_500;

/**
 * MAIN'S APP POLICY for the mail push (genie#1379), one place so main and the VM harness cannot drift: whether a stopped
 * agent is started for an app's message (automated, while the cap allows), THE APP WAKE CAP (AppTurnBudget), Genie's
 * timer and the coalescing window.
 */
export function appMailPushPorts(input: {
    readonly modeOf: (agentId: AgentId) => AgentRecord['mode'] | undefined;
    readonly now: () => number;
    readonly schedule: (fn: () => void, ms: number) => () => void;
}): Required<Pick<InboxPushPorts, 'appMail' | 'appBudget' | 'schedule' | 'coalesceMs'>> {
    const budget = new AppTurnBudget(input.now);
    return {
        appMail: (to, message) => (isAppSender(message.from) ? appDelivery(input.modeOf(to) ?? 'manual', budget.waitMs(to) === 0) : null),
        appBudget: budget,
        schedule: input.schedule,
        coalesceMs: INBOX_COALESCE_MS,
    };
}
