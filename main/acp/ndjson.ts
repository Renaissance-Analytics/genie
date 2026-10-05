/**
 * Newline-delimited JSON framing — the transport under ACP.
 *
 * An ACP agent is a child process speaking JSON-RPC over stdin/stdout, one message
 * per line. That is the whole wire format, and it is also the whole class of bug
 * available at this layer: **a pipe delivers whatever arrived.** A message can be
 * split anywhere — mid-object, mid-string, mid-escape — and two can arrive glued
 * together in one chunk.
 *
 * None of those throw. A reader that assumes a chunk is a message silently drops an
 * agent's turn, and the symptom is "the agent went quiet", which is indistinguishable
 * from the agent actually being quiet. That is why the framing is its own tested
 * module rather than four lines inside the client.
 *
 * Splitting on a real newline is correct precisely because JSON escapes the literal
 * one: a newline inside a string value arrives as the two characters `\` and `n`, so
 * it cannot be mistaken for a frame boundary.
 */

/** A chunk this long with no newline in it is not a frame we are waiting for — it is
 *  a stream that will never deliver one. Dropping it beats holding the heap. */
export const MAX_LINE_BYTES = 1_000_000;

export class NdjsonReader {
    private buffer = '';

    constructor(
        private readonly onMessage: (value: unknown) => void,
        /** Reported, never thrown: one bad frame must not end a session whose next
         *  message is still coming. */
        private readonly onError: (message: string) => void,
    ) {}

    push(chunk: string): void {
        this.buffer += chunk;

        if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes('\n')) {
            // Report the shape, not the content: it could be megabytes, and it could
            // be a credential if the child is confused about what it is writing.
            this.onError(
                `ACP frame too long: ${this.buffer.length} bytes with no newline (overflow, buffer dropped)`,
            );
            this.buffer = '';
            return;
        }

        let index = this.buffer.indexOf('\n');
        while (index !== -1) {
            // `\r` trimmed so a CRLF stream's error messages and blank-line check see
            // the line a human would. NOT for parsing: `JSON.parse` treats a trailing
            // carriage return as whitespace and accepts it — measured, because an
            // earlier version of this comment claimed the opposite and a mutation
            // proved it wrong by removing the trim with every test still green.
            const line = this.buffer.slice(0, index).replace(/\r$/, '');
            this.buffer = this.buffer.slice(index + 1);

            // Agents pad. A blank line is not a malformed message.
            if (line.trim() !== '') {
                try {
                    this.onMessage(JSON.parse(line) as unknown);
                } catch (err) {
                    // Keep reading. The rest of this chunk may hold good frames, and
                    // the next one certainly might.
                    this.onError(
                        `ACP frame is not JSON: ${line.slice(0, 200)} (${(err as Error).message})`,
                    );
                }
            }

            index = this.buffer.indexOf('\n');
        }
    }
}

/** One message, one line. `JSON.stringify` escapes any newline in a value, so the
 *  only newline in the result is the terminator — emitting a raw one would split one
 *  message into two frames and make the second unparseable. */
export function encodeNdjson(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}
