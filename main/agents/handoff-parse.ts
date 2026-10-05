/**
 * Turn a rendered handoff note back into the two facts a surface needs.
 *
 * The handoff is the best "what happened while I was away" artifact Genie has —
 * real prose an agent wrote about what it did and what it left undone — and
 * nothing human-facing has ever read one. `readHandoff` has no production caller
 * at all: the note is written on every `imDone` and then sits in `.ai/handoff/`
 * unread. Showing it means recovering the agent's words (without the chrome this
 * repo wrapped them in) and the time it wrote them.
 *
 * ## Deliberately tolerant, because the file is a human's too
 *
 * `renderHandoff` calls its output "plain markdown a human can read and edit", so
 * a note with the heading deleted, the byline removed, or the whole thing
 * rewritten by hand is a SUPPORTED shape rather than corruption. The parser's job
 * is to find prose, not to validate a format.
 *
 * What it will not do is guess. An unreadable or absent timestamp comes back as
 * `null`, never as `Date.now()` — dating a month-old note to now would sort it to
 * the top of a transcript and tell somebody their agent just finished. A caller
 * that needs a time for ordering should fall back to the file's own mtime, which
 * is at least a real fact about the file.
 *
 * Pure and fs-free: the read lives in `./handoff`, the decision lives here.
 */

export interface ParsedHandoff {
    /** The agent's own words, with this repo's heading and byline stripped. */
    text: string;
    /** ms epoch, or null when the note does not say. */
    at: number | null;
}

/** Matches the byline `renderHandoff` writes. Anchored to the line so a `_` in
 *  the note body cannot be mistaken for it. */
const BYLINE = /^_Left at (.+?) by the previous run of this agent\._$/;

/** Matches the heading `renderHandoff` writes. The name may contain anything,
 *  including an em dash, so nothing beyond the prefix is interpreted. */
const HEADING = /^# Handoff — /;

export function parseHandoff(markdown: string | null | undefined): ParsedHandoff | null {
    if (!markdown || markdown.trim() === '') return null;

    // Split on \n after normalising \r\n: these files are written by Genie but
    // edited by whatever the owner opened them in, and a CRLF note must not come
    // back with a stray \r on every line. (Source guards in this repo have been
    // bitten by exactly this — see genie#517.)
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');

    let at: number | null = null;
    const body: string[] = [];

    for (const line of lines) {
        if (HEADING.test(line)) continue;

        const byline = BYLINE.exec(line.trim());
        if (byline) {
            const parsed = Date.parse(byline[1]);
            // An unparseable date is NOT a reason to drop the note — the prose is
            // the valuable half. It is a reason to admit we do not know when.
            at = Number.isNaN(parsed) ? null : parsed;
            continue;
        }

        body.push(line);
    }

    const text = body.join('\n').trim();
    // Chrome with no prose means the same thing on the way in as it does on the way
    // out: `writeHandoff` refuses to write an empty note because it "looks like the
    // previous run had nothing to report".
    if (text === '') return null;

    return { text, at };
}
