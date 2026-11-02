import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUARDED_RULES, countsByFile, scanRenderer, scanSource, type Finding, type GuardedRule } from './helpers/real-buttons-scan.js';
import { REAL_BUTTONS_ALLOWLIST } from './real-buttons-allowlist.js';

/**
 * REAL BUTTONS, REAL LINKS — the ratchet (the owner, 2026-11-01: "we need to make sure all buttons are real buttons, and
 * links are real links. There are too many confusing UI that look like a button but aren't, and things that are clickable
 * but it doesn't look like they are. fancy has a beautiful button component we need to use for all buttons and links").
 *
 * Every action in the renderer is react-fancy's `<Button>` (a link is `<Button href>`), so it looks like what it is and
 * carries `loading`/`disabled` while its work runs. This test reads the renderer's JSX as a syntax tree
 * (test/helpers/real-buttons-scan.ts) and fails on:
 *   - a raw `<button>` or `<a>`;
 *   - `onClick`/`onDoubleClick` on an element that is not a control (div, span, li, td, img…), however it is passed;
 *   - `role="button"`/`role="link"` on a non-control;
 *   - `cursor-pointer` on something with no click handler.
 *
 * The allowlist (test/real-buttons-allowlist.ts) started as the full inventory on 2026-11-01
 * (.ai/plans/genie-2-real-buttons-audit.md in the envelope). Its counts must match EXACTLY: one more is a new violation,
 * one fewer means a conversion landed and the entry must shrink in the same PR, so the list only ever goes down. An entry
 * that is not debt says why in its `reason`.
 */

const RENDERER = fileURLToPath(new URL('../src/renderer', import.meta.url));
const where = (fs: readonly Finding[]) => fs.map((f) => `${f.file}:${f.line} <${f.tag}>${f.owner ? ` in ${f.owner}` : ''}`).join('\n  ');

describe('the scanner (positive and negative controls: it can see each violation it claims to guard)', () => {
    const rules = (src: string) => scanSource(src, 'x.tsx').map((f) => f.rule).filter((r) => (GUARDED_RULES as readonly string[]).includes(r));

    it('sees a raw <button> and a raw <a>', () => {
        expect(rules('const A = () => <div><button onClick={go}>Go</button><a href="https://x">x</a></div>;')).toEqual(['raw-button', 'raw-anchor']);
    });

    it('sees onClick on a div, span, li, td and img', () => {
        const src = 'const A = () => <><div onClick={f}/><span onClick={f}/><li onClick={f}/><td onDoubleClick={f}/><img onClick={f}/></>;';
        expect(rules(src)).toEqual(Array(5).fill('click-on-non-interactive'));
    });

    it('sees onClick and role="button" passed through a conditional spread, as StreamRow passes them', () => {
        const src = "const A = () => <div {...(ok ? { role: 'button', tabIndex: 0, onClick: () => go() } : {})} />;";
        expect(rules(src).sort()).toEqual(['click-on-non-interactive', 'role-button']);
    });

    it('sees cursor-pointer with no handler, including through a same-file constant and a class array', () => {
        expect(rules('const A = () => <div className="flex cursor-pointer" />;')).toEqual(['pointer-without-handler']);
        expect(rules("const C = 'p-1 cursor-pointer'; const A = () => <span className={C} />;")).toEqual(['pointer-without-handler']);
        expect(rules("const A = () => <div className={['a', on ? 'cursor-pointer' : ''].filter(Boolean).join(' ')} />;")).toEqual(['pointer-without-handler']);
    });

    it('does NOT count a <button> in a comment or a string, a fancy <Button>, or a click on a real control', () => {
        const src = [
            '// <button onClick={x}>old</button>',
            '/* <div onClick={f}> */',
            "const s = '<button>not markup</button>';",
            'const A = () => <>',
            '  {/* <a href="#">x</a> */}',
            '  <Button onClick={go} loading={busy}>Go</Button>',
            '  <Button href="https://tynn.ai" target="_blank">Tynn</Button>',
            '  <input onClick={f} /><select onClick={f} /><summary onClick={f}>x</summary>',
            '  <label className="cursor-pointer"><input type="checkbox" /></label>',
            '  <div className="cursor-pointer" onClick={f} />',
            '</>;',
        ].join('\n');
        // The last line is a click-on-non-interactive (a div with a handler) and nothing else: the pointer is honest there.
        expect(rules(src)).toEqual(['click-on-non-interactive']);
    });

    it('sees a menu or tab item made into a Button (aria-current, role tab/menuitem), and not a Sidebar item', () => {
        const src = [
            'const A = () => <>',
            '  <Button aria-current="page" onClick={go}>Dashboard</Button>',
            '  <Button role="tab" aria-selected onClick={go}>Files</Button>',
            '  <Sidebar.Item active onClick={go}>Deck</Sidebar.Item>',
            '  <Button onClick={go}>Save</Button>',
            '</>;',
        ].join('\n');
        expect(rules(src)).toEqual(['menu-as-button', 'menu-as-button']);
    });

    it('reports the line of the element, so a failure points at it', () => {
        const [f] = scanSource('const A = () => (\n  <div>\n    <button>x</button>\n  </div>\n);', 'x.tsx');
        expect(f).toMatchObject({ rule: 'raw-button', line: 3, owner: 'A' });
    });
});

describe('the renderer: real buttons and real links only (ratchet)', () => {
    const findings = scanRenderer(RENDERER);
    const actual = countsByFile(findings);

    it('reads the renderer at all (a scan that finds no files proves nothing)', () => {
        expect(Object.keys(actual).length + findings.length).toBeGreaterThan(0);
    });

    it('every allowlist entry names a guarded rule, a positive count and a reason', () => {
        for (const e of REAL_BUTTONS_ALLOWLIST) {
            expect(GUARDED_RULES, `${e.file}: ${e.rule}`).toContain(e.rule);
            expect(e.count, `${e.file} ${e.rule}`).toBeGreaterThan(0);
            expect(e.reason.trim().length, `${e.file} ${e.rule}`).toBeGreaterThan(10);
        }
        const keys = REAL_BUTTONS_ALLOWLIST.map((e) => `${e.file}|${e.rule}`);
        expect(new Set(keys).size, 'one entry per file and rule').toBe(keys.length);
    });

    it('no NEW violations: nothing exceeds its allowlisted count (use react-fancy <Button>, or <Button href> for a link)', () => {
        const over: string[] = [];
        for (const [file, row] of Object.entries(actual)) {
            for (const [rule, n] of Object.entries(row) as [GuardedRule, number][]) {
                const allowed = REAL_BUTTONS_ALLOWLIST.find((e) => e.file === file && e.rule === rule)?.count ?? 0;
                if (n > allowed) over.push(`${file} ${rule}: ${n} (allowed ${allowed})\n  ${where(findings.filter((f) => f.file === file && f.rule === rule))}`);
            }
        }
        expect(over, over.join('\n')).toEqual([]);
    });

    it('the allowlist only shrinks: a converted element comes OFF the list in the same change', () => {
        const stale = REAL_BUTTONS_ALLOWLIST.filter((e) => (actual[e.file]?.[e.rule] ?? 0) < e.count).map(
            (e) => `${e.file} ${e.rule}: allowlisted ${e.count}, now ${actual[e.file]?.[e.rule] ?? 0} — lower the entry (or delete it at 0)`,
        );
        expect(stale, stale.join('\n')).toEqual([]);
    });
});
