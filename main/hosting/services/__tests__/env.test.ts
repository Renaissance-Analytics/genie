import { describe, expect, it } from 'vitest';
import {
    applyManagedEnv,
    quoteEnvValue,
    renderManagedEnv,
    serviceEnvVars,
    MANAGED_BEGIN,
    MANAGED_END,
} from '../env';
import type { ServiceInstance } from '../types';

/**
 * The contract these defend: Genie writes into a file it does not own.
 *
 * A Laravel `.env` holds real credentials and is almost always git-ignored, so a
 * value this code clobbers is not recoverable from history — there is no undo.
 * That makes "everything outside the markers survives byte for byte" the single
 * most important property in the service manager, and the one worth the most
 * hostile tests: a user's block that LOOKS like ours, a half-deleted marker, CRLF
 * files, keys the user also sets themselves.
 */

// --- fixtures --------------------------------------------------------------

const pg: ServiceInstance = {
    id: 'pg1',
    workspaceId: 'w1',
    kind: 'postgres',
    engine: 'postgres',
    port: 21432,
    dataDir: '/data/pg1',
    user: 'genie',
    password: 'sekrit',
    database: 'genie',
};

const redis: ServiceInstance = {
    id: 'rd1',
    workspaceId: 'w1',
    kind: 'redis',
    engine: 'garnet',
    port: 21379,
    dataDir: '/data/rd1',
};

describe('serviceEnvVars', () => {
    it('describes a managed postgres the way Laravel expects', () => {
        expect(serviceEnvVars([pg])).toEqual({
            DB_CONNECTION: 'pgsql',
            DB_HOST: '127.0.0.1',
            DB_PORT: '21432',
            DB_DATABASE: 'genie',
            DB_USERNAME: 'genie',
            DB_PASSWORD: 'sekrit',
        });
    });

    it('describes a managed redis', () => {
        expect(serviceEnvVars([redis])).toEqual({ REDIS_HOST: '127.0.0.1', REDIS_PORT: '21379' });
    });

    it('never points the app AT the services it merely made reachable', () => {
        // Enabling a cache server is not consent to move the session store into
        // it — those keys change how the app behaves, so they stay the app's.
        const vars = serviceEnvVars([pg, redis]);
        expect(vars).not.toHaveProperty('CACHE_STORE');
        expect(vars).not.toHaveProperty('SESSION_DRIVER');
        expect(vars).not.toHaveProperty('QUEUE_CONNECTION');
        // REDIS_CLIENT selects phpredis vs predis — a property of what the app
        // has installed, not of the server we run.
        expect(vars).not.toHaveProperty('REDIS_CLIENT');
    });

    it('is empty when nothing is running', () => {
        expect(serviceEnvVars([])).toEqual({});
    });
});

describe('quoteEnvValue', () => {
    it('leaves ordinary values unquoted', () => {
        expect(quoteEnvValue('pgsql')).toBe('pgsql');
        expect(quoteEnvValue('127.0.0.1')).toBe('127.0.0.1');
        // Generated passwords are base64url — the common case must stay clean.
        expect(quoteEnvValue('aB3-_xyz')).toBe('aB3-_xyz');
    });

    it('quotes anything that would otherwise change meaning', () => {
        // Unquoted, everything after `#` is a comment — the value would silently
        // truncate.
        expect(quoteEnvValue('pa#ss')).toBe('"pa#ss"');
        expect(quoteEnvValue('has space')).toBe('"has space"');
        expect(quoteEnvValue('quote"and\\slash')).toBe('"quote\\"and\\\\slash"');
    });
});

