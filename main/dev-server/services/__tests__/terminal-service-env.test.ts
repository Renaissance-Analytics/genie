import { describe, expect, it } from 'vitest';
import { terminalServiceEnv } from '../env-wiring';

/**
 * What a TERMINAL is allowed to inherit from the managed services (genie#221).
 *
 * ## The bug this exists to make impossible
 *
 * Genie exported the managed database credentials into every terminal, including
 * `DB_CONNECTION` and `DB_DATABASE`. Running a Laravel test suite in one of those
 * terminals EMPTIED the development database, and reported `99 passed`.
 *
 * Three reasonable things lined up:
 *
 *  1. Genie put `DB_*` in the shell environment.
 *  2. PHPUnit's `<env>` defaults to `force="false"` — "set this only if it is not
 *     already in the environment" — so the `DB_CONNECTION=sqlite` /
 *     `DB_DATABASE=:memory:` lines that EVERY Laravel skeleton ships were skipped.
 *  3. `RefreshDatabase` then ran `migrate:fresh` against what was configured,
 *     which was now the live workspace Postgres.
 *
 * `force="true"` does not even save you: PHPUnit writes `<env>` to `$_ENV` and
 * `putenv()` but never to `$_SERVER`, and Laravel's Dotenv adapter chain reads
 * `$_SERVER` first — where the ambient shell variables are, for the CLI SAPI.
 * (We hit the same precedence in Tynn's own phpunit.xml.)
 *
 * ## The rule
 *
 * A terminal gets the CLIENT credentials, not the APPLICATION's configuration.
 *
 *  - `PG*` / `MYSQL_*` are what `psql` and `mysql` read. Nothing treats them as
 *    "the datastore this app uses", so they cannot redirect a framework, and
 *    keeping them is what makes `psql` work with nothing typed.
 *  - `DB_*`, `DATABASE_URL` and `REDIS_*` are names frameworks reserve for their
 *    own config. Ambient values silently outrank the project's test settings, so
 *    they are withheld — and re-exposed under `GENIE_`, so nothing is lost and an
 *    agent that genuinely wants the managed connection can still read it.
 *
 * SITES and PROCESSES are untouched: a served app and a `queue:work` genuinely
 * are the application and need its configuration. Only the interactive shell —
 * where a test suite gets typed — is narrowed.
 */

const FULL = {
    PGHOST: '127.0.0.1',
    PGPORT: '58783',
    PGUSER: 'ws_abc',
    PGPASSWORD: 'secret',
    PGDATABASE: 'ws_abc',
    DATABASE_URL: 'postgresql://ws_abc:secret@127.0.0.1:58783/ws_abc',
    DB_CONNECTION: 'pgsql',
    DB_HOST: '127.0.0.1',
    DB_PORT: '58783',
    DB_DATABASE: 'ws_abc',
    DB_USERNAME: 'ws_abc',
    DB_PASSWORD: 'secret',
    REDIS_URL: 'redis://ws_abc:secret@127.0.0.1:51032',
    REDIS_HOST: '127.0.0.1',
    REVERB_APP_ID: 'ws_abc',
    MAIL_MAILER: 'smtp',
    AWS_BUCKET: 'ws-abc',
};

describe('the names a framework reads as its own config', () => {
    it('never reach a terminal — this is the whole bug', () => {
        const env = terminalServiceEnv(FULL);

        for (const key of [
            'DB_CONNECTION',
            'DB_HOST',
            'DB_PORT',
            'DB_DATABASE',
            'DB_USERNAME',
            'DB_PASSWORD',
            'DATABASE_URL',
            'REDIS_URL',
            'REDIS_HOST',
        ]) {
            expect(env, `${key} must not be in a terminal's environment`).not.toHaveProperty(key);
        }
    });

    it('are still available, under a name nothing reserves', () => {
        // Withheld, not discarded: an agent that wants the managed connection can
        // still read it, and it can no longer be picked up by accident.
        const env = terminalServiceEnv(FULL);

        expect(env.GENIE_DB_DATABASE).toBe('ws_abc');
        expect(env.GENIE_DB_CONNECTION).toBe('pgsql');
        expect(env.GENIE_DATABASE_URL).toBe('postgresql://ws_abc:secret@127.0.0.1:58783/ws_abc');
        expect(env.GENIE_REDIS_URL).toBe('redis://ws_abc:secret@127.0.0.1:51032');
    });
});

describe('the client-tool credentials', () => {
    it('survive untouched, so psql and mysql still work with nothing typed', () => {
        // This is the half of the feature worth keeping. `psql` reads PG*; no
        // framework treats them as its datastore config, so they cannot redirect
        // a test suite.
        const env = terminalServiceEnv(FULL);

        expect(env.PGHOST).toBe('127.0.0.1');
        expect(env.PGPORT).toBe('58783');
        expect(env.PGUSER).toBe('ws_abc');
        expect(env.PGPASSWORD).toBe('secret');
        expect(env.PGDATABASE).toBe('ws_abc');
    });

    it('leaves everything that is not a datastore alone', () => {
        // Deliberately NOT stripped. These cannot destroy state a test run
        // touches, and taking them away would break a dev server someone starts
        // from a terminal for no safety gain.
        const env = terminalServiceEnv(FULL);

        expect(env.REVERB_APP_ID).toBe('ws_abc');
        expect(env.MAIL_MAILER).toBe('smtp');
        expect(env.AWS_BUCKET).toBe('ws-abc');
    });
});

describe('edges', () => {
    it('returns an empty env for an empty env, rather than a pile of GENIE_ keys', () => {
        expect(terminalServiceEnv({})).toEqual({});
    });

    it('does not double-prefix something already namespaced', () => {
        expect(terminalServiceEnv({ GENIE_DB_HOST: 'x' })).toEqual({ GENIE_DB_HOST: 'x' });
    });
});
