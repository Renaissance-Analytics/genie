/**
 * A PARKED APPROVAL — what the protocol sends, turned into something a person can answer.
 *
 * ## This is a narrowing boundary, and it must narrow without inventing
 *
 * ACP's `PermissionRequest` is `{ toolCall: Record<string, unknown>, options: Record<string,
 * unknown>[] }`. Both are open records on purpose: the option ids, their labels and their
 * meanings are **provider-defined** and come from the other end of the wire.
 *
 * So every field here is read defensively, and anything that cannot be read is **dropped or
 * refused** rather than repaired. Offering a button that resolves to nothing is worse than
 * offering none — the human presses it, the agent stays parked, and the surface has already
 * told them the question was answered.
 *
 * ## Tone comes from the protocol's `kind`, never from the label
 *
 * This is the one place where being clever is actively dangerous. A provider could ship an
 * option called *"Allow once and remember"* that denies, or one written in another language,
 * and a substring match on "allow" would paint a deny button green. There is no worse way for
 * this surface to be wrong, so an unrecognised kind is **neutral**: the reader sees the
 * provider's own words and no colour-coded claim about what they mean.
 */

export interface PermissionRequestLike {
    readonly toolCall: Record<string, unknown>;
    readonly options: readonly Record<string, unknown>[];
}

export type OptionTone = 'ok' | 'bad' | 'neutral';

export interface ApprovalOption {
    /** The provider's own id, verbatim — it goes back over the wire unchanged. */
    id: string;
    label: string;
    tone: OptionTone;
}

export interface Approval {
    /** What the agent is asking about, in its own words. */
    question: string;
    options: readonly ApprovalOption[];
    /**
     * The board's details, each from the request's own tool call and `null` when the provider did not say: the
     * call's id (`tool_call 7f3a`), the tool (`asks to run Bash`), ACP's kind, and the command in the arguments.
     * Optional on the type: an approval minted before these travelled is still an approval.
     */
    toolCallId?: string | null;
    tool?: string | null;
    kind?: string | null;
    command?: string | null;
}

/**
 * ACP's permission-option kinds, and the only strings that may carry a colour.
 *
 * Matched exactly, including case: `ALLOW_ONCE` is not a kind this protocol defines, and
 * accepting it would be guessing about a value some other implementation chose.
 */
const TONES: Record<string, OptionTone> = {
    allow_once: 'ok',
    allow_always: 'ok',
    reject_once: 'bad',
    reject_always: 'bad',
};

function stringAt(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Narrow a permission request, or `null` for one that cannot be answered.
 *
 * Two refusals, both deliberate:
 *
 *  - **a call that describes nothing.** "Allow?" with nothing after it asks somebody to
 *    approve an action neither of you can name, and the whole point of an approval is that a
 *    human decided about a specific thing.
 *  - **no readable options.** A question with no answers is not a question; rendering one
 *    leaves a person staring at something they cannot resolve, on a surface whose entire job
 *    is resolving things.
 */
export function approvalFrom(request: PermissionRequestLike): Approval | null {
    const question = stringAt(request.toolCall, 'title') ?? stringAt(request.toolCall, 'name');
    if (question === null) return null;

    const options = request.options.flatMap((raw): ApprovalOption[] => {
        const id = stringAt(raw, 'optionId');
        // An option we cannot identify cannot be sent back, so it is dropped rather than
        // rendered as a button that does nothing.
        if (id === null) return [];

        const kind = stringAt(raw, 'kind');
        return [{
            id,
            // The id is at least the provider's own word for it. A blank button is not.
            label: stringAt(raw, 'name') ?? id,
            tone: (kind !== null && TONES[kind]) || 'neutral',
        }];
    });

    if (options.length === 0) return null;
    const input = request.toolCall['rawInput'];
    const command = typeof input === 'object' && input !== null ? stringAt(input as Record<string, unknown>, 'command') : null;
    return {
        question,
        options,
        toolCallId: stringAt(request.toolCall, 'toolCallId'),
        tool: stringAt(request.toolCall, 'name'),
        kind: stringAt(request.toolCall, 'kind'),
        command,
    };
}
