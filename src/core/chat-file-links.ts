import { extractFileRefs } from './ask-file-refs.js';

/**
 * A FILE NAMED IN CHAT IS A LINK THAT OPENS IT (the owner, 2026-10-19: "if I click a link to a file in chat it should
 * open that file with the file tree synced").
 *
 * The references are Genie 1's (core/ask-file-refs.ts): a path WITH a separator, optionally `:line`; a bare name is not
 * one (it is ambiguous in an envelope of many repos), and nothing inside a URL is. Each becomes a `#file:<path>[:line]`
 * link — a fragment, which Fancy's sanitising renderer keeps — and the chat opens it in the agent's workspace.
 *
 * Left alone: fenced code blocks (a command line is not a reference), existing Markdown links, and URLs.
 */
const PREFIX = '#file:';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spans of the message that are never rewritten: fenced blocks, existing links, and URLs. */
function protectedSpans(md: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    for (const re of [/```[\s\S]*?(```|$)/g, /\[[^\]]*\]\([^)]*\)/g, /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi]) {
        for (let m = re.exec(md); m; m = re.exec(md)) spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
}

export function linkFileRefs(markdown: string): string {
    if (!markdown) return markdown;
    const spans = protectedSpans(markdown);
    const inside = (from: number, to: number): boolean => spans.some(([a, b]) => from < b && to > a);
    let out = markdown;
    for (const ref of extractFileRefs(markdown)) {
        const token = ref.line ? `${ref.path}:${ref.line}` : ref.path;
        const target = `${PREFIX}${token}`;
        // The reference as written: in a code span (`…`) the whole span becomes the link text; in prose, the token.
        const re = new RegExp(`\`${escapeRe(token)}\`|(?<![\\w/.-])${escapeRe(token)}(?![\\w/-])`, 'g');
        let rebuilt = '';
        let last = 0;
        for (let m = re.exec(out); m; m = re.exec(out)) {
            const from = m.index;
            const to = from + m[0].length;
            if (inside(from, to)) continue;
            rebuilt += out.slice(last, from) + `[${m[0]}](${target})`;
            last = to;
        }
        if (last > 0) {
            out = rebuilt + out.slice(last);
            spans.length = 0;
            spans.push(...protectedSpans(out));
        }
    }
    return out;
}

/** A link's target back as a file and line, or `null` when the link is not a file link. */
export function fileLinkTarget(href: string): { path: string; line: number | null } | null {
    if (!href.startsWith(PREFIX)) return null;
    const rest = decodeURIComponent(href.slice(PREFIX.length));
    const m = /^(.+?):(\d+)$/.exec(rest);
    if (m) return { path: m[1]!, line: Number(m[2]) };
    return rest ? { path: rest, line: null } : null;
}
