// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBoard } from '../src/core/tynn-board.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';

/**
 * A CARD'S LABEL NEVER SQUEEZES ITS TITLE (Tynn #676; the owner, 2026-11-13, a screenshot of the Tynn tab's version board:
 * "they don't handle the labels correctly"). A version's label is its number — `2.0.0-beta.63`, `2.0.0-host-split` — and
 * it sat in the title's row, never shrinking, so the title was left a sliver that wrapped every word or two. The label
 * goes on its own line above the title, cut short with its whole text as a tooltip, and the title's row is the title's.
 */
const noop = () => {};
const LONG = '2.0.0-host-split';
const VERSIONS = parseBoard({
    project_id: 'p1', level: 'versions', version_id: null, story_id: null, active_story: null, active_version: null, stories: null, tasks: null,
    versions: [
        { id: 'v1', number: LONG, title: 'Genie 2 host split: genie-host runs the work, the window is a client', status: 'active', story_count: 1, stories_done: 0, task_count: 0, tasks_done: 0 },
        { id: 'v2', number: null, title: 'A draft with no number yet', status: 'draft', story_count: 0, stories_done: 0, task_count: 0, tasks_done: 0 },
    ],
})!;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<TynnBoardPanel state={{ state: 'ready', view: VERSIONS }} onScope={noop} onAction={noop} />));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const cardOf = (id: string) => host.querySelector<HTMLElement>(`[data-tynn-card="${id}"]`)!;
/** The element whose own text is exactly `text` (the label's or the title's node, not a container of it). */
const leaf = (scope: HTMLElement, text: string): HTMLElement | null =>
    [...scope.querySelectorAll<HTMLElement>('*')].find((el) => el.children.length === 0 && el.textContent === text) ?? null;

describe('a board card\'s label and title (Tynn #676)', () => {
    it('CONTROL: the card shows both its label and its title', () => {
        const card = cardOf('v1');
        expect(leaf(card, LONG)).not.toBeNull();
        expect(leaf(card, 'Genie 2 host split: genie-host runs the work, the window is a client')).not.toBeNull();
    });

    it('the label is not in the title\'s row: no element holds both', () => {
        const card = cardOf('v1');
        const label = leaf(card, LONG)!;
        const title = leaf(card, 'Genie 2 host split: genie-host runs the work, the window is a client')!;
        // The title's parent is its row; the label must not be inside it.
        expect(title.parentElement!.contains(label)).toBe(false);
    });

    it('the label comes before the title, on a line of its own that can cut it short, with its whole text as a tooltip', () => {
        const card = cardOf('v1');
        const label = leaf(card, LONG)!;
        const title = leaf(card, 'Genie 2 host split: genie-host runs the work, the window is a client')!;
        expect(label.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(label.className).toMatch(/\btruncate\b/);
        expect(label.getAttribute('title')).toBe(LONG);
        expect(label.className).not.toMatch(/\bshrink-0\b/);
    });

    it('a card with no label has no empty label line', () => {
        const card = cardOf('v2');
        expect(card.querySelector('[data-tynn-card-label]')).toBeNull();
        expect(cardOf('v1').querySelector('[data-tynn-card-label]')).not.toBeNull();
    });
});
