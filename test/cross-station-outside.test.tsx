import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../src/core/alerts.js';
import { mailAction } from '../src/core/agent-actions.js';
import { peerParticipant } from '../src/core/cross-station.js';
import { mailSignalsOfSend, readMailSignal } from '../src/core/mail-actions.js';
import { StationExchanges, readStationExchanges } from '../src/core/station-exchanges.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

/*
 * OUTSIDE COMMUNICATION (the owner, 2026-11-25: "outside communications get their own event for sounds and flows and there
 * is a visual display in the genie header during the exchange on the right side. The right side of the header is for host
 * related data like machine name, and incoming activity."). Mail that crosses to or from another of the owner's
 * workstations is its own sound row, and while an exchange is going on the header's right side shows the other station
 * and the direction, beside the workstation name.
 */

const B = '01m88e0vzh4a36rj22h53hfcwr';
const atlas = 'agent_0123456789abcdef0123456789abcdef';
const bolt = 'agent_fedcba9876543210fedcba9876543210';

describe('its own sound row', () => {
    it('"Mail crosses to or from another of your workstations", under Messages, None until chosen (every new kind)', () => {
        expect(ALERT_KINDS.find((k) => k.kind === 'outside')).toMatchObject({ group: 'messages', sound: 'off' });
    });

    it('mail to or from another station is that row, sounded on the local agent; local mail stays agentmail', () => {
        expect(mailAction({ from: atlas, to: peerParticipant(B, 'bolt', 'p8x') })).toEqual({ agentId: atlas, kind: 'outside' });
        expect(mailAction({ from: peerParticipant(B, 'bolt', 'p8x'), to: atlas })).toEqual({ agentId: atlas, kind: 'outside' });
        expect(mailAction({ from: atlas, to: bolt })).toEqual({ agentId: atlas, kind: 'agentmail' });
    });

    it('goes to the windows as a mail signal they read back', () => {
        const signals = mailSignalsOfSend(peerParticipant(B, 'bolt', 'p8x'), { id: 'msg_1', from: atlas, to: peerParticipant(B, 'bolt', 'p8x') });
        const outside = signals.find((s) => s.kind === 'outside');
        expect(outside).toEqual({ agentId: atlas, kind: 'outside' });
        expect(readMailSignal(outside)).toEqual({ agentId: atlas, kind: 'outside' });
    });
});

describe('an exchange, while it goes on', () => {
    it('is the other station and the direction; both ways is both; it ends a moment after the last of it', () => {
        let now = 0;
        const timers: Array<{ at: number; fn: () => void }> = [];
        const ex = new StationExchanges({ now: () => now, schedule: (ms, fn) => { const t = { at: now + ms, fn }; timers.push(t); return () => { timers.splice(timers.indexOf(t), 1); }; }, lingerMs: 3_000 });
        const seen: number[] = [];
        ex.onChange(() => seen.push(ex.view().length));
        const end = ex.begin(B, 'laptop', 'out');
        expect(ex.view()).toEqual([{ station: B, name: 'laptop', direction: 'out' }]);
        const endIn = ex.begin(B, 'laptop', 'in');
        expect(ex.view()).toEqual([{ station: B, name: 'laptop', direction: 'both' }]);
        end();
        endIn();
        expect(ex.view()).toHaveLength(1); // still showing: it lingers so a person can see it
        now = 3_000;
        for (const t of timers.splice(0)) t.fn();
        expect(ex.view()).toEqual([]);
        expect(seen.at(-1)).toBe(0);
    });

    it('a pulse (one message in) shows and clears by itself', () => {
        let now = 0;
        const timers: Array<() => void> = [];
        const ex = new StationExchanges({ now: () => now, schedule: (_ms, fn) => { timers.push(fn); return () => {}; }, lingerMs: 3_000 });
        ex.pulse(B, 'laptop', 'in');
        expect(ex.view()).toEqual([{ station: B, name: 'laptop', direction: 'in' }]);
        now = 3_000;
        for (const t of timers.splice(0)) t();
        expect(ex.view()).toEqual([]);
    });

    it('what crosses the wire reads back; anything else is nothing', () => {
        expect(readStationExchanges([{ station: B, name: 'laptop', direction: 'in' }, { station: 1 }, 'x'])).toEqual([{ station: B, name: 'laptop', direction: 'in' }]);
        expect(readStationExchanges(null)).toEqual([]);
    });
});

describe('the header’s right side', () => {
    const bar = (exchanges?: readonly { station: string; name: string; direction: 'in' | 'out' | 'both' }[]) =>
        renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'desk', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} {...(exchanges ? { stationExchanges: exchanges } : {})} />);

    it('shows the other station and the direction, before this workstation’s name', () => {
        const html = bar([{ station: B, name: 'laptop', direction: 'in' }]);
        expect(html).toMatch(/data-station-exchange="in"[\s\S]*laptop[\s\S]*data-workstation-health/);
        expect(bar([{ station: B, name: 'laptop', direction: 'out' }])).toContain('data-station-exchange="out"');
        expect(bar([{ station: B, name: 'laptop', direction: 'both' }])).toContain('data-station-exchange="both"');
    });

    it('nothing when no exchange goes on (positive control above)', () => {
        expect(bar()).not.toContain('data-station-exchange');
        expect(bar([])).not.toContain('data-station-exchange');
    });
});
