import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The panes yield around the canvas, and they come BACK.
 *
 * `renderer/lib/flow-editor-layout.ts` decides which panes fit at a measured
 * width, and that decision is tested there. This file is about the half of the
 * answer that only exists in CSS, and about the package rule it has to overrule.
 *
 * ## The package rule
 *
 * fancy-flow's own stylesheet already tries to be responsive:
 *
 *     @media (max-width: 1024px) { .ff-editor__panel-wrap { display: none } }
 *     @media (max-width:  720px) { .ff-editor__palette    { display: none } }
 *
 * Both are wrong for Genie, in the same way. They measure the VIEWPORT, and the
 * editor is never the viewport — it is a tab inside a GApp window, or the body
 * of its own window with chrome around it. And `display: none` from a stylesheet
 * OUTRANKS a host that asks for the pane: `showPalette` renders it and the media
 * query hides it anyway, so the toggle that brings a pane back would appear to
 * do nothing at exactly the widths it exists for.
 *
 * So Genie restores them inside `.floweditor-shell` and decides for itself.
 *
 * ## Why the vendor sheet is read here
 *
 * Because the override is only justified while the rule it overrides is real. If
 * fancy-flow ever drops those media queries, the POSITIVE CONTROL below fails
 * and says so — which is the difference between a guard and a pile of CSS
 * nobody dares delete.
 *
 * Raised upstream as Particle-Academy/fancy-flow#16, together with the other
 * half of the same seam: `showPalette` / `showPanel` do not change
 * `grid-template-columns`, so turning a pane off leaves an empty column where it
 * was. That is why `FlowEditorPanel` names the columns inline.
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');

const CSS = read('renderer/styles/master.css');
const VENDOR = read('node_modules/@particle-academy/fancy-flow/dist/styles.css');

/**
 * The `@media` prelude a selector sits inside, or null when it sits at the top
 * level of the sheet.
 *
 * Walks back to the previous `@media` and refuses it if that block has already
 * closed — a `}` in column zero — so a rule that merely FOLLOWS a media block is
 * never credited with being inside it.
 */
function mediaAround(css: string, needle: string): string | null {
    const at = css.indexOf(needle);
    if (at < 0) return null;
    const before = css.slice(0, at);
    const opened = before.lastIndexOf('@media');
    if (opened < 0) return null;
    if (before.slice(opened).includes('\n}')) return null;
    return css.slice(opened, css.indexOf('{', opened));
}

/** The declaration block of a selector, top-level or not. */
function ruleAfter(css: string, selector: string): string | null {
    const at = css.indexOf(selector);
    if (at < 0) return null;
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

describe('the package hides panes on the wrong axis, and Genie takes them back', () => {
    it('POSITIVE CONTROL: fancy-flow really does hide them by viewport width', () => {
        // The premise of everything below. Asserted against the INSTALLED
        // package, so a version that fixes this fails here and tells us to
        // delete the override rather than carry it forever.
        const panel = mediaAround(VENDOR, '.ff-editor__panel-wrap {\n    display: none');
        const palette = mediaAround(VENDOR, '.ff-editor__palette {\n    display: none');

        expect(panel, 'fancy-flow no longer hides the config panel — drop the override').toContain(
            'max-width: 1024px',
        );
        expect(palette, 'fancy-flow no longer hides the palette — drop the override').toContain(
            'max-width: 720px',
        );

        // ...and the reader is not simply saying "1024" to everything.
        expect(mediaAround(VENDOR, '.ff-viewer {')).toBeNull();
    });

    it('restores the config panel inside the shell at the same breakpoint', () => {
        const at = mediaAround(CSS, '.floweditor-shell .ff-editor__panel-wrap');

        expect(
            at,
            'nothing overrides fancy-flow’s 1024px rule — the config-panel toggle does ' +
                'nothing on a narrow window',
        ).not.toBeNull();
        expect(at).toContain('max-width: 1024px');
        expect(ruleAfter(CSS, '.floweditor-shell .ff-editor__panel-wrap')).toMatch(/display:\s*flex/);
    });

    it('restores the palette inside the shell at the same breakpoint', () => {
        const at = mediaAround(CSS, '.floweditor-shell .ff-editor__palette');

        expect(
            at,
            'nothing overrides fancy-flow’s 720px rule — the palette toggle does nothing ' +
                'on a narrow window, which is where it is the only way to add a step',
        ).not.toBeNull();
        expect(at).toContain('max-width: 720px');
        expect(ruleAfter(CSS, '.floweditor-shell .ff-editor__palette')).toMatch(/display:\s*flex/);
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
