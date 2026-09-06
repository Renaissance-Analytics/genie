/**
 * May THIS window answer a pending question, and what does it say when it can't?
 *
 * genie#468. Control-gating (genie#467) stopped forwarding the always-on-top
 * modal and the chime to a driver that does not hold control — correctly, since
 * the host 423s every state-changing call while locked. What it deliberately did
 * NOT change is that such a driver still SEES the host's pending questions in
 * the flyout: not interrupted is not the same as not told.
 *
 * From there it could still press Answer. The POST was refused, the client threw
 * the rejection away, and nothing appeared — the button un-busied and the
 * question stayed exactly where it was. That silence is indistinguishable from
 * success followed by a slow refresh, so the natural read is "it worked" and the
 * natural next move is to press it again.
 *
 * Two halves live here, both pure so the flyout is thin glue over them:
 *
 *  - {@link answerGate} decides whether the control is usable AT ALL, and names
 *    the reason when it is not. A control you cannot use should not look usable,
 *    and a greyed button with no reason is the same silence in a costume.
 *  - {@link submitAnswer} makes every outcome of a submit into something the UI
 *    must render. The baton moves precisely when a question is pending — the
 *    host owner grabs it because they want to answer that question themselves —
 *    so a refusal can still arrive after an open gate rendered.
 */

/** The control state a window renders (mirrors `RemoteControlState`). Null for a
 *  local window, which is never gated: it holds control of itself. */
export interface AnswerControl {
    locked: boolean;
    holderEmoji?: string | null;
    holderName?: string | null;
}

export interface AnswerGate {
    /** May this window submit an answer right now? */
    canAnswer: boolean;
    /** Why not — rendered beside the disabled control. Null when it can. */
    reason: string | null;
}

/** Who holds the baton, said the way a person would. Several members can drive
 *  one workstation, so naming the machine would blame the host for a peer. */
function holder(control: AnswerControl): string {
    const name = control.holderName?.trim();
    if (!name) return 'The host';
    const emoji = control.holderEmoji?.trim();
    return emoji ? `${emoji} ${name}` : name;
}

export function answerGate(control: AnswerControl | null | undefined): AnswerGate {
    if (!control?.locked) return { canAnswer: true, reason: null };
    return {
        canAnswer: false,
        reason: `${holder(control)} has control of this workstation, so this question can only be answered there.`,
    };
}

/**
 * What a submit that did NOT deliver says to the reviewer.
 *
 * The lock reaches the renderer as an Error MESSAGE and nothing else: an Error
 * does not survive `ipcRenderer.invoke` with its type, so there is no code to
 * branch on. Two spellings arrive for the same 423 — main's `remoteRequest`
 * throws the sentence, the relay path throws `HTTP 423` — and both are the same
 * fact. (The twin for the forwarded MODAL is `forwardedAnswerFailureMessage` in
 * main/remote/index.ts; it says the same three things in the modal's voice.)
 */
export function answerFailureMessage(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('423') || /remote control locked/i.test(msg)) {
        return 'The host took control before this answer landed, so it was refused. The question is still waiting — answer it on the host, or take control here first.';
    }
    if (msg.includes('401') || msg.includes('403')) {
        return 'The host rejected this session. Reconnect and answer again — the question is still waiting.';
    }
    return `The host did not accept the answer (${msg}). It is still waiting, so nothing was lost.`;
}

/** Someone else answered first, so this answer was not the one that counted. */
export const ANSWER_ALREADY_HANDLED =
    'That question was already answered somewhere else, so this answer was not used.';

/**
 * The outcome of a submit — every case carries what to SHOW, so `false` and a
 * rejection stop being values the UI can drop on the floor.
 */
export type AnswerReport =
    | { kind: 'answered' }
    | { kind: 'already-answered'; message: string }
    | { kind: 'refused'; message: string };

/**
 * Run one answer submission and classify what came back.
 *
 * `send` resolves TRUE when the host used the answer, FALSE for the benign
 * already-answered race (the desktop, or another driver, got there first).
 * Benign is not the same as invisible: the reviewer typed an answer and it was
 * not the one that counted, and they are owed that sentence.
 */
export async function submitAnswer(send: () => Promise<boolean>): Promise<AnswerReport> {
    try {
        const answered = await send();
        return answered
            ? { kind: 'answered' }
            : { kind: 'already-answered', message: ANSWER_ALREADY_HANDLED };
    } catch (err) {
        return { kind: 'refused', message: answerFailureMessage(err) };
    }
}

/**
 * What the card DOES with a report — the last place an outcome can be dropped.
 *
 * Classifying the failure buys nothing if the component then ignores the
 * classification, which is exactly the bug that was here: the submit awaited the
 * call, discarded both the rejection and the `false`, and un-busied the button.
 * Deciding it here means it can be asserted without a DOM.
 *
 * An accepted answer needs no sentence — the question visibly leaving the list
 * is the confirmation. A refusal deliberately does NOT re-read: the question is
 * still pending and nothing moved, so refreshing would flicker the card as if
 * something had happened.
 */
export function applyAnswerReport(
    report: AnswerReport,
    sinks: { notice: (message: string | null) => void; refresh: () => void },
): void {
    if (report.kind === 'answered') {
        sinks.refresh();
        return;
    }
    sinks.notice(report.message);
    if (report.kind === 'already-answered') sinks.refresh();
}
