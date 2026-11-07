import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Button } from '@particle-academy/react-fancy';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * EVERY FORM STILL SUBMITS (react-fancy 6.0.0, 2026-11-01: `<Button>` now defaults to type="button").
 *
 * Under 5.x an untyped react-fancy Button inside a <form> was a submit button; under 6.0.0 it is not. A form submits on a
 * click and on Enter (the HTML spec's implicit submission) through its DEFAULT BUTTON — its first submit control — or,
 * with no submit control, only when it has exactly one text field. So every <form onSubmit> in the renderer must have:
 *   - a submit control: a react-fancy Button or raw <button> with type="submit", a raw <button> with no type (native
 *     default: submit), an <input type="submit">, or a same-file component whose JSX has one of those (TynnBoardPanel's
 *     SubmitButton); or
 *   - exactly one single-line text field and no submit control (implicit submission still applies).
 * And no react-fancy Button inside a form may be untyped: under 6.0.0 it silently stopped submitting; say which it is.
 *
 * Read from the syntax tree (Vite's parseAst), like test/real-buttons-guard.test.ts. Lexical nesting: a form's controls
 * written inside the same JSX element (or a same-file component it renders).
 */

type N = { type: string; start: number; end: number; [k: string]: unknown };
const isN = (v: unknown): v is N => !!v && typeof v === 'object' && typeof (v as N).type === 'string';
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export interface FormFinding { file: string; line: number; submits: number; textFields: number; untypedFancy: number[] }

const attrs = (o: N): Map<string, string | null> => {
    const m = new Map<string, string | null>();
    for (const a of (o.attributes as N[]) ?? []) {
        if (a.type !== 'JSXAttribute') continue;
        const v = a.value as N | null;
        m.set(String((a.name as N).name), v && v.type === 'Literal' ? String(v.value) : v ? '{expr}' : null);
    }
    return m;
};

export function formsIn(source: string, file: string): FormFinding[] {
    const ast = parseAst(source, { lang: 'tsx' }, file) as unknown as N;
    const lineOf = (o: number) => source.slice(0, o).split('\n').length;
    // Same-file function components, by name: a form may render its submit through one (SubmitButton).
    const comps = new Map<string, N>();
    const collect = (n: N) => {
        if (n.type === 'FunctionDeclaration' && isN(n.id)) comps.set(String(n.id.name), n);
        if (n.type === 'VariableDeclarator' && isN(n.id) && isN(n.init) && /Function/.test(n.init.type)) comps.set(String(n.id.name), n.init);
        for (const [k, v] of Object.entries(n)) if (k !== 'type' && k !== 'start' && k !== 'end') for (const x of Array.isArray(v) ? v : [v]) if (isN(x)) collect(x);
    };
    collect(ast);
    const isSubmit = (name: string, a: Map<string, string | null>) =>
        ((name === 'Button' || name === 'button') && a.get('type') === 'submit') || (name === 'button' && !a.has('type')) || (name === 'input' && a.get('type') === 'submit');
    const componentSubmits = (name: string, seen = new Set<string>()): boolean => {
        const body = comps.get(name);
        if (!body || seen.has(name)) return false;
        seen.add(name);
        let found = false;
        const walk = (n: N) => {
            if (found) return;
            if (n.type === 'JSXElement') {
                const o = n.openingElement as N;
                const nm = String((o.name as N).name ?? '');
                if (isSubmit(nm, attrs(o)) || (/^[A-Z]/.test(nm) && nm !== 'Button' && componentSubmits(nm, seen))) { found = true; return; }
            }
            for (const [k, v] of Object.entries(n)) if (k !== 'type' && k !== 'start' && k !== 'end') for (const x of Array.isArray(v) ? v : [v]) if (isN(x)) walk(x);
        };
        walk(body);
        return found;
    };
    const out: FormFinding[] = [];
    const walk = (n: N, form: FormFinding | null) => {
        let f = form;
        if (n.type === 'JSXElement') {
            const o = n.openingElement as N;
            const name = String((o.name as N).name ?? '');
            const a = attrs(o);
            if (name === 'form' && a.has('onSubmit')) {
                f = { file, line: lineOf(o.start), submits: 0, textFields: 0, untypedFancy: [] };
                out.push(f);
            } else if (f) {
                if (isSubmit(name, a) || (/^[A-Z]/.test(name) && name !== 'Button' && componentSubmits(name))) f.submits++;
                if (name === 'Button' && !a.has('type') && !a.has('href')) f.untypedFancy.push(lineOf(o.start));
                if ((name === 'input' && TEXT_TYPES.has(a.get('type') ?? '')) || name === 'Input') f.textFields++;
            }
        }
        for (const [k, v] of Object.entries(n)) if (k !== 'type' && k !== 'start' && k !== 'end') for (const x of Array.isArray(v) ? v : [v]) if (isN(x)) walk(x, f);
    };
    walk(ast, null);
    return out;
}

const problems = (fs: readonly FormFinding[]) =>
    fs.flatMap((f) => [
        ...(f.submits === 0 && f.textFields !== 1 ? [`${f.file}:${f.line} has no submit control and ${f.textFields} text fields: neither a click nor Enter submits it`] : []),
        ...f.untypedFancy.map((l) => `${f.file}:${l} an untyped react-fancy Button inside a form (6.0.0: type="button", it no longer submits) — give it type="submit" or type="button"`),
    ]);

describe('react-fancy Button types, the contract the forms below rely on (6.0.0)', () => {
    const tag = (html: string) => /<button\b[^>]*>/.exec(html)?.[0] ?? '';
    it('an untyped Button is type="button" (it never submits a form by accident)', () => {
        expect(tag(renderToStaticMarkup(createElement(Button, null, 'Open')))).toMatch(/\stype="button"/);
    });
    it('an explicit type="submit" stays a submit (the default does not override it)', () => {
        const html = renderToStaticMarkup(createElement(Button, { type: 'submit' }, 'Save'));
        expect(tag(html)).toMatch(/\stype="submit"/);
        expect(tag(html)).not.toMatch(/\stype="button"/);
    });
});

describe('the contract reader (positive and negative controls)', () => {
    it('flags an untyped Button inside a form, and a many-field form with no submit', () => {
        const src = `const A = () => <form onSubmit={s}><input /><input /><Button>Save</Button></form>;`;
        expect(problems(formsIn(src, 'x.tsx'))).toHaveLength(2);
    });
    it('accepts a typed submit Button, a raw untyped <button> (native submit), a submit via a same-file component, and one text field', () => {
        const src = [
            'function Go() { return <button type="submit">Go</button>; }',
            'const A = () => <>',
            '  <form onSubmit={s}><input /><input /><Button type="submit">Save</Button><Button type="button">Cancel</Button></form>',
            '  <form onSubmit={s}><input /><input /><button>Send</button></form>',
            '  <form onSubmit={s}><input /><textarea /><Go /></form>',
            '  <form onSubmit={s}><input placeholder="url" /></form>',
            '</>;',
        ].join('\n');
        const fs = formsIn(src, 'x.tsx');
        expect(fs).toHaveLength(4);
        expect(problems(fs)).toEqual([]);
    });
});

describe('every form in the renderer submits on a click and on Enter', () => {
    const root = fileURLToPath(new URL('../src/renderer', import.meta.url));
    const files: string[] = [];
    const walkDir = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walkDir(join(d, e.name)); else if (e.name.endsWith('.tsx')) files.push(join(d, e.name)); } };
    walkDir(root);
    const forms = files.flatMap((f) => formsIn(readFileSync(f, 'utf8'), f.slice(root.length + 1).split('\\').join('/')));

    it('reads the forms at all (COUNTED: the renderer has at least 20 forms with onSubmit)', () => {
        expect(forms.length).toBeGreaterThanOrEqual(20);
    });

    it('each has a submit control or is a one-field form; no react-fancy Button inside a form is untyped', () => {
        const p = problems(forms);
        expect(p, p.join('\n')).toEqual([]);
    });
});
