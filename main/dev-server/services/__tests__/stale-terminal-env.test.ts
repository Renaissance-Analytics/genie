import { beforeEach, describe, expect, it } from 'vitest';
import {
    forgetTerminalServiceEnv,
    incompleteServiceTerminals,
    incompleteTerminalNote,
    recordTerminalServiceEnv,
    staleServiceTerminals,
    staleTerminalNote,
    terminalEnvNotes,
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

/**
 * MISSING IS NOT WRONG (genie#540).
 *
 * Measured across two workspaces, `printenv` in a terminal of each, neither
 * restarted: workspace A had 3 `GENIE_MAIL_*`, workspace B had ZERO — with
 * Mailpit running for B. Not a naming problem, and not readiness: the service
 * was provisioned AFTER that terminal spawned, and a pty's environment cannot be
 * rewritten afterwards. Genie held both sides and said nothing, exactly as in
 * #222 — but the shape is different, and so is what it means.
 *
 * `staleServiceTerminals` deliberately does NOT report it. Its doc comment says
 * why, and the reasoning is right: a key that APPEARED is a missing value, not a
 * wrong one, and calling it stale would fire on every first `add`. Widening that
 * filter would reintroduce exactly the false positive it was written to avoid.
 *
 * So this is a SECOND state, not a wider first one:
 *
 *   - **stale** — a value the terminal holds is now wrong or withdrawn. It is
 *     dialling something that moved or is gone. A problem.
 *   - **incomplete** — the workspace publishes service env this terminal never
 *     received. Nothing it holds is wrong. Informational.
 *
 * Both are answered by the same two maps, and both are pure.
 */

const PG_LIVE = { PGHOST: '127.0.0.1', PGPORT: '51157' };
const MAIL_LIVE = {
    GENIE_MAIL_MAILER: 'smtp',
    GENIE_MAIL_HOST: '127.0.0.1',
    GENIE_MAIL_PORT: '1025',
};

describe('which open terminals never received a service at all', () => {
    it('names the SERVICE a terminal predates, not the raw keys', () => {
        recordTerminalServiceEnv('t1', { ...PG_LIVE });
        expect(incompleteServiceTerminals({ ...PG_LIVE, ...MAIL_LIVE }, ['t1'])).toEqual([
            {
                terminalId: 't1',
                services: ['Mailpit'],
                keys: ['GENIE_MAIL_HOST', 'GENIE_MAIL_MAILER', 'GENIE_MAIL_PORT'],
            },
        ]);
    });

    /**
     * POSITIVE CONTROL, and the one that catches a detector that flags
     * everything: a terminal holding exactly what the workspace publishes is
     * reported by NEITHER function.
     */
    it('says nothing about a terminal that is fully current — positive control', () => {
        recordTerminalServiceEnv('t1', { ...PG_LIVE, ...MAIL_LIVE });
        const live = { ...PG_LIVE, ...MAIL_LIVE };
        expect(staleServiceTerminals(live, ['t1'])).toEqual([]);
        expect(incompleteServiceTerminals(live, ['t1'])).toEqual([]);
    });

    /**
     * THE TWO STATES DO NOT OVERLAP. A missing service is incomplete and NOT
     * stale — the invariant `staleServiceTerminals`'s doc comment protects.
     */
    it('a terminal missing a service is incomplete and NOT stale', () => {
        recordTerminalServiceEnv('t1', { ...PG_LIVE });
        const live = { ...PG_LIVE, ...MAIL_LIVE };
        expect(staleServiceTerminals(live, ['t1'])).toEqual([]);
        expect(incompleteServiceTerminals(live, ['t1']).map((t) => t.services)).toEqual([
            ['Mailpit'],
        ]);
    });

    /** …and its mirror: a CHANGED value is stale and NOT incomplete. */
    it('a terminal whose value moved is stale and NOT incomplete', () => {
        recordTerminalServiceEnv('t1', { PGHOST: '127.0.0.1', PGPORT: '58783' });
        expect(staleServiceTerminals(PG_LIVE, ['t1'])).toEqual([
            { terminalId: 't1', keys: ['PGPORT'] },
        ]);
        expect(incompleteServiceTerminals(PG_LIVE, ['t1'])).toEqual([]);
    });

    /**
     * THE FALSE-POSITIVE CASE THE #222 COMMENT NAMES, DECIDED.
     *
     * A terminal that predates the workspace's FIRST service IS reported. The
     * exclusion in #222 was about the CLASSIFICATION — calling it stale — not
     * about the observation, which is true and is the worst instance of the
     * defect: that terminal has nothing, so `psql` connects to nothing and the
     * agent in it starts scraping `.env` for a credential Genie already holds.
     * Naming the service ("predates Postgres") reads correctly whether it is the
     * first service or the fifth, and the note is informational rather than an
     * alarm, so the objection that made the exclusion right for `stale` does not
     * carry.
     */
    it('reports a terminal that predates the workspace FIRST service', () => {
        recordTerminalServiceEnv('t1', {});
        expect(incompleteServiceTerminals(PG_LIVE, ['t1'])).toEqual([
            { terminalId: 't1', services: ['Postgres'], keys: ['PGHOST', 'PGPORT'] },
        ]);
    });

    /**
     * An ABSENT snapshot is not an empty one. Genie records what every terminal
     * in a workspace inherits, so no entry means Genie does not know what this
     * pty got — and a claim about it would be invented.
     */
    it('says nothing about a terminal it has no snapshot for', () => {
        expect(incompleteServiceTerminals(PG_LIVE, ['t3'])).toEqual([]);
    });

    it('ignores a terminal that is no longer open', () => {
        recordTerminalServiceEnv('t1', {});
        expect(incompleteServiceTerminals(PG_LIVE, [])).toEqual([]);
    });

    it('reports every affected terminal, in a stable order', () => {
        recordTerminalServiceEnv('t2', {});
        recordTerminalServiceEnv('t1', {});
        expect(incompleteServiceTerminals(PG_LIVE, ['t2', 't1']).map((t) => t.terminalId)).toEqual([
            't1',
            't2',
        ]);
    });

    it('lists several missing services once each, sorted', () => {
        recordTerminalServiceEnv('t1', {});
        const live = { ...PG_LIVE, ...MAIL_LIVE, GENIE_REDIS_HOST: '127.0.0.1' };
        expect(incompleteServiceTerminals(live, ['t1'])[0].services).toEqual([
            'Mailpit',
            'Postgres',
            'Redis',
        ]);
    });
});

describe('what the caller is told about an incomplete terminal', () => {
    it('names the terminals and the SERVICES, and says the app is unaffected', () => {
        const note = incompleteTerminalNote([
            { terminalId: 'term-a', services: ['Mailpit'], keys: ['GENIE_MAIL_HOST'] },
            {
                terminalId: 'term-b',
                services: ['Mailpit', 'Postgres'],
                keys: ['GENIE_MAIL_HOST', 'PGPORT'],
            },
        ]);
        expect(note).toContain('term-a');
        expect(note).toContain('term-b');
        expect(note).toContain('Mailpit');
        expect(note).toMatch(/new terminal/i);
        // Same property as the stale note, and it has to be said for the same
        // reason: `.env` is rewritten (#242), so nobody should go looking for a
        // broken application that is fine.
        expect(note).toMatch(/\.env|application/i);
    });

    /**
     * IT MUST NOT READ AS AN ALARM. Both remedies are "reopen the terminal", so
     * the only thing keeping the informational case from drowning the real one
     * is that they say different things.
     */
    it('does not describe the terminal as holding a wrong or old value', () => {
        const note = incompleteTerminalNote([
            { terminalId: 'term-a', services: ['Mailpit'], keys: ['GENIE_MAIL_HOST'] },
        ]);
        expect(note).not.toMatch(/stale|old (address|one)/i);
        expect(note).toMatch(/missing|never|predates/i);
    });

    it('falls back to naming the keys when a service cannot be named', () => {
        const note = incompleteTerminalNote([
            { terminalId: 'term-a', services: [], keys: ['GENIE_SERVICE_ODD_HOST'] },
        ]);
        expect(note).toContain('GENIE_SERVICE_ODD_HOST');
    });

    it('is null when nothing is incomplete — nothing to say', () => {
        expect(incompleteTerminalNote([])).toBeNull();
    });
});

/**
 * The composition the MCP layer needs, kept PURE.
 *
 * `manageService` has a workspace id, a live env and a list of open terminals;
 * everything after that is two comparisons and two sentences. Putting the
 * composition here rather than in the tool leaves that layer with nothing but
 * the I/O — which matters because the I/O is the part no unit test can reach.
 */
describe('both notes, shaped for one result', () => {
    it('omits a field entirely when there is nothing to say', () => {
        recordTerminalServiceEnv('t1', { ...PG_LIVE });
        expect(terminalEnvNotes({ ...PG_LIVE, ...MAIL_LIVE }, ['t1'])).toEqual({
            terminalsMissingEnv: expect.stringContaining('Mailpit'),
        });
    });

    /** POSITIVE CONTROL: a workspace where nothing is wrong produces NO fields,
     *  so a caller spreading this adds nothing to its result. */
    it('is empty for a terminal that is fully current', () => {
        recordTerminalServiceEnv('t1', { ...PG_LIVE, ...MAIL_LIVE });
        expect(terminalEnvNotes({ ...PG_LIVE, ...MAIL_LIVE }, ['t1'])).toEqual({});
    });

    it('reports a terminal that is BOTH stale and incomplete under both names', () => {
        // Its Postgres moved AND it predates Mailpit: two true facts about one
        // terminal that mean different things, so they are said separately.
        recordTerminalServiceEnv('t1', { PGHOST: '127.0.0.1', PGPORT: '58783' });
        const both = terminalEnvNotes({ ...PG_LIVE, ...MAIL_LIVE }, ['t1']);
        expect(both.note).toContain('PGPORT');
        expect(both.terminalsMissingEnv).toContain('Mailpit');
        expect(both.note).not.toContain('Mailpit');
    });
});
