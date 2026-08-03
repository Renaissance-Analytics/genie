/**
 * YAML front matter — the `---` block a markdown file can carry above its body
 * (`.md`, `.markdown`, and Cursor's `.mdc` rules, which lean on it for
 * `description` / `globs` / `alwaysApply`).
 *
 * Genie's markdown editor is react-fancy's `Editor`, a WYSIWYG whose model is
 * the markdown STRING — hand it a front-matter block and it renders the YAML as
 * prose and rewrites it on the first keystroke. So the split happens HERE, in
 * genie-side chrome: parse the file, feed the BODY to the editor, manage the
 * block in the fm pill + drawer, and recombine on save.
 *
 * Everything in this module is PURE — no DOM, no fs, no React. That is what
 * makes the round trip testable, and the round trip is the whole promise:
 *
 *     joinFrontMatter(p, p.frontMatter, p.body) === original   // byte for byte
 *
 * for EVERY input, including CRLF files, a BOM, fences with trailing spaces,
 * comments inside the block, and files that merely open with a horizontal rule.
 * Opening a document must never rewrite bytes nobody touched.
 *
 * Two layers:
 *   1. `parseFrontMatter` / `joinFrontMatter` — the block ⇄ body split.
 *   2. `parseFrontMatterFields` + the surgical `set/rename/remove` editors —
 *      the flat key→value view the drawer renders. They are LINE-oriented on
 *      purpose: only the key you edit is re-emitted, so comments, key order and
 *      hand-formatting elsewhere in the block survive untouched. Anything the
 *      flat view cannot represent (nested maps, block literals) is reported as
 *      `complex` and left to the drawer's raw-YAML mode.
 */

const BOM = '﻿';

/** A file's front-matter block, its body, and the bytes needed to rebuild it. */
export interface ParsedFrontMatter {
    /**
     * The YAML BETWEEN the fences with LF line endings and no trailing break —
     * `''` for an empty block, `null` when the file carries no block at all.
     */
    frontMatter: string | null;
    /** Everything after the closing fence, verbatim (original line endings). */
    body: string;
    /**
     * Every byte before `body`: the BOM, both fences and the YAML exactly as
     * they were written. Replaying it is what keeps an untouched file stable.
     */
    prefix: string;
    /** The UTF-8 BOM when the file leads with one, else `''`. */
    bom: string;
    /** The file's first line ending — what a rewritten block is written with. */
    eol: '\n' | '\r\n';
}

/** Does this file type carry front matter? `.docx` is markdown-shaped but binary. */
export function supportsFrontMatter(file: string): boolean {
    return /\.(md|markdown|mdc)$/i.test(file);
}

function detectEol(text: string): '\n' | '\r\n' {
    return /\r?\n/.exec(text)?.[0] === '\r\n' ? '\r\n' : '\n';
}

/** A fence line: `---`, optional trailing blanks, terminated or at EOF. */
const FENCE = /^---[ \t]*\r?\n?$/;
const OPEN_FENCE = /^---[ \t]*\r?\n/;

/**
 * Split `text` into its front-matter block and body.
 *
 * A block only counts when the file OPENS with the fence (line 1, BOM aside)
 * and a second fence closes it. An unclosed `---`, or one further down the
 * document, is an ordinary horizontal rule and stays in the body.
 */
export function parseFrontMatter(text: string): ParsedFrontMatter {
    const bom = text.startsWith(BOM) ? BOM : '';
    const rest = text.slice(bom.length);
    const eol = detectEol(text);

    const open = OPEN_FENCE.exec(rest);
    if (!open) return { frontMatter: null, body: rest, prefix: bom, bom, eol };

    let i = open[0].length;
    let closeStart = -1;
    let closeEnd = -1;
    while (i < rest.length) {
        const nl = rest.indexOf('\n', i);
        const lineEnd = nl === -1 ? rest.length : nl + 1;
        if (FENCE.test(rest.slice(i, lineEnd))) {
            closeStart = i;
            closeEnd = lineEnd;
            break;
        }
        i = lineEnd;
    }
    // Opened but never closed — a rule, not a block.
    if (closeStart === -1) return { frontMatter: null, body: rest, prefix: bom, bom, eol };

    const inner = rest.slice(open[0].length, closeStart);
    return {
        frontMatter: inner.replace(/\r?\n$/, '').replace(/\r\n/g, '\n'),
        body: rest.slice(closeEnd),
        prefix: bom + rest.slice(0, closeEnd),
        bom,
        eol,
    };
}

