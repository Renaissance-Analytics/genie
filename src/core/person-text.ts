/**
 * NO INTERNAL IDS IN FRONT OF THE PERSON (Tynn #696; the owner, 2026-11-13: "make sure we aren't showing agent ids in any
 * ui" — over a chat mail card reading "Answer to your question q_90ef0195-4818-43f9-9273-3442f387948c: E-sign — …").
 *
 * Agents need ids: the FTQ answer mail says which question it answers (`Answer to your question q_…:`, written by
 * main/attention-store.ts), and agents address each other by them. So the DATA keeps them; the person's VIEW of it does not.
 * Every surface that draws free text a person reads (chat and mail cards and their previews, the Deck, the AgentInbox
 * flyout, toasts, the mobile UI) passes it through `personText` at render.
 *
 * What counts as an id here — the shapes Genie mints, and the ones it relays:
 *  - a lowercase prefix and `_`, then a UUID or 8+ hex characters: `agent_<32 hex>`, `q_<uuid>`, `msg_<uuid>`, `flow_…`,
 *    `conn_…`, `run_…`, and their shortened forms (`q_e07a0573…`);
 *  - a bare UUID;
 *  - a ULID (26 Crockford base32 characters; a workspace's id is one).
 *
 * What is NOT touched: a Markdown link's TARGET (`](…)`) and a bare URL — not drawn as text, and the way an in-app link
 * reaches its agent. Anything else is the person's reading, ids removed: `Answer to your question q_…:` reads `Answer to
 * your question:`, `(Your question q_….)` reads `(Your question.)`.
 */

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ID_SOURCE = `\\b(?:[a-z][a-z0-9]{0,11}_(?:${UUID}|[0-9a-fA-F]{8,})|${UUID}|[0-7][0-9A-HJKMNP-TV-Z]{25})\\b(?:…|\\.\\.\\.)?`;

/** Every id-shaped string in `text` (the guard's reading of what a person would see). */
export function idsIn(text: string): string[] {
    return [...(text ?? '').matchAll(new RegExp(ID_SOURCE, 'g'))].map((m) => m[0]);
}

/** What a person never reads, so ids are left alone there: link targets and bare URLs. */
const KEEP = /\]\([^)\n]*\)|https?:\/\/[^\s<>)\]]+/g;

/** Where an id was: the tidying below only ever touches what an id left behind, never the rest of the text. */
const GONE = '\u0000';

function stripIds(text: string): string {
    return text
        .replace(new RegExp(`[ \\t]*${ID_SOURCE}`, 'g'), GONE)
        // An id in backticks or brackets leaves no empty code span or brackets.
        .replace(new RegExp(`\`${GONE}\`|\\(${GONE}\\)`, 'g'), GONE)
        // An address whose workspace was an id: `bolt@` reads `bolt`.
        .replace(new RegExp(`(\\w)@${GONE}`, 'g'), `$1${GONE}`)
        // At a line's start, or between two spaces, the id takes one space with it.
        .replace(new RegExp(`(^|\\n)${GONE}[ \\t]*`, 'g'), '$1')
        .replace(new RegExp(`\\([ \\t]*${GONE}[ \\t]*`, 'g'), '(')
        .replace(new RegExp(`[ \\t]${GONE}(?=[ \\t])`, 'g'), '')
        .replace(new RegExp(GONE, 'g'), '');
}

/** `text` as the person reads it: every internal id removed, link targets and URLs untouched. */
export function personText(text: string): string;
export function personText(text: string | null | undefined): string | null | undefined;
export function personText(text: string | null | undefined): string | null | undefined {
    if (!text || idsIn(text).length === 0) return text;
    let out = '';
    let at = 0;
    for (const m of text.matchAll(KEEP)) {
        out += stripIds(text.slice(at, m.index)) + m[0];
        at = m.index! + m[0].length;
    }
    return out + stripIds(text.slice(at));
}
