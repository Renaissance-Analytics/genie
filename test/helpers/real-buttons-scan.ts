import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseAst } from 'vite';

/**
 * REAL BUTTONS, REAL LINKS (the owner, 2026-11-01: "we need to make sure all buttons are real buttons, and links are real
 * links. There are too many confusing UI that look like a button but aren't, and things that are clickable but it doesn't
 * look like they are. fancy has a beautiful button component we need to use for all buttons and links").
 *
 * This reads the renderer's JSX as a SYNTAX TREE (Vite 8's `parseAst`, oxc underneath, with `lang: 'tsx'`), not as text:
 * a `<button>` inside a comment or a string is not an element and is never counted, so there is no comment stripping to
 * get wrong (the by-line stripping trap, memory feedback_source_guards_strip_comments_by_line, does not arise).
 *
 * GUARDED rules (test/real-buttons-guard.test.ts ratchets these):
 *   raw-button               an intrinsic `<button>` — use react-fancy's `<Button>`
 *   raw-anchor               an intrinsic `<a>` — use `<Button href>` (link form)
 *   click-on-non-interactive `onClick`/`onDoubleClick` on an element that is not a control (div, span, li, td, img…)
 *   role-button              `role="button"`/`role="link"` faking a control on a non-control
 *   pointer-without-handler  `cursor-pointer` on an element that has no click handler and is not a control
 * AUDIT-ONLY rules (reported in the audit; too heuristic to gate on):
 *   link-styled-static       `underline` text on an element with no handler that is not a link or button
 *   button-styled-static     a bordered, rounded, padded div/span with no handler (looks like a button, is not one)
 */

export type GuardedRule = 'raw-button' | 'raw-anchor' | 'click-on-non-interactive' | 'role-button' | 'pointer-without-handler';
export type AuditRule = 'link-styled-static' | 'button-styled-static';
export type Rule = GuardedRule | AuditRule;
export const GUARDED_RULES: readonly GuardedRule[] = ['raw-button', 'raw-anchor', 'click-on-non-interactive', 'role-button', 'pointer-without-handler'];

export interface Finding {
    /** Path relative to the scanned root, always with `/`. */
    file: string;
    line: number;
    rule: Rule;
    tag: string;
    /** The nearest enclosing named function/component, or '' at module level. */
    owner: string;
    className: string;
    /** Part of the className comes from outside this file (a prop, a call), so `className` is incomplete. */
    classUnresolved: boolean;
    /** Visible JSX text, else aria-label, else title ('' when the label is an expression or an icon). */
    label: string;
    hasClick: boolean;
    href: string;
    disabled: boolean;
}

/** Elements a person can already operate without a click handler bolted on. */
const CONTROLS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary', 'option']);
const CLICK_ATTRS = new Set(['onClick', 'onDoubleClick']);
const POINTER_HANDLERS = new Set(['onClick', 'onDoubleClick', 'onMouseDown', 'onPointerDown', 'onMouseUp', 'onPointerUp']);