function fenceBlock(yaml: string, eol: '\n' | '\r\n'): string {
    if (yaml === '') return `---${eol}---${eol}`;
    return `---${eol}${yaml.replace(/\r?\n/g, eol)}${eol}---${eol}`;
}

/**
 * Put a (possibly edited) block back on top of a (possibly edited) body.
 *
 * Handing back what `parseFrontMatter` produced returns the ORIGINAL bytes —
 * the block is replayed from `prefix`, quirks and all, never re-serialised.
 * Only a genuine change to the YAML rewrites the block, and then in the file's
 * own line endings. The two transitions get one cosmetic rule each so the
 * document does not gain or keep a stray blank first line: adding a block to a
 * document that had none separates them with one blank line, and removing the
 * last key takes the block's trailing blank line with it.
 */
export function joinFrontMatter(
    parsed: ParsedFrontMatter,
    frontMatter: string | null,
    body: string,
): string {
    if (frontMatter === parsed.frontMatter) return parsed.prefix + body;
    if (frontMatter === null) return parsed.bom + body.replace(/^\r?\n/, '');

    const block = fenceBlock(frontMatter, parsed.eol);
    if (parsed.frontMatter !== null) return parsed.bom + block + body;
    const gap = body === '' || /^\r?\n/.test(body) ? '' : parsed.eol;
    return parsed.bom + block + gap + body;
}

// --- the flat key→value view ------------------------------------------------

/**
 * How much of a key's YAML the structured editor can show. `complex` is the
 * honest answer for nested maps and block literals — the drawer offers raw
 * YAML for those rather than flattening something it cannot put back.
 */
export type FmFieldKind = 'string' | 'number' | 'boolean' | 'null' | 'list' | 'complex';

export interface FmField {
    key: string;
    kind: FmFieldKind;
    /** Scalars: the decoded text. `list` and `complex`: `''`. */
    value: string;
    /** `list` only: the decoded items, in order. */
    items?: string[];
    /** The verbatim source lines this key occupies. */
    raw: string;
}

export interface FmModel {
    fields: FmField[];
    /**
     * `false` when the block holds top-level YAML the key list cannot represent
     * — a sequence, a bare scalar, an anchor. The drawer then opens in raw mode
     * and structured editing is off rather than silently dropping content.
     */
    structured: boolean;
}

/** The value the drawer writes back for one key. */
export type FmFieldValue =
    | { kind: 'string' | 'number' | 'boolean' | 'null'; value: string }
    | { kind: 'list'; items: string[] };

/**
 * A top-level `key: value` line. Leading whitespace, `#` and `-` are excluded
 * so continuation lines, comments and sequence items can never be mistaken for
 * a key. The value group is absent for a bare `key:`.
 */
