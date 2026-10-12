import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { Stream } from '../src/renderer/components/Stream.js';

/**
 * THE FOLLOW PILL (the board, bottom right of the Stream): `Following live` while the ledger tails its own end;
 * `Parked` once the reader scrolled away or arrived by a deep link — with `↓ n new` when rows arrived meanwhile. A
 * parked pill is the door back to the tail. Nothing is drawn over an empty Stream.
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
        expect(render(null)).toMatch(/data-follow="live"[^>]*>[^<]*Following live/);
    });

    it('reads `Parked` after a deep link, and is a button back to the tail', () => {
        const html = render('a1:1');
        expect(html).toMatch(/<button[^>]*data-follow="parked"[^>]*>[^<]*Parked/);
        expect(html).not.toContain('Following live');
    });

    it('is not drawn over an empty Stream', () => {
        const html = renderToStaticMarkup(<Stream rows={[]} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="sable" />);
        expect(html).not.toContain('data-follow=');
    });
});
