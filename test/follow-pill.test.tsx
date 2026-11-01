import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { Stream } from '../src/renderer/components/Stream.js';
import { control } from './helpers/control-markup.js';

/**
 * THE FOLLOW PILL (the board, bottom right of the Stream): `Following live` while the ledger tails its own end;
 * `Parked` once the reader scrolled away or arrived by a deep link — with `↓ n new` when rows arrived meanwhile. A
 * parked pill is the door back to the tail. Nothing is drawn over an empty Stream.
 *
 * REAL BUTTONS (the owner, 2026-11-01: "too many confusing UI that look like a button but aren't"): the two used to be the
 * same rounded, bordered pill, so the status looked pressable and the door looked like a status. Now `Following live`
 * is status TEXT (role="status", a live dot, no border) and `Parked` is a react-fancy Button with a jump-to-end icon.
 */
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    t('a1:1', { kind: 'message', speaker: 'agent', peerName: null, text: 'hello' }),
];
const render = (at: string | null) =>
    renderToStaticMarkup(<Stream rows={rows} lanes={null} at={at} selectedId={null} onSelect={() => {}} agentName="sable" />);

describe('the follow pill', () => {
    it('reads `Following live` while tailing', () => {
        const html = render(null);
        const live = /<span\b[^>]*data-follow="live"[^>]*>/.exec(html)?.[0] ?? '';
        expect(live, 'a span, not a control').not.toBe('');
        expect(live).toMatch(/\srole="status"/);
        // Not dressed as a button: no pill border, no rounded-full chip.
        expect(live).not.toMatch(/\bborder\b|rounded-full/);
        expect(html).toMatch(/data-follow="live"[^>]*>(<span[^>]*><\/span>)?Following live</);
        expect(html).not.toMatch(/<button\b[^>]*data-follow=/);
    });

    it('reads `Parked` after a deep link, and is a button back to the tail', () => {
        const html = render('a1:1');
        const parked = control(html, 'data-follow="parked"');
        expect(parked).toMatchObject({ tag: 'button', fancy: true, text: 'Parked' });
        expect(parked!.inner).toMatch(/data-action-icon="leading"/);
        expect(parked!.open).toMatch(/\stitle="[^"]+"/);
        expect(html).not.toContain('Following live');
    });

    it('is not drawn over an empty Stream', () => {
        const html = renderToStaticMarkup(<Stream rows={[]} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="sable" />);
        expect(html).not.toContain('data-follow=');
    });
});
