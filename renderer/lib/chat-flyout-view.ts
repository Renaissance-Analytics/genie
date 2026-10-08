import { sessionFidelity, type AgentSession } from '../../main/agentsession/model';

/**
 * THE CHAT FLYOUT's decisions — §5.4 of the owner's spec board.
 *
 * It replaces the Agent view's composer, which makes it the only place a human types to an
 * agent. That is why its REFUSALS matter more than its layout: what this surface says about an
 * agent it cannot hear from decides whether a one-sided thread reads as *"nobody replied"* or
 * as *"this provider does not report replies"*. The first is a bug report; the second is a
 * fact about the provider.
 *
 * Pure, like `deck-view` and `dashboard-view`, for the same stated reason: a decision inside
 * JSX can only be reached by an E2E shard.
 */

/**
 * The pinned gutter, in px — the board's figure.
 *
 * Declared here rather than only in CSS so the component, the reserve and the test cannot
 * disagree about it. Pinned it RESERVES; unpinned it overlays with a shadow and nothing
 * underneath moves. That rule has shipped wrong three times in this repo — the reserve on the
 * whole shell, then `padding-right` on a flex column, then naming only the hidden grid row
 * (genie#841) — so the number is a constant and the geometry is asserted in E2E.
 */
export const CHAT_DOCK_WIDTH = 380;

export type ChatContextLevel = 'normal' | 'attention' | 'broken' | 'muted';

export interface ChatFlyoutView {
    /** The one-line status under the thread chips, or null with no agent selected. */
    contextLine: string | null;
    contextLevel: ChatContextLevel;
    /** What the composer says when empty. Always names the destination. */
    placeholder: string;
    /** `Send`, or `Send to terminal` when the text goes to a pty. */
    sendLabel: string;
    canSend: boolean;
    canStop: boolean;
    /** Why this thread will only ever show one side, or null when it shows both. */
    oneSidedNote: string | null;
    isEmpty: boolean;
    emptyHint: string | null;
}

/** `2m 14s`, as the board writes a parked duration. Seconds matter here in a way they do not
 *  on the Dashboard: this is the one number telling a person they are the bottleneck. */
function parkedFor(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
}

function planPosition(session: AgentSession): string | null {
    if (!session.plan || session.plan.length === 0) return null;
    const index = session.plan.findIndex((e) => e.status === 'in-progress');
    if (index === -1) return null;
    return `Plan ${index + 1}/${session.plan.length} · ${session.plan[index]!.title}`;
}

export function chatFlyoutView(input: {
    session: AgentSession | null;
    now: number;
}): ChatFlyoutView {
    const { session, now } = input;

    if (!session) {
        return {
            contextLine: null,
            contextLevel: 'muted',
            placeholder: 'Message genie, or @ an agent',
            sendLabel: 'Send',
            canSend: true,
            canStop: false,
            oneSidedNote: null,
            isEmpty: true,
            // Not just "no messages". An empty surface that only reports its emptiness teaches
            // nothing; this one says what the default recipient can do.
            emptyHint:
                'genie can reach any agent in any workspace. Name one with @, or pick a thread above.',
        };
    }

    const name = session.session.name;
    const provider = session.session.provider;
    const observed = sessionFidelity(session) === 'observed';
    const parked = session.turn.state === 'awaiting-input' || session.turn.state === 'awaiting-approval';
    const running = !parked && session.turn.state !== 'idle';

    let contextLine: string;
    let contextLevel: ChatContextLevel;
    if (session.error) {
        // Broken outranks the turn: an agent whose stream has closed is not working, whatever
        // its last turn state said.
        contextLine = `Broken · ${session.error}`;
        contextLevel = 'broken';
    } else if (parked) {
        contextLine = `Parked · waiting on you for ${parkedFor(now - session.turn.since)}`;
        contextLevel = 'attention';
    } else if (observed) {
        contextLine = `Observed · ${provider ?? 'this provider'} runs in a terminal`;
        contextLevel = 'muted';
    } else if (running) {
        const plan = planPosition(session);
        contextLine = plan ? `Working · ${plan}` : 'Working';
        contextLevel = 'normal';
    } else {
        contextLine = 'Idle';
        contextLevel = 'normal';
    }

    /**
     * A BROKEN agent cannot be sent to, and says so by keeping the draft.
     *
     * Dormancy alone does NOT disable the composer: mail queues durably and sending is what
     * wakes an agent, so greying the box for every idle agent would make the whole roster look
     * unreachable. Only a real fault stops it.
     */
    const canSend = !session.error;

    const placeholder = session.error
        ? `Draft kept. Sends when ${name} is running.`
        : observed
          ? `Type into ${name}'s terminal`
          : `Message ${name}`;

    return {
        contextLine,
        contextLevel,
        placeholder,
        // §6.3 applied to a VERB. The input is not withheld from an Observed agent — that
        // would remove the only way to nudge a pty — but a button saying "Send" beside a
        // thread that will never show a reply promises a conversation. One word fixes it.
        // §6.3 applied to a VERB. The input is not withheld from an Observed agent — that
        // would remove the only way to nudge a pty — but a button saying "Send" beside a
        // thread that will never show a reply promises a conversation. One word fixes it.
        sendLabel: observed ? 'Send to terminal' : 'Send',
        canSend,
        // PARKED IS NOT RUNNING. A Stop button on a turn already waiting for you suggests the
        // agent is busy, when the thing it waits for is you.
        canStop: running,
        oneSidedNote: observed
            ? `${provider ?? 'This provider'} does not report a conversation. What you send here is typed into ${name}'s terminal; its replies stay in the terminal.`
            : null,
        isEmpty: false,
        emptyHint: null,
    };
}
