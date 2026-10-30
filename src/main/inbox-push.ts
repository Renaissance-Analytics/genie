import type { AgentId } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import type { PromptContext } from '../core/session.js';
import type { NoticeMail } from '../core/stream-event.js';
import type { AppDelivery } from '../core/app-inbox.js';

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
     * APP MAIL (genie#1345, the owner's D1): how a message an APP sent reaches its agent — `push` (told now, woken if
     * stopped), `push-no-wake` (told now if it can take a turn, never woken: the app wake allowance is spent) or
     * `next-turn` (a manual agent: no wake and no turn of its own; told at its next session event, its next turn ending).
     * `null` = not an app's message: delivered exactly as mail always was. Absent = every message as mail.
     */
    readonly appMail?: ((to: AgentId, message: { readonly from: string }) => AppDelivery | null) | undefined;
    /** An app's message woke `agentId` (what the app wake allowance counts). */
    readonly appWoke?: ((agentId: AgentId) => void) | undefined;
}

export function wireInboxPush(ports: InboxPushPorts): () => void {
    const { inbox, host, reminders, settled } = ports;
    /** The notice out per agent: the run it went to and how many of that run's turns had ended when it was sent. */
    const out = new Map<string, { run: number; endedBefore: number }>();

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
        for (const r of reminders({ run: (id) => (id === only ? host.promptable(id as AgentId) : null) })) {
            const id = r.agentId as AgentId;
            const run = host.runOf(id);
            if (run === null) { settled(id, false); continue; }
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
            }
        }
    };
    // Only an ARRIVAL wakes an agent with no session: on the host's own events (its stop among them) it is not restarted.
    const offSend = inbox.onSend((to, message) => {
        if (to === 'human') return;
        const app = message ? ports.appMail?.(to as AgentId, message) ?? null : null;
        // A manual agent is given no turn of its own for an app's message: the next event it has tells it.
        if (app === 'next-turn') return;
        if (host.runOf(to as AgentId) === null && ports.wake && app !== 'push-no-wake') {
            let started = false;
            try { started = ports.wake(to as AgentId); } catch { started = false; }
            if (started) {
                if (app === 'push') ports.appWoke?.(to as AgentId);
                return; // its start announces itself, and that event delivers the notice
            }
        }
        push(to);
    });
    const offHost = host.subscribe((agentId) => push(agentId));
    return () => { offSend(); offHost(); };
}
