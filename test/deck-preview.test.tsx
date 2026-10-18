import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deckPreview, type DeckItem, type SignalState } from '../src/core/deck.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { Deck } from '../src/renderer/components/Deck.js';

/**
 * A LONG DECK ITEM OPENS ON CLICK (the owner, 2026-10-18: "the deck items need to have better rendering, don't display
 * all content but open up on click to read full context"). A to-do written as full instructions — the way the protocol
 * now asks — is many lines; drawn whole, five of them are a wall. The row shows its first line, and a click on it (or on
 * "Show all") opens the whole text with its line breaks. A short, one-line item is shown whole, with nothing to open.
 */
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const LONG = 'Omarchy test VM, part 1 of 3: unlock it and open a terminal (about 1 minute).\n1. Find the VirtualBox window titled "omarchy".\n2. At the disk-encryption prompt, type your disk passphrase and press Enter.\n3. Log in.\n4. Press Super+Enter.\n5. Mark this item Done.';
const SHORT = 'Update Genie to beta.23 (click the header’s update notice).';

const itemsOf = (texts: string[]): DeckItem[] =>
    deckItemsFrom({
        questions: [],
        userList: texts.map((text, i) => ({ workspaceId: 'tynn', item: { id: `li_${i}`, text, askedBy: 'tynn', createdAt: '2026-10-18T10:00:00.000Z', done: false } })),
        unreadDms: [], finished: [], agents: {}, workspaceNames: {},
    } as unknown as Parameters<typeof deckItemsFrom>[0]);
const render = (items: readonly DeckItem[]) =>
    renderToStaticMarkup(<Deck items={items} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} now={NOW} />);

describe('the preview', () => {
    it('a multi-line item: its first line, and there is more', () => {
        expect(deckPreview(LONG)).toEqual({ preview: 'Omarchy test VM, part 1 of 3: unlock it and open a terminal (about 1 minute).', more: true });
    });

    it('one long line is cut at a word, with an ellipsis', () => {
        const p = deckPreview('word '.repeat(60).trim());
        expect(p.more).toBe(true);
        expect(p.preview.length).toBeLessThanOrEqual(141);
        expect(p.preview.endsWith('…')).toBe(true);
    });

    it('CONTROL: a short one-line item is whole, nothing more', () => {
        expect(deckPreview(SHORT)).toEqual({ preview: SHORT, more: false });
    });
});

describe('the row', () => {
    it('collapsed: the first line and Show all — the rest is NOT drawn until opened', () => {
        const html = render(itemsOf([LONG]));
        expect(html).toMatch(/Omarchy test VM, part 1 of 3/);
        expect(html).not.toMatch(/disk-encryption prompt/);
        expect(html).toMatch(/data-action="deck-expand"[^>]*>Show all</);
    });

    it('CONTROL: a short item is drawn whole, with nothing to open (COUNTED: one expand for two items)', () => {
        const html = render(itemsOf([SHORT, LONG]));
        expect(html).toContain(SHORT.replace('’', '’'));
        expect(html.match(/data-action="deck-expand"/g)).toHaveLength(1);
    });
});
