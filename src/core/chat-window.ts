/**
 * THE CHAT'S LIVE WINDOW (the owner, 2026-10-22: "history should buffer with only the last 500 lines present when
 * Following Live").
 *
 * The chat used to draw every message of an agent's history as Markdown DOM and redraw it on each push. Now it draws
 * the messages that make up the last `CHAT_LIVE_LINES` lines of the thread; the rest stays in memory and pages in,
 * another `CHAT_LIVE_LINES` at a time, when the person asks for earlier messages. Lines, not messages: one long reply is
 * worth more of the window than a one-line "ok". Whole messages always — the window never cuts a message in half, and
 * the newest message is drawn however long it is.
 */

/** How many lines of the thread are in the DOM while Following Live, and how many each page of history adds. */
export const CHAT_LIVE_LINES = 500;

/** A message's lines: its text's, at least one (an empty or attachment-only message still takes a row). */
export function messageLines(m: { readonly text: string }): number {
    let n = 1;
    const t = m.text;
    for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) n += 1;
    return n;
}

/**
 * Where the window starts: the index of the first message drawn, so that the messages from there to the end hold at
 * least `lines` lines — or everything, when the thread holds fewer. Walks back from the end only as far as it needs,
 * so its cost is the window's, not the history's.
 */
export function chatWindowStart(messages: readonly { readonly text: string }[], lines: number): number {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        seen += messageLines(messages[i]!);
        if (seen >= lines) return i;
    }
    return 0;
}
