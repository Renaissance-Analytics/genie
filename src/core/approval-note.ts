/**
 * WHAT AN APPROVAL'S NOTE SAYS TO THE AGENT (beta.33 item 16; the owner: "compass proposed a file edit but I rejected
 * with a note in the rejection but compass did not get the rejection notice … compass was never made aware").
 *
 * ACP's permission outcome carries an option and nothing else, so the note travels as a message from the person, sent
 * after the answer through the path a chat prompt takes — the agent reads it at its next step. Pure: the words only.
 * A blank note is no message (`null`): an answer without one says everything the option says.
 */
export interface ApprovalNoteInput {
    /** What was asked about, in the request's own words (`Edit src/config.ts`, `compass wants to open a terminal: …`). */
    readonly what: string;
    /** How the option reads (core/approval.ts tone): allowed, denied, or another answer. */
    readonly outcome: 'allowed' | 'denied' | 'answered';
    /** The option's label, for an answer that is neither an allow nor a deny. */
    readonly option: string;
    readonly note: string;
}

export function approvalNoteText(input: ApprovalNoteInput): string | null {
    const note = input.note.trim();
    if (note === '') return null;
    switch (input.outcome) {
        case 'denied':
            return `You rejected ${input.what}: ${note}`;
        case 'allowed':
            return `You approved ${input.what}, with a note: ${note}`;
        case 'answered':
            return `You answered "${input.option}" to ${input.what}: ${note}`;
    }
}
