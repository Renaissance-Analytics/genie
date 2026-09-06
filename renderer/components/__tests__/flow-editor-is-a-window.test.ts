import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Flow editor is a WINDOW, and it is shaped like the other one.
 *
 * ## The bug this is the standing answer to
 *
 * `FlowCanvasModal` rendered `<div className="prompt-card flowmgr-canvas">` —
 * Genie's ordinary modal card, widened twice. A node graph is not a prompt: it
 * is panned, zoomed and dragged, with a palette down one side and an inspector
 * down the other, and 48px of margin inside a window that already has a
 * titlebar, a workspace rail and a terminal behind it is not room for any of
 * that. The owner's screenshot is the SECOND widening, still clipped.
 *
 * A third widening would have been the third round of the same fix. Genie
 * already knows how to give a surface its own window — Settings, Docs and the
 * Knowledge Graph each have one — so the editor gets one too.
 *
 * ## Why a source-level test
 *
 * Everything asserted here is a fact about the two files as documents:
 * `createFlowEditorWindow` exists, it declares the same window-shape options
 * `createSettingsWindow` does, it loads its own route in dev AND its own
 * packaged HTML, it is a singleton, and nothing renders the editor in a card
 * any more. None of that needs an Electron runtime, and all of it is what would
 * silently rot.
 *
 * The E2E in `e2e/master-window.spec.ts` drives the real window and measures the
 * real canvas. This one says WHY when it breaks, and runs in milliseconds.
 */

const ROOT = path.resolve(__dirname, '../../..');

/**
 * Read a source file with LF endings whatever the checkout did.
 *
 * This repository is developed on Windows and built on Linux CI, so the same
 * file is CRLF in one place and LF in the other. Every scan below is anchored on
 * a newline, and a guard that silently reads nothing on one of the two machines
 * is worse than no guard at all.
 */
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');

const BACKGROUND = read('main/background.ts');
const FLYOUT = read('renderer/components/Master/FlowManagerFlyout.tsx');

/**
 * A top-level function's body.
 *
 * Deliberately crude: from the declaration to the first `\n}` in column zero.
 * Every function asked about below is a top-level `function` in a 4-space-
 * indented file, so a closing brace at column zero is its end and nothing
 * nested — comment, string or block — can produce one.
 */
function bodyOf(name: string): string | null {
    const start = new RegExp(`\\n(?:export )?function ${name}\\(`).exec(BACKGROUND)?.index ?? -1;
    if (start < 0) return null;
    const end = BACKGROUND.indexOf('\n}\n', start);
    return end < 0 ? null : BACKGROUND.slice(start, end);
}

/** The window options a real Genie window declares. */
const WINDOW_SHAPE = [
    'frame:',
    'title:',
    'backgroundColor:',
    'minWidth:',
    'minHeight:',
    'show:',
    'webPreferences:',
];

describe('the Flow editor gets its own window', () => {
    it('POSITIVE CONTROL: the reader finds the window it is copying', () => {
        // If `bodyOf` broke — a moved file, a reformatted declaration — every
        // assertion below would report "missing" and the suite would guard
        // nothing. So the pattern being copied is read FIRST, and its own shape
        // asserted, before anything is claimed about the new one.
        const settings = bodyOf('createSettingsWindow');
        expect(settings, 'createSettingsWindow is gone — has background.ts moved?').not.toBeNull();
        for (const key of WINDOW_SHAPE) {
            expect(settings, `the reference window no longer declares ${key}`).toContain(key);
        }
        expect(bodyOf('createNoSuchWindowExists')).toBeNull();
    });

    it('is a real BrowserWindow with the same shape', () => {
        const flow = bodyOf('createFlowEditorWindow');

        expect(
            flow,
            'the Flow editor has no window factory — it is still a card in another window',
        ).not.toBeNull();
        expect(flow).toContain('new BrowserWindow');
        for (const key of WINDOW_SHAPE) {
            expect(flow, `the Flow editor window does not declare ${key}`).toContain(key);
        }
    });

    it('loads its own route in dev AND its own packaged HTML', () => {
        const flow = bodyOf('createFlowEditorWindow')!;

        // Both halves, because only one of them is exercised by `npm run dev`.
        // A window that loads a dev URL and no `loadFile` is a window that is
        // blank in every shipped build, and nothing local would ever say so.
        expect(flow, 'no dev route — the window is blank under `npm run dev`').toContain(
            '/flow-editor',
        );
        expect(
            flow,
            'no packaged entry — the window is blank in every shipped build',
        ).toContain('flow-editor.html');
    });

    it('has a page for that route to load', () => {
        // `next.config.js` sets `output: 'export'`, so `pages/flow-editor.tsx`
        // IS `flow-editor.html`. Without the page the two loads above resolve to
        // a 404 and an ENOENT respectively.
        const page = path.join(ROOT, 'renderer/pages/flow-editor.tsx');
        expect(fs.existsSync(page), 'the window loads /flow-editor and no such page exists').toBe(
            true,
        );
        const src = read('renderer/pages/flow-editor.tsx');
        // The SAME editor the GApp Flows tab uses. A window that grew its own
        // copy is how the two surfaces start disagreeing about what a flow can
        // do.
        expect(src).toContain('FlowEditorPanel');
    });

    it('focuses an open editor instead of stacking another', () => {
        const show = bodyOf('showFlowEditorWindow');

        expect(show, 'nothing opens the window').not.toBeNull();
        // A module-level handle is what makes a second Edit a focus rather than
        // a second window. Keyed, so editing a different flow opens its own
        // window without destroying an unsaved graph in the first.
        expect(BACKGROUND).toMatch(/^const flowEditorWindows\b/m);
        expect(show).toContain('.focus()');
    });

    it('binds the window to the host its opener drives, and unbinds on close', () => {
        const flow = bodyOf('createFlowEditorWindow')!;

        // Genie#473 nearly shipped a panel listing the CLIENT machine's files
        // under a host's name. A window opened from a host window inherits that
        // window's connection so `api()` cannot quietly answer from the wrong
        // computer, and drops it on close so the shared host connection is not
        // torn down with it.
        expect(flow).toContain('bindWindowToConnection');
        expect(flow).toContain('unbindWindow');
    });
});

describe('and the modal it replaces is gone', () => {
    it('POSITIVE CONTROL: the Flow Manager still has its other dialogs', () => {
        // The absence asserted next is satisfied by an empty file. This is the
        // proof the flyout is still there and still renders prompt cards — so
        // the missing one is missing on purpose.
        expect(FLYOUT).toContain('prompt-card');
        expect(FLYOUT).toContain('DeleteConfirm');
    });

    it('does not render the editor inside a card any more', () => {
        expect(
            FLYOUT.includes('flowmgr-canvas'),
            'FlowManagerFlyout still renders the canvas modal — the editor is a window now',
        ).toBe(false);
        expect(
            FLYOUT.includes('FlowEditorPanel'),
            'FlowManagerFlyout still hosts the editor — Edit should open the window',
        ).toBe(false);
    });

    it('leaves no orphaned sizing rules behind in the stylesheet', () => {
        // `.flowmgr-canvas` existed only to widen `.prompt-card` far enough for a
        // graph. With the card gone the rules are dead CSS that reads as a live
        // surface to the next person who greps for it.
        const css = read('renderer/styles/master.css');
        expect(css).not.toContain('.flowmgr-canvas');
        // POSITIVE CONTROL: the Flow Manager's own rules are untouched, so the
        // assertion above is a deletion and not a missing stylesheet.
        expect(css).toContain('.flowmgr-row');
    });
});
