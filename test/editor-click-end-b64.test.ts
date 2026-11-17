import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clickToEnd, endOfText, type ClickLike, type TextEnd } from '../src/core/editor-click-end.js';

/**
 * A CLICK BELOW THE LAST LINE PUTS THE CURSOR AT THE END OF THE FILE (beta.64, the owner). fancy-code's editor is a
 * textarea exactly as tall as the text, inside a panel that fills the Files tab; a click in the empty part under a short
 * file landed on the panel and did nothing. Genie's wrapper around the panel turns that click into a caret at the end.
 */
const textarea = { getBoundingClientRect: () => ({ bottom: 200 }) };

function click(over: Partial<ClickLike> = {}) {
    let prevented = false;
    const ev: ClickLike = { button: 0, clientY: 350, target: { panel: true }, preventDefault: () => { prevented = true; }, ...over };
    return { ev, prevented: () => prevented };
}

describe('endOfText', () => {
    it('the last line, one past its last character (1-based, as fancy-code’s setCursor takes it)', () => {
        expect(endOfText('first\nsecond')).toEqual({ line: 2, column: 7 });
        expect(endOfText('ends with a newline\n')).toEqual({ line: 2, column: 1 });
        expect(endOfText('one')).toEqual({ line: 1, column: 4 });
        expect(endOfText('a\r\nbc')).toEqual({ line: 2, column: 3 });
    });
});

describe('clickToEnd', () => {
    it('a click under the last line puts the caret at the end, and the click does not also take focus away', () => {
        const set: TextEnd[] = [];
        const c = click();
        expect(clickToEnd(c.ev, textarea, () => 'a\nlast', (p) => set.push(p))).toBe(true);
        expect(set).toEqual([{ line: 2, column: 5 }]);
        expect(c.prevented()).toBe(true);
    });

    it('control: a click on the text itself, above the bottom, or with another button is left to the editor', () => {
        const set: TextEnd[] = [];
        const onText = click({ target: textarea });
        const above = click({ clientY: 150 });
        const right = click({ button: 2 });
        for (const c of [onText, above, right]) expect(clickToEnd(c.ev, textarea, () => 'x', (p) => set.push(p))).toBe(false);
        expect(clickToEnd(click().ev, null, () => 'x', (p) => set.push(p))).toBe(false);
        expect(set).toEqual([]);
        expect([onText, above, right].some((c) => c.prevented())).toBe(false);
    });
});

describe('the Files tab', () => {
    it('wraps the editor’s panel in the click-to-end surface, in view and edit modes alike', () => {
        const src = readFileSync('src/renderer/components/FilesPanel.tsx', 'utf8');
        expect(src).toMatch(/<PanelClickToEnd[^>]*>\s*<CodeEditor\.Panel/);
        const sync = readFileSync('src/renderer/components/EditorSync.tsx', 'utf8');
        expect(sync).toMatch(/export function PanelClickToEnd[\s\S]*clickToEnd\(/);
    });
});
