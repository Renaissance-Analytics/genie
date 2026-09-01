import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addPanelMainButton } from '../add-panel-button';

/**
 * The workspace-header launcher is a PLUS ICON, not a labelled pill. The owner's
 * words: "get rid of this button... It should just be a plus icon button, not
 * this ugly thing."
 *
 * Dropping the visible text is the easy half; the half that regresses silently
 * is the ACCESSIBLE NAME. A bare glyph with no `aria-label` reads as "button"
 * to a screen reader and shows no tooltip on hover, so the name is asserted
 * here for every mode — icon-only included — rather than left to review.
 *
 * There is no DOM harness in this lane (see vitest.config.ts), so the naming
 * decision lives in a pure helper that is tested directly, and the two facts
 * that can only be seen in JSX — the header call site asking for the icon, and
 * the icon actually being a plus — are read out of the source the way
 * modal-header-composition.test.ts and spec-menu-language.test.ts do.
 */

const RENDERER_DIR = path.resolve(__dirname, '../..');

const read = (rel: string) => fs.readFileSync(path.join(RENDERER_DIR, rel), 'utf8');

/** The single `<TerminalTypeSplitButton ... />` element in a source file. */
function splitButtonTag(src: string): string {
    const m = /<TerminalTypeSplitButton[\s\S]*?\/>/.exec(src);
    if (!m) throw new Error('no <TerminalTypeSplitButton /> in this file');
    return m[0];
}

const splitButtonSource = () => read('components/Master/TerminalTypeSplitButton.tsx');

/**
 * The `<button>` that draws the plus glyph, as source text. A `<button` opening
 * tag here spans several lines and its own prop expressions contain `>`
 * (`() => …`), so this splits on the tag name and keeps the fragment the glyph
 * falls in rather than trying to match a balanced element.
 */
function plusButtonMarkup(): string {
    const chunk = splitButtonSource()
        .split(/<button\b/)
        .find((c) => c.includes('<IconPlus'));
    if (!chunk) throw new Error('no <button> draws <IconPlus />');
    return chunk;
}

describe('the Add Panel button keeps its name when it loses its label', () => {
    it('shows no visible text in icon mode', () => {
        const b = addPanelMainButton({ panelLauncher: true, iconOnly: true });
        expect(b.iconOnly).toBe(true);
        expect(b.label).toBeNull();
    });

    it('still names itself for assistive tech and hover', () => {
        const b = addPanelMainButton({ panelLauncher: true, iconOnly: true });
        expect(b.accessibleName).toBe('Add a panel');
        expect(b.title).toBe('Add a panel');
    });

    it('names the agent-only launcher too', () => {
        const b = addPanelMainButton({ agentOnly: true, iconOnly: true });
        expect(b.accessibleName).toBe('Create a workspace agent');
    });

    it('names the last-used type when it repeats one', () => {
        const b = addPanelMainButton({ lastTypeLabel: 'Claude Code', iconOnly: true });
        expect(b.accessibleName).toBe('Add Claude Code');
    });

    it('lets the disabled reason take the tooltip without erasing the name', () => {
        const b = addPanelMainButton({
            panelLauncher: true,
            iconOnly: true,
            disabled: true,
            disabledReason: 'Activate a workspace first',
        });
        expect(b.title).toBe('Activate a workspace first');
        expect(b.accessibleName).toBe('Add a panel');
    });

    it('keeps the visible label where it is not icon-only (the sidebar row)', () => {
        const b = addPanelMainButton({ panelLauncher: true });
        expect(b.iconOnly).toBe(false);
        expect(b.label).toBe('Add Panel…');
    });
});

describe('the workspace header actually asks for the icon', () => {
    it('master.tsx passes iconOnly to its launcher', () => {
        expect(splitButtonTag(read('pages/master.tsx'))).toMatch(/\biconOnly\b/);
    });

    it('the icon-only branch draws a plus, not the terminal-type glyph', () => {
        expect(splitButtonSource()).toMatch(/<IconPlus\b/);
    });

    it('the plus button carries an aria-label', () => {
        // The name is what survives the missing text, so pin it at the source:
        // nobody gets to trim it as redundant next to `title`.
        expect(plusButtonMarkup()).toMatch(/aria-label=/);
    });
});