const KEY_LINE = /^(?![\s#-])("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#]+?)[ \t]*:(?:[ \t]+(.*))?$/;

const SEQ_ITEM = /^[ \t]*-(?:[ \t]+(.*))?$/;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const BOOLEAN = /^(?:true|false)$/i;
const NULLISH = /^(?:null|~)$/i;

function unquote(token: string): string {
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
        return token
            .slice(1, -1)
            .replace(/\\(["\\/])|\\n|\\r|\\t/g, (m, c) =>
                c ? c : m === '\\n' ? '\n' : m === '\\r' ? '\r' : '\t',
            );
    }
    if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
        return token.slice(1, -1).replace(/''/g, "'");
    }
    return token;
}

/** Split a flow sequence's inside (`a, "b, c"`) on commas that are not quoted. */
function splitFlow(inner: string): string[] {
    const out: string[] = [];
    let buf = '';
    let quote: '"' | "'" | null = null;
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (quote) {
            buf += c;
            if (c === '\\' && quote === '"') {
                buf += inner[++i] ?? '';
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            buf += c;
        } else if (c === '[' || c === '{') {
            depth++;
            buf += c;
        } else if (c === ']' || c === '}') {
            depth--;
            buf += c;
        } else if (c === ',' && depth === 0) {
            out.push(buf);
            buf = '';
        } else {
            buf += c;
        }
    }
    if (buf.trim() !== '') out.push(buf);
    return out.map((s) => s.trim());
}

/** Strip an unquoted scalar's trailing ` # comment`; quoted scalars keep theirs. */
function stripComment(raw: string): string {
    const v = raw.trimEnd();
    if (v.startsWith('"') || v.startsWith("'")) return v;
    return v.replace(/[ \t]+#.*$/, '').trimEnd();
}

function decodeScalar(token: string): { kind: FmFieldKind; value: string } {
    const v = stripComment(token);
    if (v === '' || NULLISH.test(v)) return { kind: 'null', value: '' };
    if (v.startsWith('"') || v.startsWith("'")) return { kind: 'string', value: unquote(v) };
    if (BOOLEAN.test(v)) return { kind: 'boolean', value: v.toLowerCase() };
    if (NUMBER.test(v)) return { kind: 'number', value: v };
    return { kind: 'string', value: v };
}

/** Is this line part of the value that started on a preceding key line? */
function isContinuation(line: string): boolean {
    return /^[ \t]/.test(line) || SEQ_ITEM.test(line);
}

/** The last line of the value that starts on the key line at `start`. */
function spanEnd(lines: string[], start: number): number {
    let end = start;
    for (let j = start + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() === '') continue; // tentative — only kept if more follows
        if (!isContinuation(l)) break;
        end = j;
    }
    return end;
}

/** The line span `key` owns, or null when the block has no such top-level key. */
function locateField(lines: string[], key: string): { start: number; end: number } | null {
    for (let i = 0; i < lines.length; i++) {
        const m = KEY_LINE.exec(lines[i]!);
        if (!m || unquote(m[1]!.trim()) !== key) continue;
        return { start: i, end: spanEnd(lines, i) };
    }
    return null;
}

/** Read a front-matter block as the flat key→value list the drawer renders. */
export function parseFrontMatterFields(yaml: string): FmModel {
    const lines = yaml.split('\n');
    const fields: FmField[] = [];
    let structured = true;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim() === '' || /^[ \t]*#/.test(line)) continue;

        const m = KEY_LINE.exec(line);
        if (!m) {
            structured = false;
            continue;
        }

        // Span from THIS line, not from `locateField` — a block that repeats a
        // key would otherwise resolve every occurrence to the first one and
        // walk the cursor backwards forever.
        const end = spanEnd(lines, i);
        const rest = lines.slice(i + 1, end + 1).filter((l) => l.trim() !== '');
        const inline = (m[2] ?? '').trim();

        let kind: FmFieldKind;
        let value = '';
        let items: string[] | undefined;

        if (inline.startsWith('[') && inline.endsWith(']')) {
            kind = 'list';
            items = splitFlow(inline.slice(1, -1)).map((s) => decodeScalar(s).value);
        } else if (inline.startsWith('{') || /^[|>][-+]?\d*$/.test(inline)) {
            kind = 'complex';
        } else if (inline !== '') {
            const dec = decodeScalar(inline);
            kind = dec.kind;
            value = dec.value;
        } else if (rest.length > 0 && rest.every((l) => SEQ_ITEM.test(l))) {
            kind = 'list';
            items = rest.map((l) => decodeScalar(SEQ_ITEM.exec(l)![1] ?? '').value);
        } else if (rest.length > 0) {
            kind = 'complex';
        } else {
            kind = 'null';
        }

        fields.push({
            key: unquote(m[1]!.trim()),
            kind,
            value,
            ...(items ? { items } : {}),
            raw: lines.slice(i, end + 1).join('\n'),
        });
        i = end;
    }

    return { fields, structured };
}

function needsQuoting(s: string): boolean {
    if (s === '') return true;
    if (/^\s|\s$/.test(s)) return true;
    if (/[\n\r\t]/.test(s)) return true;
    if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
    if (/:\s/.test(s) || s.endsWith(':')) return true;
    if (/\s#/.test(s)) return true;
    return BOOLEAN.test(s) || NULLISH.test(s) || NUMBER.test(s);
}

/** Encode a string so YAML reads it back as the same string. */
function encodeScalar(s: string): string {
    if (!needsQuoting(s)) return s;
    const escaped = s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    return `"${escaped}"`;
}

function encodeKey(key: string): string {
    const plain = /^(?![\s#-])[^:#]+$/.test(key) && key === key.trim();
    return plain ? key : `"${key.replace(/"/g, '\\"')}"`;
}

/** Render one key as the YAML line(s) it occupies. */
function encodeField(key: string, v: FmFieldValue): string[] {
    const k = encodeKey(key);
    if (v.kind === 'list') {
        if (v.items.length === 0) return [`${k}: []`];
        return [`${k}:`, ...v.items.map((it) => `  - ${encodeScalar(it)}`)];
    }
    if (v.kind === 'null') return [`${k}: null`];
    if (v.kind === 'boolean') return [`${k}: ${v.value === 'true' ? 'true' : 'false'}`];
    if (v.kind === 'number') return [`${k}: ${v.value.trim()}`];
    return [`${k}: ${encodeScalar(v.value)}`];
}

/**
 * Set `key` to `value`, replacing the key's existing line span in place or
 * appending it when the key is new. Every other line is untouched.
 */
export function setFrontMatterField(yaml: string, key: string, value: FmFieldValue): string {
    const encoded = encodeField(key, value);
    if (yaml.trim() === '') return encoded.join('\n');

    const lines = yaml.split('\n');
    const span = locateField(lines, key);
    if (!span) return [...lines, ...encoded].join('\n');
    lines.splice(span.start, span.end - span.start + 1, ...encoded);
    return lines.join('\n');
}

/**
 * Rename a key, keeping its value — including a multi-line one — exactly as
 * written. A rename onto a key that already exists DROPS the other one: two
 * copies of the same key is not a document YAML can read back.
 */
export function renameFrontMatterField(yaml: string, key: string, nextKey: string): string {
    if (key === nextKey) return yaml;
    let text = yaml;
    if (locateField(text.split('\n'), nextKey)) text = removeFrontMatterField(text, nextKey);

    const lines = text.split('\n');
    const span = locateField(lines, key);
    if (!span) return yaml;

    const line = lines[span.start]!;
    const m = KEY_LINE.exec(line)!;
    lines[span.start] = encodeKey(nextKey) + line.slice(line.indexOf(':', m[1]!.length));
    return lines.join('\n');
}

/** Drop a key and every line of its value. */
export function removeFrontMatterField(yaml: string, key: string): string {
    const lines = yaml.split('\n');
    const span = locateField(lines, key);
    if (!span) return yaml;
    lines.splice(span.start, span.end - span.start + 1);
    return lines.join('\n');
}

/**
 * What an edited block means for the FILE: a block with nothing left in it is
 * no block at all, so removing the last key removes the fences too. A block
 * that still holds a comment is still a block — the user wrote that comment.
 */
export function normalizeFrontMatter(yaml: string): string | null {
    return yaml.trim() === '' ? null : yaml;
}

/** What the "fm" pill in the markdown editor's chrome says about a file. */
export interface FrontMatterPill {
    /** Does the file carry a block at all? An EMPTY block still counts. */
    present: boolean;
    keys: number;
    label: string;
    title: string;
}

/**
 * The pill is the only front-matter signal on screen when the drawer is shut,
 * so it has to answer "does this file have front matter, and how much" at a
 * glance — and read as an invitation when the answer is no.
 */
export function frontMatterPill(frontMatter: string | null): FrontMatterPill {
    if (frontMatter === null) {
        return {
            present: false,
            keys: 0,
            label: 'fm +',
            title: 'This file has no front matter — add some',
        };
    }
    const { fields, structured } = parseFrontMatterFields(frontMatter);
    return {
        present: true,
        keys: fields.length,
        label: structured
            ? `fm · ${fields.length} ${fields.length === 1 ? 'key' : 'keys'}`
            : 'fm · YAML',
        title: 'Edit this file’s front matter',
    };
}

/**
 * Retype a field, carrying as much of the old value across as the new shape can
 * hold. Retyping is a normal move in the drawer (a `.mdc` `alwaysApply` typed as
 * a string wants to be a boolean), and silently blanking the value would make
 * it feel like a delete.
 */
export function convertFmValue(field: FmField, kind: FmFieldKind): FmFieldValue {
    const text = field.kind === 'list' ? (field.items ?? []).join(', ') : field.value;
    switch (kind) {
        case 'list':
            return {
                kind: 'list',
                items: field.kind === 'list' ? (field.items ?? []) : text ? [text] : [],
            };
        case 'boolean':
            return { kind: 'boolean', value: /^(?:true|yes|on|1)$/i.test(text) ? 'true' : 'false' };
        case 'number':
            return { kind: 'number', value: NUMBER.test(text.trim()) ? text.trim() : '0' };
        case 'null':
            return { kind: 'null', value: '' };
        default:
            return { kind: 'string', value: text };
    }
}
