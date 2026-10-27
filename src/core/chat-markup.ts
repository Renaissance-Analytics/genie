import { fileLinkTarget, linkFileRefs } from './chat-file-links.js';

/**
 * CHAT MARKUP (genie#1263; the owner: "Add copy block support to Genie's chat … we need to use [moic's markup] in Genie
 * to make it easier for agents to communicate with humans and give them content they need to take somewhere else").
 *
 * The vocabulary is moic's own (MOIC-Partners/suite, `resources/prompts/rules/custom-tags.md` and
 * `app/Services/ChatRenderService.php`), adapted to what Genie actually has:
 *
 * - every fenced code block gets a copy button, and every Markdown table a copy-as-TSV button (moic's `injectCopyButtons`)
 *   — react-fancy's own since 5.67.0 (ContentRenderer `copyButtons`, on by default);
 * - `<result>…</result>` — a card for content the person carries elsewhere, copied RICH (`core/chat-copy.ts`);
 * - `<highlight>…</highlight>` — a one-level callout; `<followup>…</followup>` — one closing question;
 * - `[type:id|label]` pills and `[go:kind:id]` destinations — ONLY `file` (in the chat's workspace), `agent` and
 *   `workspace`. Anything else is dropped: a pill keeps its words, a destination disappears (moic's chat-links.md: "A
 *   token the reader cannot open renders as nothing").
 *
 * moic's lessons, kept: the model never authors interactive UI (`stripForbiddenTags`); a model-written URL is never a
 * navigation into Genie (`stripInternalLinks`); a reply still arriving never flashes a half-written tag (`streamSafe`).
 *
 * Every function here is pure and string-to-string, so the whole pipeline is proved without a DOM. react-fancy draws the
 * result (ChatProse): `liftChatBlocks` hands it the blocks in the shape it lifts.
 */

export interface ChatRefs {
    /** Files can be opened: the chat has a workspace to open them in. */
    readonly files: boolean;
    /** Agents a pill may open, by id or by name. Empty = agent pills are words. */
    readonly agents: readonly { readonly id: string; readonly name: string }[];
    /** Workspaces a pill may open, by id or by name. Empty = workspace pills are words. */
    readonly workspaces: readonly { readonly id: string; readonly name: string }[];
}

export const NO_REFS: ChatRefs = { files: false, agents: [], workspaces: [] };

/**
 * The agents and workspaces a pill may name, from the snapshot, with a KEY that changes only when an id or a name does —
 * so the chat can keep one object across pushes and a memoised reply does not re-render its Markdown on every one.
 */
export function chatRefLists(
    agents: readonly { id: string; name: string }[],
    workspaces: readonly { id: string; name?: string | null | undefined }[],
): { key: string; agents: ChatRefs['agents']; workspaces: ChatRefs['workspaces'] } {
    const a = agents.map(({ id, name }) => ({ id, name }));
    const w = workspaces.map(({ id, name }) => ({ id, name: name || id }));
    return { key: JSON.stringify([a, w]), agents: a, workspaces: w };
}

export type ChatLinkTarget =
    | { kind: 'file'; path: string; line: number | null }
    | { kind: 'agent'; id: string }
    | { kind: 'workspace'; id: string };

type Span = readonly [number, number];

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Fenced code blocks, line by line — an unclosed fence runs to the end (a reply still arriving). */
function fenceSpans(md: string): Span[] {
    return fences(md).spans;
}

function fences(md: string): { spans: Span[]; open: string | null } {
    const spans: Span[] = [];
    let at = 0;
    let open: { from: number; fence: string } | null = null;
    for (const line of md.split('\n')) {
        const end = at + line.length;
        if (open) {
            const close = new RegExp(`^ {0,3}${open.fence[0] === '`' ? '`' : '~'}{${open.fence.length},}\\s*$`);
            if (close.test(line)) { spans.push([open.from, end]); open = null; }
        } else {
            const m = FENCE_OPEN.exec(line);
            if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) open = { from: at, fence: m[1]! };
        }
        at = end + 1;
    }
    if (open) spans.push([open.from, md.length]);
    return { spans, open: open?.fence ?? null };
}

