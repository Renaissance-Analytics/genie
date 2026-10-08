import type { ToolCall } from '../../main/agentsession/model';

/**
 * WHAT a tool call is acting on, for a one-line row — or nothing.
 *
 * The brief asks the Agent view to be able to say *"it is editing `ipc.ts` right now"*. Until
 * genie#843 the model could not: `ToolCall` was `{id, name, status}` and the agent's arguments
 * were discarded on arrival. They are kept now, and this is their first consumer.
 *
 * ## Why it returns null so often, deliberately
 *
 * `rawInput` is an agent's payload, straight off the wire and untrusted — `unknown` in the
 * model for exactly that reason. Twenty-one providers shape their arguments differently and
 * none of them promises these keys. So this reads the shapes that are actually observed and
 * **refuses everything else**, which is §6.1 of the designer brief applied to a string:
 *
 * - `Write · unknown` is a claim that Genie looked and found nothing. The truth is usually
 *   that a provider named its field something else, which is not the row's business.
 * - `Write · {"a":1,"b":{...}}` puts untrusted JSON through a UI and tells the reader less
 *   than the tool's own name already did.
 *
 * Nothing is the honest answer, and the caller renders no separator for it.
 *
 * ## Why a module and not three lines of JSX
 *
 * The interesting behaviour is the refusals, and a refusal inside a `.map()` cannot be
 * asserted without rendering. The type-confusion cases especially: a `file_path` that arrives
 * as a NUMBER would reach the basename split and throw inside a render, taking the transcript
 * with it. That is a test, not a comment.
 */

/** How much of a command a row can carry before it owns the line. */
const MAX = 60;

function cleanString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/** The last segment of a path, with either separator. Windows and POSIX both appear here —
 *  the same Genie reads a `C:\…` path from a local agent and a `/home/…` one from a host. */
function basename(path: string): string | null {
    const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1]! : null;
}

function clamp(value: string): string {
    // A character past the limit, so the ellipsis replaces something rather than being added
    // to a string that already fit.
    return value.length <= MAX ? value : `${value.slice(0, MAX)}…`;
}

export function toolSubject(call: ToolCall): string | null {
    const input = call.rawInput;
    // Arrays are objects to `typeof`, and an array has none of these keys — excluded
    // explicitly so the reads below cannot find an index-named property by accident.
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;

    const record = input as Record<string, unknown>;

    // A FILE first. It is the more specific fact, and a call carrying both a path and a
    // command is describing one operation on that path.
    for (const key of ['file_path', 'filePath', 'path']) {
        const raw = cleanString(record[key]);
        if (raw) {
            const name = basename(raw);
            if (name) return clamp(name);
        }
    }

    // Then the thing being run or looked for, in full — a command's meaning is in its
    // arguments, so unlike a path this is not reduced to its last segment.
    for (const key of ['command', 'pattern', 'query', 'url']) {
        const raw = cleanString(record[key]);
        if (raw) return clamp(raw);
    }

    return null;
}
