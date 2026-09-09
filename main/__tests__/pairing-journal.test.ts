import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
    PAIRING_JOURNAL_MAX,
    _resetPairingJournalForTest,
    pairingJournalPath,
    readPairingJournal,
    recordPairingEvent,
    setPairingJournalDir,
} from '../pairing-journal';
import { cleanupTmpRoot, makeTmpDir } from '../../test/helpers';

/**
 * The pairing journal — the durable answer to "why did it ask for the PIN
 * again?".
 *
 * Genie writes no application log, so every way pairing can be dropped used to
 * vanish with the process that dropped it. These prove the journal survives the
 * restart it is describing, stays bounded, and — the point of a file we tell
 * users to hand over — never carries a token or a PIN.
 */

afterEach(() => _resetPairingJournalForTest());
afterAll(() => cleanupTmpRoot());

describe('pairing journal', () => {
    it('appends one JSON object per line, newest last, and reads them back', () => {
        const dir = makeTmpDir('pairing-journal');
        setPairingJournalDir(dir);
        recordPairingEvent({ side: 'host', event: 'host-store-absent' });
        recordPairingEvent({ side: 'client', event: 'client-token-missing', detail: { host: 'host:A' } });

        const file = path.join(dir, 'genie-pairing-journal.jsonl');
        expect(pairingJournalPath()).toBe(file);
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

        const entries = readPairingJournal();
        expect(entries.map((e) => e.event)).toEqual(['host-store-absent', 'client-token-missing']);
        expect(entries[1].side).toBe('client');
        expect(entries[1].detail.host).toBe('host:A');
        expect(typeof entries[0].at).toBe('string');
    });

    it('keeps the NEWEST entries when it hits the cap (an old boot cannot crowd out today)', () => {
        const dir = makeTmpDir('pairing-journal-cap');
        setPairingJournalDir(dir);
        const total = PAIRING_JOURNAL_MAX + 5;
        for (let i = 0; i < total; i++) {
            recordPairingEvent({ side: 'host', event: 'host-store-restored', detail: { n: i } });
        }
        const entries = readPairingJournal();
        expect(entries).toHaveLength(PAIRING_JOURNAL_MAX);
        expect(entries[entries.length - 1].detail.n).toBe(total - 1);
        expect(entries[0].detail.n).toBe(total - PAIRING_JOURNAL_MAX);
    });

    it('REDACTS secret-shaped detail keys while keeping the diagnostic ones', () => {
        const dir = makeTmpDir('pairing-journal-secret');
        setPairingJournalDir(dir);
        recordPairingEvent({
            side: 'client',
            event: 'client-token-saved',
            // `host` and `reason` are what makes the entry useful; `token` and
            // `pin` are exactly what must never reach a file a user pastes into
            // a chat. Both halves are asserted so "no token" cannot pass merely
            // because nothing at all was written.
            detail: { host: 'host:A', reason: 'ok', token: 'deadbeefcafe', pin: '123456' },
        });
        const raw = fs.readFileSync(path.join(dir, 'genie-pairing-journal.jsonl'), 'utf8');
        expect(raw).toContain('host:A'); // positive control — the entry IS there
        expect(raw).toContain('"reason":"ok"');
        expect(raw).not.toContain('deadbeefcafe');
        expect(raw).not.toContain('123456');
        expect(readPairingJournal()[0].detail.token).toBe('<redacted>');
    });

    it('is a no-op (never throws, writes nothing) with no directory set', () => {
        _resetPairingJournalForTest();
        expect(pairingJournalPath()).toBeNull();
        expect(() => recordPairingEvent({ side: 'host', event: 'host-store-absent' })).not.toThrow();
        expect(readPairingJournal()).toEqual([]);
    });

    it('survives a garbled line rather than losing the whole journal', () => {
        const dir = makeTmpDir('pairing-journal-garbled');
        setPairingJournalDir(dir);
        fs.writeFileSync(path.join(dir, 'genie-pairing-journal.jsonl'), 'not json\n');
        recordPairingEvent({ side: 'host', event: 'host-store-absent' });
        const entries = readPairingJournal();
        expect(entries).toHaveLength(1);
        expect(entries[0].event).toBe('host-store-absent');
    });
});
