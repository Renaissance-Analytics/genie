import { beforeEach, describe, expect, it } from 'vitest';
import {
    forgetTerminalServiceEnv,
    recordTerminalServiceEnv,
    staleServiceTerminals,
    staleTerminalNote,
} from '../stale-terminal-env';

/**
 * A TERMINAL'S SERVICE ENV IS BAKED IN AT SPAWN (genie#222, the residual).
 *
 * #242 took the application's own configuration out of a terminal's environment
 * and put it in the repo's `.env`, which Genie keeps current — so a moved port
 * no longer silently overrides a corrected `.env`. What #242 deliberately leaves
 * in the pty is the CLIENT-TOOL credentials (`PG*`, `MYSQL_*`), so `psql`
 * connects with nothing typed.
 *
 * Those are still a snapshot. A pty's environment cannot be rewritten after
 * spawn, so when the engine is recreated on a new published port every terminal
 * that was already open keeps dialling the old one. The issue's words:
 *
 *   > A terminal's service env is baked in at creation and there is no way to
 *   > re-inherit it. The only remedy today is opening a new terminal, and
 *   > NOTHING TELLS YOU that is what you need.
 *
 * The first half is a property of ptys and is not fixable. The second half is
 * the defect: Genie knew both values and said nothing. `onPortMoved` went to
 * `console.warn`, which no user or agent reads.
 *
 * So the comparison is made where somebody is already asking — `manageService`
 * — and it is PURE, because "which terminals are stale" is a question about two
 * maps and must be answerable without a pty.
 */

beforeEach(() => {
    for (const id of ['t1', 't2', 't3']) forgetTerminalServiceEnv(id);
});

describe('which open terminals carry a stale service address', () => {
    it('names a terminal whose inherited value no longer matches the live one', () => {
        recordTerminalServiceEnv('t1', { PGHOST: '127.0.0.1', PGPORT: '58783' });
        const stale = staleServiceTerminals({ PGHOST: '127.0.0.1', PGPORT: '51157' }, ['t1']);
        expect(stale).toEqual([{ terminalId: 't1', keys: ['PGPORT'] }]);
    });

    /**
     * POSITIVE CONTROL. Every assertion below is "nothing is reported", which
     * passes just as well against a comparison that never reports anything.
     */
    it('says nothing about a terminal that matches — positive control', () => {
        recordTerminalServiceEnv('t1', { PGHOST: '127.0.0.1', PGPORT: '51157' });
        expect(staleServiceTerminals({ PGHOST: '127.0.0.1', PGPORT: '51157' }, ['t1'])).toEqual([]);
    });

    it('ignores a terminal that is no longer open', () => {
        recordTerminalServiceEnv('t1', { PGPORT: '58783' });
        // `live` is the caller's list of terminals that still exist. A closed one
        // cannot be dialling anything, and naming it would send someone to a
        // terminal that is not there.
        expect(staleServiceTerminals({ PGPORT: '51157' }, [])).toEqual([]);
    });

    it('ignores a terminal that inherited no service env at all', () => {
        expect(staleServiceTerminals({ PGPORT: '51157' }, ['t3'])).toEqual([]);
    });

    /**
     * A KEY THAT APPEARED is not staleness. A workspace that had no Postgres
     * when the terminal opened and has one now leaves that terminal without the
     * variable — which is a missing value, not a wrong one, and telling someone
     * their terminal is stale for it would fire on every first `add`.
     */
    it('does not call a terminal stale for a key it never had', () => {
        recordTerminalServiceEnv('t1', { PGPORT: '51157' });
        expect(
            staleServiceTerminals({ PGPORT: '51157', MYSQL_TCP_PORT: '3306' }, ['t1']),
        ).toEqual([]);
    });

    /** A key that went AWAY is stale: the terminal is still pointing at an
     *  engine this workspace no longer has. */
    it('reports a key the workspace no longer publishes', () => {
        recordTerminalServiceEnv('t1', { PGPORT: '51157' });
        expect(staleServiceTerminals({}, ['t1'])).toEqual([
            { terminalId: 't1', keys: ['PGPORT'] },
        ]);
    });

    it('re-recording a terminal replaces its snapshot rather than merging', () => {
        recordTerminalServiceEnv('t1', { PGPORT: '58783' });
        recordTerminalServiceEnv('t1', { PGPORT: '51157' });
        expect(staleServiceTerminals({ PGPORT: '51157' }, ['t1'])).toEqual([]);
    });

    it('reports every affected terminal, in a stable order', () => {
        recordTerminalServiceEnv('t2', { PGPORT: '1' });
        recordTerminalServiceEnv('t1', { PGPORT: '2' });
        expect(staleServiceTerminals({ PGPORT: '9' }, ['t2', 't1']).map((s) => s.terminalId)).toEqual(
            ['t1', 't2'],
        );
    });
});

describe('what the caller is told', () => {
    it('names the terminals and the remedy, and says the app config is unaffected', () => {
        const note = staleTerminalNote([
            { terminalId: 'term-a', keys: ['PGPORT'] },
            { terminalId: 'term-b', keys: ['PGPORT', 'PGHOST'] },
        ]);
        expect(note).toContain('term-a');
        expect(note).toContain('term-b');
        expect(note).toMatch(/new terminal/i);
        // The half #242 already fixed must not be re-alarmed: an app reads the
        // `.env`, which Genie rewrote, so only the shell's `psql`/`mysql` are
        // affected. Saying otherwise would send someone to look at a file that
        // is already correct.
        expect(note).toMatch(/psql|client|shell/i);
    });

    it('is null when nothing is stale — nothing to say', () => {
        expect(staleTerminalNote([])).toBeNull();
    });
});