/** Fences, then inline code spans outside them: the places where a tag or a pill is CODE, not markup. */
function codeSpans(md: string, links = false): Span[] {
    const spans = fenceSpans(md);
    const inFence = (i: number) => spans.some(([a, b]) => i >= a && i < b);
    const res = [/``[^\n]+?``|`[^`\n]+`/g];
    if (links) res.push(/\[[^\]\n]*\]\([^)\n]*\)/g);
    for (const re of res) {
        for (let m = re.exec(md); m; m = re.exec(md)) if (!inFence(m.index)) spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
}

/** Apply `fn` to every stretch of `md` that is NOT code (and, with `links`, not an existing Markdown link). */
function outsideCode(md: string, fn: (text: string) => string, links = false): string {
    const spans = [...codeSpans(md, links)].sort((a, b) => a[0] - b[0]);
    let out = '';
    let at = 0;
    for (const [a, b] of spans) {
        if (a < at) { at = Math.max(at, b); continue; }
        out += fn(md.slice(at, a)) + md.slice(a, b);
        at = b;
    }
    return out + fn(md.slice(at));
}

/**
 * A REPLY STILL ARRIVING: hold back whatever is half-written at its end — a tag whose `>` has not come yet (`<resul`,
 * `</result`, `<highlight cl`) and a pill whose `]` has not (`[file:src/co`). An open block or fence is fine as it is:
 * the parser draws it as its card or code block, filling in. Complete text is returned exactly as it was.
 *
 * Not react-fancy's `streaming` (5.67.0): it holds back an open block or fence ENTIRELY until it closes — #1277's card and
 * code block fill in as they arrive instead — it knows nothing of pills, and it needs to be told when a reply has
 * finished, which ChatProse is not (a reply is its text; a finished one that ends oddly would never render whole).
 */
export function streamSafe(md: string): string {
    if (!md) return md;
    // Ends inside an open fence: what arrives is code, and a `<` in code is not a tag.
    if (fences(md).open !== null) return md;
    return md
        .replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?$|<\/?$/, '')
        .replace(/\[[A-Za-z][\w-]*:[^\]\n]*$/, '');
}

/**
 * A MODEL NEVER AUTHORS INTERACTIVE OR APPROVAL UI (moic: `ApprovalCards::strip`, `approvalStream.js`). A button, a form
 * control or anything shaped like an approval or a permission card is removed WITH its content — an "Approve" floating
 * where a button was is the same lie in words. Shown as code, the same tags are kept.
 */
const FORBIDDEN = String.raw`button|form|input|select|option|optgroup|textarea|fieldset|dialog|menu|script|style|iframe|frame|frameset|object|embed|template|question|questions|confirm|approve|tool-button|compass-[\w-]+|[\w-]*approval[\w-]*|[\w-]*permission[\w-]*`;
const FORBIDDEN_PAIR = new RegExp(`<(${FORBIDDEN})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const FORBIDDEN_TAG = new RegExp(`<\\/?(?:${FORBIDDEN})\\b[^>]*>`, 'gi');

export function stripForbiddenTags(md: string): string {
    if (!md || !md.includes('<')) return md;
    return outsideCode(md, (text) => {
        let out = text;
        for (let prev = ''; prev !== out;) { prev = out; out = out.replace(FORBIDDEN_PAIR, ''); }
        return out.replace(FORBIDDEN_TAG, '');
    });
}

/**
 * A MODEL-WRITTEN URL NEVER NAVIGATES INSIDE GENIE. Links into Genie are made by Genie from a pill it resolved; a link
 * the model wrote to `genie://…` or to a `#fragment` (which is how Genie's own links look) keeps its words and loses its
 * target. A web link is left alone: it is not a navigation into Genie.
 */
export function stripInternalLinks(md: string): string {
    if (!md) return md;
    return outsideCode(md, (text) => text
        .replace(/\[([^\]\n]*)\]\(\s*<?(?:#|genie:)[^)\n]*\)/gi, '$1')
        .replace(/<(genie:[^>\s]+)>/gi, '$1')
        .replace(/<a\b[^>]*\bhref\s*=\s*["']?\s*(?:#|genie:)[^>]*>([\s\S]*?)<\/a\s*>/gi, '$1')
        .replace(/^ {0,3}\[[^\]\n]+\]:\s*<?(?:#|genie:)\S*.*$/gim, ''));
}

const PREFIX = { file: '#file:', agent: '#agent:', workspace: '#workspace:' } as const;

/** A path inside the workspace: relative, no `..`, no scheme or drive. */
function workspacePath(id: string): string | null {
    const path = id.trim();
    if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || /^[\\/]/.test(path)) return null;
    if (path.split(/[\\/]/).some((part) => part === '..')) return null;
    return path;
}

const encodePath = (p: string) => p.split('').map((c) => (c === '/' || c === ':' ? c : encodeURIComponent(c))).join('');
const linkText = (s: string) => s.replace(/([[\]\\])/g, '\\$1');

function find(list: ChatRefs['agents'], key: string) {
    const k = key.trim();
    return list.find((x) => x.id === k) ?? list.find((x) => x.name.toLowerCase() === k.toLowerCase()) ?? null;
}

/** A destination resolved: its Genie link and the record's own name — or `null`, Genie has nowhere to open it. */
function resolve(kind: string, id: string, refs: ChatRefs): { href: string; name: string } | null {
    switch (kind.toLowerCase()) {
        case 'file': {
            const path = refs.files ? workspacePath(id) : null;
            if (!path) return null;
            const bare = path.replace(/:\d+$/, '');
            return { href: PREFIX.file + encodePath(path), name: bare.split(/[\\/]/).pop() || bare };
        }
        case 'agent': {
            const a = find(refs.agents, id);
            return a ? { href: PREFIX.agent + encodeURIComponent(a.id), name: a.name } : null;
        }
        case 'workspace': {
            const w = find(refs.workspaces, id);
            return w ? { href: PREFIX.workspace + encodeURIComponent(w.id), name: w.name } : null;
        }
        default:
            return null;
    }
}

/**
 * PILLS AND DESTINATIONS. `[type:id|label]` (moic's inline pill: the id is authoritative, the label is display only) and
 * `[go:kind:id]` (moic's destination: the model names the record, the app labels it). Resolved against what Genie can
 * open; an unknown pill keeps its label as plain words and an unknown destination disappears. Never inside code or an
 * existing Markdown link.
 */
export function linkChatRefs(md: string, refs: ChatRefs): string {
    if (!md || !md.includes('[')) return md;
    return outsideCode(md, (text) => text.replace(
        /\[go:([A-Za-z][\w-]*)(?::([^\]\n]+))?\](?!\()|\[([A-Za-z][\w-]*):([^\]|\n]+)\|([^\]\n]+)\](?!\()/g,
        (_all, goKind?: string, goId?: string, kind?: string, id?: string, label?: string) => {
            if (goKind !== undefined) {
                const hit = goId ? resolve(goKind, goId, refs) : null;
                return hit ? `[${linkText(hit.name)}](${hit.href})` : '';
            }
            const hit = resolve(kind!, id!, refs);
            return hit ? `[${linkText(label!.trim())}](${hit.href})` : label!.trim();
        },
    ), true);
}

/** A Genie link read back: what to open. Anything else (a web link, a plain `#section`) is `null`. */
export function chatLinkTarget(href: string): ChatLinkTarget | null {
    if (!href) return null;
    if (href.startsWith(PREFIX.file)) {
        const f = fileLinkTarget(href);
        return f ? { kind: 'file', ...f } : null;
    }
    for (const kind of ['agent', 'workspace'] as const) {
        if (href.startsWith(PREFIX[kind])) {
            const id = decodeURIComponent(href.slice(PREFIX[kind].length));
            return id ? { kind, id } : null;
        }
    }
    return null;
}

/**
 * The whole pipeline, in the order that keeps it safe: hold back a half-written tail, remove forbidden UI, strip the
 * model's own internal links, THEN add Genie's (pills, then file references in prose — `core/chat-file-links.ts`).
 */
export function prepareChatMarkdown(md: string, refs: ChatRefs = NO_REFS): string {
    let out = streamSafe(md ?? '');
    out = stripForbiddenTags(out);
    out = stripInternalLinks(out);
    out = linkChatRefs(out, refs);
    return refs.files ? linkFileRefs(out) : out;
}

const BLOCKS = ['result', 'highlight', 'followup'] as const;
type Block = (typeof BLOCKS)[number];
const TAG = /<(\/?)(result|highlight|followup)(?:\s[^<>]*)?>/gi;

/** Trim blank lines at either end, never the indentation of the first line (it may be Markdown's). */
const trimLines = (s: string) => s.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '').replace(/^[ \t]+$/, '');

interface TagHit { index: number; end: number; close: boolean; name: Block }

function tagsOutsideCode(md: string): TagHit[] {
    const spans = codeSpans(md);
    const inCode = (i: number) => spans.some(([a, b]) => i >= a && i < b);
    const hits: TagHit[] = [];
    TAG.lastIndex = 0;
    for (let m = TAG.exec(md); m; m = TAG.exec(md)) {
        if (!inCode(m.index)) hits.push({ index: m.index, end: m.index + m[0].length, close: m[1] === '/', name: m[2]!.toLowerCase() as Block });
    }
    return hits;
}

/** Stray block tags (a close with no open, or a tag inside a block) lose the tag and keep the words. */
function stripBlockTags(md: string): string {
    if (!md.includes('<')) return md;
    return outsideCode(md, (t) => t.replace(TAG, ''));
}

/**
 * GENIE'S BLOCK RULES, IN THE SHAPE REACT-FANCY LIFTS. `<result>`, `<highlight>` and `<followup>` are react-fancy
 * `markdown: true` extensions (ChatProse): fancy lifts such a tag out of the Markdown and renders its body — but only when
 * the opening tag STARTS A LINE and has a matching close, and it nests them up to depth 8. Genie's rules (#1277) differ,
 * so the text is rewritten first:
 *
 * - a block may start mid-line (`Ready. <result>…`) — it is put on lines of its own;
 * - a block still arriving has no close yet — it is closed (and an open fence in it first), so its card fills in;
 * - ONE level: a block tag inside a block loses its tag and keeps its words; a stray close does too;
 * - case-insensitive, never inside code; attributes are not carried (Genie's blocks take none).
 *
 * Text with no block tag is returned exactly as it was. Code blocks and tables are left alone: they are fancy's.
 */
export function liftChatBlocks(md: string): string {
    const text = md ?? '';
    const hits = tagsOutsideCode(text);
    if (hits.length === 0) return text;
    const parts: string[] = [];
    const prose = (s: string) => { const t = trimLines(stripBlockTags(s)); if (t.trim() !== '') parts.push(t); };
    let at = 0;
    let i = 0;
    while (i < hits.length) {
        const open = hits[i]!;
        if (open.close) { i += 1; continue; }
        // Its matching close, counting nested opens of the same name.
        let nest = 0;
        let close: TagHit | null = null;
        let j = i + 1;
        for (; j < hits.length; j += 1) {
            const h = hits[j]!;
            if (h.name !== open.name) continue;
            if (!h.close) nest += 1;
            else if (nest === 0) { close = h; break; }
            else nest -= 1;
        }
        prose(text.slice(at, open.index));
        let body = trimLines(stripBlockTags(text.slice(open.end, close ? close.index : text.length)));
        // Still arriving inside a fence: close the fence, or the block's own close would be code.
        const fence = close ? null : fences(body).open;
        if (fence !== null) body += `\n${fence}`;
        parts.push(`<${open.name}>\n${body}\n</${open.name}>`);
        at = close ? close.end : text.length;
        i = close ? j + 1 : hits.length;
        while (i < hits.length && hits[i]!.index < at) i += 1;
    }
    prose(text.slice(at));
    return parts.join('\n\n');
}