describe('applyManagedEnv', () => {
    const vars = { DB_HOST: '127.0.0.1', DB_PORT: '21432' };

    it('appends a block to a file that has none, keeping the original bytes', () => {
        const existing = 'APP_NAME=Laravel\nAPP_KEY=base64:abc\n';
        const { contents, changed } = applyManagedEnv(existing, vars);
        expect(changed).toBe(true);
        expect(contents).toContain('APP_NAME=Laravel');
        expect(contents).toContain('APP_KEY=base64:abc');
        expect(contents).toContain(MANAGED_BEGIN);
        expect(contents).toContain('DB_PORT=21432');
        expect(contents).toContain(MANAGED_END);
        // The user's lines are untouched and still come first.
        expect(contents.indexOf('APP_NAME')).toBeLessThan(contents.indexOf(MANAGED_BEGIN));
    });

    it('replaces an existing block IN PLACE, leaving the rest alone', () => {
        const first = applyManagedEnv('APP_NAME=Laravel\nMAIL_HOST=smtp\n', vars).contents;
        const second = applyManagedEnv(first, { ...vars, DB_PORT: '21999' });
        expect(second.contents).toContain('DB_PORT=21999');
        expect(second.contents).not.toContain('DB_PORT=21432');
        expect(second.contents).toContain('MAIL_HOST=smtp');
        // Exactly one block — a replace, not an append.
        expect(second.contents.split(MANAGED_BEGIN).length - 1).toBe(1);
    });

    it('is idempotent — rewriting the same config changes nothing', () => {
        const once = applyManagedEnv('APP_NAME=Laravel\n', vars).contents;
        const twice = applyManagedEnv(once, vars);
        expect(twice.changed).toBe(false);
        expect(twice.contents).toBe(once);
    });

    it('removes the block entirely when the services are turned off', () => {
        const withBlock = applyManagedEnv('APP_NAME=Laravel\nMAIL_HOST=smtp\n', vars).contents;
        const cleared = applyManagedEnv(withBlock, {});
        expect(cleared.contents).not.toContain(MANAGED_BEGIN);
        expect(cleared.contents).not.toContain('DB_PORT');
        expect(cleared.contents).toContain('APP_NAME=Laravel');
        expect(cleared.contents).toContain('MAIL_HOST=smtp');
    });

    it('does not grow the file across enable/disable cycles', () => {
        const original = 'APP_NAME=Laravel\n';
        let contents = original;
        for (let i = 0; i < 5; i += 1) {
            contents = applyManagedEnv(contents, vars).contents;
            contents = applyManagedEnv(contents, {}).contents;
        }
        expect(contents.trimEnd()).toBe(original.trimEnd());
    });

    it('NEVER touches a user value, even one of the keys it manages', () => {
        // The whole point. The user's DB_PASSWORD may point at a real database.
        const existing = 'DB_PASSWORD=production-secret\nDB_HOST=db.example.com\n';
        const { contents, conflicts } = applyManagedEnv(existing, {
            DB_HOST: '127.0.0.1',
            DB_PASSWORD: 'generated',
        });
        expect(contents).toContain('DB_PASSWORD=production-secret');
        expect(contents).toContain('DB_HOST=db.example.com');
        // …and says so rather than quietly fighting for the key.
        expect(conflicts.sort()).toEqual(['DB_HOST', 'DB_PASSWORD']);
    });

    it('reports a conflict through `export` and leading whitespace too', () => {
        const { conflicts } = applyManagedEnv('  export DB_HOST=elsewhere\n', vars);
        expect(conflicts).toEqual(['DB_HOST']);
    });

    it('does not mistake a COMMENTED example for a conflict', () => {
        // `.env` files are full of commented-out defaults; treating those as
        // live assignments would warn about a conflict on nearly every project.
        const { conflicts } = applyManagedEnv('# DB_HOST=127.0.0.1\n#DB_PORT=5432\n', vars);
        expect(conflicts).toEqual([]);
    });

    it('does not confuse a key that merely starts the same', () => {
        const { conflicts } = applyManagedEnv('DB_HOSTNAME=x\nDB_PORTAL=y\n', vars);
        expect(conflicts).toEqual([]);
    });

    it('leaves a half-written block alone instead of eating the rest of the file', () => {
        // Someone deleted the end marker by hand. Treating the begin marker as
        // the start of a block with no end would swallow everything after it.
        const existing = `APP_NAME=Laravel\n${MANAGED_BEGIN}\nDB_HOST=stale\nMAIL_HOST=smtp\n`;
        const { contents } = applyManagedEnv(existing, vars);
        expect(contents).toContain('APP_NAME=Laravel');
        expect(contents).toContain('MAIL_HOST=smtp');
    });

    it('preserves CRLF files as CRLF', () => {
        // Windows is a first-class target here; rewriting a CRLF .env with LF
        // would show up as a whole-file diff in the user's editor.
        const existing = 'APP_NAME=Laravel\r\nAPP_KEY=abc\r\n';
        const { contents } = applyManagedEnv(existing, vars);
        expect(contents).toContain('\r\n');
        expect(contents.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
    });

    it('handles an empty file', () => {
        const { contents, changed } = applyManagedEnv('', vars);
        expect(changed).toBe(true);
        expect(contents).toContain(MANAGED_BEGIN);
        expect(contents).toContain('DB_HOST=127.0.0.1');
    });

    it('reports no change when there is nothing to write and no block', () => {
        const result = applyManagedEnv('APP_NAME=Laravel\n', {});
        expect(result.changed).toBe(false);
        expect(result.contents).toBe('APP_NAME=Laravel\n');
    });
});

describe('renderManagedEnv', () => {
    it('wraps the assignments in both markers', () => {
        const block = renderManagedEnv({ DB_HOST: '127.0.0.1' });
        expect(block.startsWith(MANAGED_BEGIN)).toBe(true);
        expect(block.trimEnd().endsWith(MANAGED_END)).toBe(true);
        expect(block).toContain('DB_HOST=127.0.0.1');
    });
});
