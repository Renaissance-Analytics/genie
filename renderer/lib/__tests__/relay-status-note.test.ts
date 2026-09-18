import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { relayStatusNote } from '../relay-status-note';

/**
 * What Settings says about reaching this computer over Tynn (genie#451, genie#680).
 *
 * It used to render "Tynn: authenticated relay enabled" whenever the Tynn switch was
 * on, under "Active listeners", on every install, while nothing dialled a relay. The
 * note now reports the relay host's own status, and never claims a link it lacks.
 */

describe('relayStatusNote', () => {
    it('says nothing when the Tynn network is switched off', () => {
        expect(relayStatusNote({ state: 'connected', relay: 'wss://relay.geniecloud.link' }, false)).toBeNull();
    });

    it('says nothing before the status has loaded, rather than guessing', () => {
        expect(relayStatusNote(undefined, true)).toBeNull();
    });

    it('says the relay is reachable only when the link is actually up', () => {
        expect(relayStatusNote({ state: 'connected', relay: 'wss://relay.geniecloud.link' }, true)).toEqual({
            text: 'Tynn: reachable through the relay',
            tone: 'ok',
        });
    });

    it('says it is connecting while it is', () => {
        expect(relayStatusNote({ state: 'connecting' }, true)).toEqual({
            text: 'Tynn: connecting to the relay…',
            tone: 'neutral',
        });
    });

    it('says it is off while Genie Remote is off, even with Tynn allowed', () => {
        expect(relayStatusNote({ state: 'off' }, true)).toEqual({
            text: 'Tynn: off while Genie Remote is off',
            tone: 'neutral',
        });
    });

    it('says it cannot be reached, and why', () => {
        expect(
            relayStatusNote(
                { state: 'unavailable', reason: 'no_relay', message: 'No relay is configured for this workstation, so it cannot be reached over Tynn.' },
                true,
            ),
        ).toEqual({
            text: 'Tynn: not reachable. No relay is configured for this workstation, so it cannot be reached over Tynn.',
            tone: 'bad',
        });
    });

    it('never repeats the old claim, whatever the state', () => {
        const states = [
            { state: 'off' },
            { state: 'connecting' },
            { state: 'connected', relay: 'wss://r' },
            { state: 'unavailable', reason: 'not_enrolled', message: 'Sign in.' },
        ] as const;
        for (const s of states) expect(relayStatusNote(s, true)?.text).not.toMatch(/enabled/);
    });
});

describe('Settings', () => {
    // A source check, because Settings is not rendered in unit tests. The positive
    // control is that the page does call the note; without it, a renamed file would
    // pass the negative check on nothing.
    const source = readFileSync(join(__dirname, '../../pages/settings.tsx'), 'utf8');

    it('shows the relay host status note', () => {
        expect(source).toContain('relayStatusNote(status?.relay, networkAccess.tynn)');
    });

    it('no longer claims the relay is enabled', () => {
        expect(source).not.toContain('authenticated relay enabled');
    });
});
