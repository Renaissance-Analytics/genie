import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * ROWS ARE LEFT-ALIGNED (2026-11-01: the phone dashboard showed every agent row — a react-fancy Button since the real
 * buttons work — with its name, logo and "Idle" CENTRED, iphone13-dashboard-1-after-one-swipe.png).
 *
 * react-fancy's Button lays itself out `inline-flex items-center justify-center`. A row or a card that became a Button
 * keeps that unless it says otherwise: a full-width row's content drifts to the middle, and a column's lines centre
 * under each other. So a Button that is a ROW — its classes say `text-left`, or `flex-col`, or `flex` + `w-full` — states
 * its own alignment: a `justify-*` that is not `justify-center`, and for a column an `items-*` that is not
 * `items-center`. A deliberately centred control (an icon tile, a full-width primary button) does not claim to be a row,
 * so it is not touched.
 *
 * Read from the syntax tree, className strings and same-file string constants resolved.
 */

type N = { type: string; start: number; end: number; [k: string]: unknown };
const isN = (v: unknown): v is N => !!v && typeof v === 'object' && typeof (v as N).type === 'string';

function strings(v: unknown, consts: Map<string, N>, seen = new Set<string>(), out: string[] = []): string[] {
    if (Array.isArray(v)) { v.forEach((x) => strings(x, consts, seen, out)); return out; }
    if (!isN(v)) return out;
    if (v.type === 'Literal' && typeof v.value === 'string') out.push(v.value);
    else if (v.type === 'TemplateElement') out.push(String((v.value as { cooked?: string }).cooked ?? ''));
    else if (v.type === 'Identifier') {
        const name = String(v.name);
        const init = consts.get(name);
        if (init && !seen.has(name)) { seen.add(name); strings(init, consts, seen, out); }
        return out;
    }
    for (const [k, x] of Object.entries(v)) if (k !== 'type' && k !== 'start' && k !== 'end') strings(x, consts, seen, out);
    return out;
}

export interface RowFinding { file: string; line: number; why: string }

export function misalignedRows(source: string, file: string): RowFinding[] {
    const ast = parseAst(source, { lang: 'tsx' }, file) as unknown as N;
    const consts = new Map<string, N>();
    const collect = (n: N) => {
        if (n.type === 'VariableDeclarator' && isN(n.id) && n.id.type === 'Identifier' && isN(n.init) && /Literal|TemplateLiteral/.test(n.init.type)) consts.set(String(n.id.name), n.init);
        for (const [k, v] of Object.entries(n)) if (k !== 'type' && k !== 'start' && k !== 'end') for (const x of Array.isArray(v) ? v : [v]) if (isN(x)) collect(x);
    };
    collect(ast);
    const out: RowFinding[] = [];
    const walk = (n: N) => {
        if (n.type === 'JSXElement') {
            const o = n.openingElement as N;
            if ((o.name as N).type === 'JSXIdentifier' && (o.name as N).name === 'Button') {
                const cls = ((o.attributes as N[]) ?? []).find((a) => a.type === 'JSXAttribute' && (a.name as N).name === 'className');
                const k = new Set((cls ? strings(cls.value, consts) : []).join(' ').split(/\s+/).filter(Boolean));
                const isRow = k.has('text-left') || k.has('flex-col') || (k.has('flex') && k.has('w-full'));
                if (isRow) {
                    const justify = [...k].filter((x) => /^justify-(start|end|between|around|evenly|center|stretch|normal)$/.test(x));
                    const items = [...k].filter((x) => /^items-(start|end|center|baseline|stretch)$/.test(x));
                    const line = source.slice(0, o.start).split('\n').length;
                    // An explicit justify-center/items-center is deliberate (an icon tile, a centred number column) — unless the
                    // same Button also says text-left, which is a row asking to be left-aligned.
                    const onlyCenter = (xs: string[], c: string) => xs.length > 0 && xs.every((x) => x === c);
                    if (justify.length === 0 || (onlyCenter(justify, 'justify-center') && k.has('text-left'))) out.push({ file, line, why: `no row justify (has ${justify.join(' ') || 'none'}): Button's default justify-center centres its content` });
                    if (k.has('flex-col') && (items.length === 0 || (onlyCenter(items, 'items-center') && k.has('text-left')))) out.push({ file, line, why: `a column with ${items.join(' ') || 'no items-*'}: Button's default items-center centres each line` });
                }
            }
        }
        for (const [key, v] of Object.entries(n)) if (key !== 'type' && key !== 'start' && key !== 'end') for (const x of Array.isArray(v) ? v : [v]) if (isN(x)) walk(x);
    };
    walk(ast);
    return out;
}

describe('the row reader (positive and negative controls)', () => {
    it('flags a full-width row with no justify, a text-left row, and a centred column', () => {
        const src = [
            'const A = () => <>',
            '  <Button className="flex w-full items-center gap-2">row</Button>',
            '  <Button className="max-w-full text-left">choice</Button>',
            '  <Button className="flex w-full flex-col gap-1 justify-start">card</Button>',
            '</>;',
        ].join('\n');
        expect(misalignedRows(src, 'x.tsx').map((f) => f.line)).toEqual([2, 3, 4]);
    });
    it('accepts a row that states its alignment (also through a constant), and leaves centred controls alone', () => {
        const src = [
            "const ROW = 'flex w-full items-center justify-start gap-2';",
            'const A = () => <>',
            '  <Button className={ROW}>row</Button>',
            '  <Button className="flex w-full flex-col items-stretch justify-start">card</Button>',
            '  <Button className="flex size-8 items-center justify-center">icon tile</Button>',
            '  <Button className="w-full rounded-lg px-4 py-2.5">Primary</Button>',
            '</>;',
        ].join('\n');
        expect(misalignedRows(src, 'x.tsx')).toEqual([]);
    });
});

describe('every row-like react-fancy Button in the renderer is left-aligned', () => {
    const root = fileURLToPath(new URL('../src/renderer', import.meta.url));
    const files: string[] = [];
    const walkDir = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walkDir(join(d, e.name)); else if (e.name.endsWith('.tsx')) files.push(join(d, e.name)); } };
    walkDir(root);
    const found = files.flatMap((f) => misalignedRows(readFileSync(f, 'utf8'), f.slice(root.length + 1).split('\\').join('/')));

    it('reads Buttons at all (CONTROL: the inbox thread rows, already left-aligned, are rows it can see)', () => {
        const inbox = readFileSync(join(root, 'components', 'InboxFlyout.tsx'), 'utf8');
        expect(inbox).toMatch(/w-full flex-col items-stretch justify-start/);
        expect(misalignedRows(inbox.replace(/w-full flex-col items-stretch justify-start/, 'w-full flex-col'), 'InboxFlyout.tsx').length).toBeGreaterThan(0);
    });

    // The rail is no exception any more: it is a react-fancy Sidebar menu, not Buttons (genie#1430).
    it('none is left centred', () => {
        expect(found.map((f) => `${f.file}:${f.line} ${f.why}`), found.map((f) => `${f.file}:${f.line} ${f.why}`).join('\n')).toEqual([]);
    });
});