type Node = { type: string; start: number; end: number; [k: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string';

/**
 * The class strings an expression can produce, with same-file constants resolved (`className={button}` where
 * `const button = '…'`, `TONE[w.state]` where `const TONE = { … }`). A value that comes from outside the file (a prop, a
 * call's result) marks the result `unresolved`, so the audit reports "unknown" instead of guessing "plain text".
 */
function classStrings(v: unknown, consts: Map<string, Node>, seen = new Set<string>()): { strings: string[]; unresolved: boolean } {
    const out = { strings: [] as string[], unresolved: false };
    const go = (x: unknown): void => {
        if (!isNode(x)) return;
        switch (x.type) {
            case 'Literal':
                if (typeof x.value === 'string') out.strings.push(x.value);
                return;
            case 'TemplateLiteral':
                for (const q of (x.quasis as Node[]) ?? []) {
                    const val = q.value as { cooked?: string; raw?: string } | undefined;
                    out.strings.push(val?.cooked ?? val?.raw ?? '');
                }
                for (const e of (x.expressions as Node[]) ?? []) go(e);
                return;
            case 'Identifier': {
                const name = String(x.name);
                const init = consts.get(name);
                if (init && !seen.has(name)) {
                    seen.add(name);
                    go(init);
                } else if (!init) out.unresolved = true;
                return;
            }
            case 'MemberExpression':
                go(x.object);
                return;
            case 'ConditionalExpression':
                go(x.consequent);
                go(x.alternate);
                return;
            case 'LogicalExpression':
                if (x.operator !== '&&') go(x.left);
                go(x.right);
                return;
            case 'BinaryExpression':
                if (x.operator === '+') {
                    go(x.left);
                    go(x.right);
                }
                return;
            case 'CallExpression':
                // cn('a', b && 'c'), and ['a', b ? 'c' : ''].filter(Boolean).join(' ') — the strings are in the
                // arguments and in the receiver of a method chain, never in the callee's name.
                for (const a of (x.arguments as Node[]) ?? []) if (!(isNode(a) && a.type === 'Identifier' && a.name === 'Boolean')) go(a);
                if (isNode(x.callee) && x.callee.type === 'MemberExpression') go(x.callee.object);
                return;
            case 'ObjectExpression':
                for (const p of (x.properties as Node[]) ?? []) go(p.type === 'Property' ? p.value : p);
                return;
            case 'ArrayExpression':
                for (const e of (x.elements as Node[]) ?? []) go(e);
                return;
            case 'JSXExpressionContainer':
            case 'TSAsExpression':
            case 'TSSatisfiesExpression':
            case 'ParenthesizedExpression':
                go(x.expression);
                return;
            default:
                out.unresolved = true;
        }
    };
    go(v);
    return out;
}

/** Plain string literals only (aria-label, title, href, role): never resolved through constants. */
function stringsIn(v: unknown): string[] {
    return classStrings(v, new Map()).strings;
}

/**
 * The element's attributes by name — including those passed through a spread of an object literal, conditional or not
 * (`{...(row.inspectable ? { role: 'button', onClick } : {})}`): a click handler is a click handler however it arrives.
 */
function attrMap(opening: Node): Map<string, Node | null> {
    const m = new Map<string, Node | null>();
    const fromSpread = (x: unknown): void => {
        if (!isNode(x)) return;
        if (x.type === 'ObjectExpression') {
            for (const p of (x.properties as Node[]) ?? []) {
                if (p.type !== 'Property') {
                    fromSpread(p.type === 'SpreadElement' ? p.argument : null);
                    continue;
                }
                const k = p.key as Node;
                const key = k.type === 'Identifier' ? String(k.name) : k.type === 'Literal' ? String(k.value) : '';
                if (key) m.set(key, (p.shorthand ? null : (p.value as Node)) ?? null);
            }
        } else if (x.type === 'ConditionalExpression') {
            fromSpread(x.consequent);
            fromSpread(x.alternate);
        } else if (x.type === 'LogicalExpression') fromSpread(x.right);
        else if (x.type === 'ParenthesizedExpression' || x.type === 'TSAsExpression') fromSpread(x.expression);
    };
    for (const a of (opening.attributes as Node[]) ?? []) {
        if (a.type === 'JSXSpreadAttribute') {
            fromSpread(a.argument);
            continue;
        }
        if (a.type !== 'JSXAttribute') continue;
        const name = a.name as Node;
        const key = name.type === 'JSXIdentifier' ? String(name.name) : `${String((name.namespace as Node).name)}:${String((name.name as Node).name)}`;
        m.set(key, (a.value as Node | null) ?? null);
    }
    return m;
}

const literal = (v: Node | null | undefined): string => {
    if (!v) return '';
    if (v.type === 'Literal' && typeof v.value === 'string') return v.value;
    if (v.type === 'JSXExpressionContainer') return stringsIn(v.expression).join(' ');
    if (v.type === 'TemplateLiteral' || v.type === 'ConditionalExpression') return stringsIn(v).join(' ');
    return '';
};

function textOf(el: Node): string {
    const parts: string[] = [];
    const walk = (n: Node) => {
        for (const c of (n.children as Node[]) ?? []) {
            if (c.type === 'JSXText') parts.push(String(c.value));
            else if (c.type === 'JSXElement' || c.type === 'JSXFragment') walk(c);
        }
    };
    walk(el);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function functionName(n: Node, parent: Node | undefined): string {
    if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && isNode(n.id)) return String(n.id.name);
    if ((n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') && parent?.type === 'VariableDeclarator' && isNode(parent.id)) {
        return String(parent.id.name ?? '');
    }
    return '';
}

export function scanSource(source: string, file: string): Finding[] {
    const ast = parseAst(source, { lang: 'tsx' }, file) as unknown as Node;
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const lineOf = (offset: number) => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    };
    const out: Finding[] = [];
    const owners: string[] = [];
    const consts = new Map<string, Node>();
    const collect = (n: Node) => {
        if (n.type === 'VariableDeclarator' && isNode(n.id) && n.id.type === 'Identifier' && isNode(n.init)) consts.set(String(n.id.name), n.init);
        for (const [k, v] of Object.entries(n)) {
            if (k === 'type' || k === 'start' || k === 'end') continue;
            if (Array.isArray(v)) {
                for (const c of v) if (isNode(c)) collect(c);
            } else if (isNode(v)) collect(v);
        }
    };
    collect(ast);

    const visitElement = (el: Node) => {
        const opening = el.openingElement as Node;
        const nameNode = opening.name as Node;
        if (nameNode.type !== 'JSXIdentifier') return;
        const tag = String(nameNode.name);
        const intrinsic = /^[a-z]/.test(tag);
        const attrs = attrMap(opening);
        const cls = attrs.has('className') ? classStrings(attrs.get('className'), consts) : { strings: [], unresolved: false };
        const className = cls.strings.join(' ');
        const classes = new Set(className.split(/\s+/).filter(Boolean));
        const hasClick = [...CLICK_ATTRS].some((a) => attrs.has(a));
        const hasPointerHandler = [...POINTER_HANDLERS].some((a) => attrs.has(a));
        const label = textOf(el) || literal(attrs.get('aria-label')) || literal(attrs.get('title'));
        const base = {
            file,
            line: lineOf(opening.start),
            tag,
            owner: owners.findLast((o) => o) ?? '',
            className,
            classUnresolved: cls.unresolved,
            label,
            hasClick,
            href: literal(attrs.get('href')),
            disabled: attrs.has('disabled'),
        };
        const add = (rule: Rule) => out.push({ ...base, rule });
        if (!intrinsic) {
            // A component with cursor-pointer and no handler still looks clickable and is not.
            if (classes.has('cursor-pointer') && !hasPointerHandler) add('pointer-without-handler');
            return;
        }
        if (tag === 'button') add('raw-button');
        else if (tag === 'a') add('raw-anchor');
        else if (hasClick && !CONTROLS.has(tag)) add('click-on-non-interactive');
        const role = literal(attrs.get('role'));
        if ((role === 'button' || role === 'link') && !CONTROLS.has(tag)) add('role-button');
        if (classes.has('cursor-pointer') && !hasPointerHandler && !CONTROLS.has(tag) && tag !== 'label') add('pointer-without-handler');
        if (!hasPointerHandler && !CONTROLS.has(tag) && tag !== 'label') {
            if (classes.has('underline') || classes.has('hover:underline')) add('link-styled-static');
            else if (
                (tag === 'div' || tag === 'span') &&
                [...classes].some((c) => c === 'border' || c.startsWith('border-[')) &&
                [...classes].some((c) => c.startsWith('rounded')) &&
                [...classes].some((c) => /^px-/.test(c)) &&
                [...classes].some((c) => /^py-/.test(c)) &&
                !textOf(el).includes('\n')
            ) {
                add('button-styled-static');
            }
        }
    };

    const walk = (n: Node, parent: Node | undefined) => {
        const name = functionName(n, parent);
        if (name) owners.push(name);
        if (n.type === 'JSXElement') visitElement(n);
        for (const [k, v] of Object.entries(n)) {
            if (k === 'type' || k === 'start' || k === 'end') continue;
            if (Array.isArray(v)) {
                for (const c of v) if (isNode(c)) walk(c, n);
            } else if (isNode(v)) walk(v, n);
        }
        if (name) owners.pop();
    };
    walk(ast, undefined);
    return out.sort((a, b) => a.line - b.line);
}

/** Every `.tsx` under `root` (the renderer), relative paths with `/`. */
export function rendererFiles(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(dir)) {
            const p = join(dir, e);
            if (statSync(p).isDirectory()) walk(p);
            else if (p.endsWith('.tsx')) files.push(relative(root, p).split(sep).join('/'));
        }
    };
    walk(root);
    return files.sort();
}

export function scanRenderer(root: string): Finding[] {
    return rendererFiles(root).flatMap((f) => scanSource(readFileSync(join(root, f), 'utf8'), f));
}

/** `{ file: { rule: count } }` for the guarded rules — the shape the ratchet allowlist is written in. */
export function countsByFile(findings: readonly Finding[]): Record<string, Partial<Record<GuardedRule, number>>> {
    const out: Record<string, Partial<Record<GuardedRule, number>>> = {};
    for (const f of findings) {
        if (!(GUARDED_RULES as readonly string[]).includes(f.rule)) continue;
        const r = f.rule as GuardedRule;
        const row = (out[f.file] ??= {});
        row[r] = (row[r] ?? 0) + 1;
    }
    return out;
}
