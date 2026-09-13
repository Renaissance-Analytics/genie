import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The panes yield around the canvas, and they come BACK.
 *
 * `renderer/lib/flow-editor-layout.ts` decides which panes fit at a measured
 * width, and that decision is tested there. This file is about the half of the
 * answer that only exists in CSS, and about the package rules it has to agree with.
 *
 * ## What fancy-flow does now
 *
 * Until 0.68, fancy-flow hid its own panes by VIEWPORT width (`@media` +
 * `display: none`), which outranked a host that asked for a pane, so Genie carried
 * rules restoring them. Upstream fixed that (Particle-Academy/fancy-flow#16): the
 * breakpoints are `@container` queries against the editor, and they make the panes
 * SMALLER rather than hiding them. So:
 *
 *  - Genie restores nothing. A restore rule for a pane nobody hides is CSS nobody
 *    dares delete, and these tests fail if one comes back.
 *  - Genie's docked tracks are `auto`, not pixel widths. A pane that shrinks inside
 *    a fixed track leaves an empty strip beside the canvas.
 *
 * Both are read from the INSTALLED package, so a fancy-flow that changes either
 * premise fails here and says which.
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');

const CSS = read('renderer/styles/master.css');
const VENDOR = read('node_modules/@particle-academy/fancy-flow/dist/styles.css');

/**
 * The at-rule prelude (`@media` / `@container`) a selector sits inside, or null
 * when it sits at the top level of the sheet.
 *
 * Walks back to the previous at-rule and refuses it if that block has already
 * closed — a `}` in column zero — so a rule that merely FOLLOWS a block is never
 * credited with being inside it.
 */
function atRuleAround(css: string, needle: string, from = 0): string | null {
    const at = css.indexOf(needle, from);
    if (at < 0) return null;
    const before = css.slice(0, at);
    const opened = Math.max(before.lastIndexOf('@media'), before.lastIndexOf('@container'));
    if (opened < 0) return null;
    if (before.slice(opened).includes('\n}')) return null;
    return css.slice(opened, css.indexOf('{', opened));
}

/** Every declaration block for a selector, wherever it appears. */
function rulesFor(css: string, selector: string): Array<{ body: string; within: string | null }> {
    const found: Array<{ body: string; within: string | null }> = [];
    for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) {
        const open = css.indexOf('{', at);
        const close = css.indexOf('}', open);
        if (open < 0 || close < 0) break;
        found.push({ body: css.slice(open + 1, close), within: atRuleAround(css, selector, at) });
    }
    return found;
}

/** The declaration block of a selector, top-level or not. */
function ruleAfter(css: string, selector: string): string | null {
    return rulesFor(css, selector)[0]?.body ?? null;
}

const PANES = ['.ff-editor__panel-wrap {', '.ff-editor__palette {'];

describe('fancy-flow sizes its panes by the editor, and hides none', () => {
    it('PREMISE: no fancy-flow rule hides a pane', () => {
        for (const pane of PANES) {
            const rules = rulesFor(VENDOR, pane);
            // Positive control: the reader finds the pane's rules at all, or
            // "none of them hides it" would pass for a selector that moved.
            expect(rules.length, `no ${pane} rules found in fancy-flow`).toBeGreaterThan(0);
            for (const rule of rules) expect(rule.body).not.toMatch(/display:\s*none/);
        }
    });

    it('PREMISE: its breakpoints are container queries that shrink the panes', () => {
        // This is why Genie's docked tracks are `auto`. If fancy-flow went back to
        // fixed pane widths, pixel tracks would be safe again — and this says so.
        const shrunk = rulesFor(VENDOR, '.ff-editor__palette {').filter((r) =>
            r.within?.startsWith('@container'),
        );
        expect(shrunk.length, 'fancy-flow no longer resizes the palette by container').toBeGreaterThan(0);
        const widths = shrunk.map((r) => Number(r.body.match(/width:\s*(\d+)px/)?.[1]));
        expect(Math.min(...widths)).toBeLessThan(216);
    });

    it('Genie carries no rule restoring a pane nobody hides', () => {
        for (const pane of ['.floweditor-shell .ff-editor__panel-wrap {', '.floweditor-shell .ff-editor__palette {']) {
            expect(rulesFor(CSS, pane), `${pane} is a restore rule for a pane fancy-flow no longer hides`).toEqual([]);
        }
        // Positive control: the reader does see Genie's shell rules.
        expect(ruleAfter(CSS, ".floweditor-shell[data-overlay='panel'] .ff-editor__panel-wrap {")).not.toBeNull();
    });
});

describe('an undocked pane floats over the canvas rather than shrinking it', () => {
    it('takes the floating pane out of the grid entirely', () => {
        // The whole point of the overlay: the canvas keeps its width while a
        // pane is open over it. A pane that stayed in flow would wrap onto a
        // second grid row, because `grid-template-columns` names only the panes
        // that are DOCKED.
        const overlay = ruleAfter(CSS, ".floweditor-shell[data-overlay='palette'] .ff-editor__palette");

        expect(overlay, 'no overlay rule — an opened pane would land in the grid').not.toBeNull();
        expect(overlay).toMatch(/position:\s*absolute/);
    });

    it('gives the floating pane something to be positioned against', () => {
        // Without a positioned ancestor an `absolute` pane escapes to the
        // nearest one — which is the window — and lands somewhere unrelated to
        // the editor.
        const shell = ruleAfter(CSS, '.floweditor-shell .ff-editor {');

        expect(shell, '.floweditor-shell .ff-editor has no rule').not.toBeNull();
        expect(shell).toMatch(/position:\s*relative/);
    });

    it('POSITIVE CONTROL: nothing floats when no pane is open', () => {
        // `[data-overlay='palette']` only matches while a pane is open, so the
        // docked case cannot inherit the absolute positioning. Asserted by the
        // selector rather than by a render, because there is no DOM here.
        expect(CSS).toContain("[data-overlay='palette']");
        expect(CSS).toContain("[data-overlay='panel']");
        expect(CSS).not.toContain("[data-overlay='none']");
    });
});
