import fs from 'node:fs';
import path from 'node:path';
import { handoffPath } from './handoff';

/**
 * Ask a running agent for a handoff BEFORE its terminal is killed.
 *
 * Unmounting or deleting an agent stops it and its sidecars. That is the last
 * moment the agent is still there to be asked what it was doing — the owner's
 * rule is to "prompt the user if they want to create a handoff first", and the
 * word FIRST is the contract. Once the terminal is gone, whatever it had in
 * flight is unrecoverable and nobody can ask it anything.
 *
 * Two halves, kept apart so each is testable on its own:
 *
 *  - {@link handoffRequestMessage} — WHAT the agent is told. Pure.
 *  - {@link awaitHandoff} — waiting for the note to land, event-driven via
 *    `fs.watch` rather than a poll, and BOUNDED: an agent mid-tool-call may
 *    never answer, and a delete that hangs forever on one is worse than a
 *    delete with no note.
 */

/** How long to wait for the agent to write one before giving up and stopping
 *  it anyway. Long enough for a turn to wrap up, short enough that a wedged
 *  agent does not make Delete look broken. */
export const HANDOFF_WAIT_MS = 45_000;

/**
 * The message delivered to the agent.
 *
 * Names `imDone`'s `handoff` explicitly. The agent has exactly one way to
 * leave a note, and a vague "please summarise" gets answered by PRINTING into
 * a terminal nobody is watching — the failure this whole path exists to avoid.
 * It also says the terminal is about to be killed, because without that an
 * agent reasonably defers the note to later, and there is no later.
 */
export function handoffRequestMessage(agentName: string): string {
    return [
        `You are being stopped: this terminal is about to be shut down and killed.`,
        ``,
        `Before you do anything else, call \`imDone\` with a \`handoff\` note for`,
        `whoever picks up "${agentName}" next — what you were in the middle of,`,
        `what is already done, and anything the next run cannot work out from the`,
        `repo on its own. Do not start new work.`,
    ].join('\n');
}

/**
 * Resolve true once `file` exists, false once `timeoutMs` has passed.
 *
 * Checks first, then watches. A note written before the watcher started would
 * otherwise be missed entirely and the caller would wait out the whole timeout
 * for something already on disk.
 */
export function awaitHandoff(file: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        if (fs.existsSync(file)) {
            resolve(true);
            return;
        }

        const dir = path.dirname(file);
        const base = path.basename(file);
        let settled = false;
        let watcher: fs.FSWatcher | null = null;

        const finish = (landed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                watcher?.close();
            } catch {
                // A watcher that is already gone is not a failure to report.
            }
            resolve(landed);
        };

        const timer = setTimeout(() => finish(false), timeoutMs);
        // Never hold the process open for a note nobody is going to write.
        timer.unref?.();

        try {
            watcher = fs.watch(dir, (_event, name) => {
                if (name && path.basename(String(name)) !== base) return;
                if (fs.existsSync(file)) finish(true);
            });
            // Some platforms report the rename before the content is readable,
            // and a watch on a directory can miss an event under load. One
            // existence check on a short delay closes that gap without turning
            // this into a poll.
            const settle = setTimeout(() => {
                if (fs.existsSync(file)) finish(true);
            }, 250);
            settle.unref?.();
        } catch {
            // No watch available — the timeout is then the whole contract, and
            // the caller stops the agent without a note rather than crashing.
        }
    });
}

export interface HandoffRequest {
    workspaceRoot: string;
    agentName: string;
    /** Every live terminal this agent may be running under. */
    terminalIds: readonly string[];
    /** Injected so this is testable without the broker; in production it is
     *  `broker.deliverHumanMessageToTerminal`, which returns false when the
     *  terminal has no registered agent identity to deliver to. */
    deliver: (terminalId: string, text: string) => boolean;
    timeoutMs?: number;
}

/**
 * Ask, then wait. Returns whether a note actually landed.
 *
 * Waits only when the request was RECEIVED by something: a dormant agent has
 * no terminal, and a terminal with no registered identity received nothing —
 * in both cases waiting out a timeout for a note nothing can write would just
 * make Delete feel broken.
 */
export async function requestHandoffBeforeStop(req: HandoffRequest): Promise<boolean> {
    if (req.terminalIds.length === 0) return false;

    const text = handoffRequestMessage(req.agentName);
    let delivered = false;
    for (const terminalId of req.terminalIds) {
        try {
            if (req.deliver(terminalId, text)) delivered = true;
        } catch {
            // One unreachable terminal must not stop the others being asked.
        }
    }
    if (!delivered) return false;

    return awaitHandoff(
        handoffPath(req.workspaceRoot, req.agentName),
        req.timeoutMs ?? HANDOFF_WAIT_MS,
    );
}
