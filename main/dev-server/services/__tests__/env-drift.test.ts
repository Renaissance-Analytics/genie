import { describe, expect, it } from 'vitest';
import { serviceEnvDrift, driftNotice } from '../env-drift';

/**
 * A terminal's baked-in service env going stale (genie#222, reported twice).
 *
 * Genie injects the workspace's service env into a pty at CREATION. A shell's
 * environment cannot be changed afterwards, so when an engine's published port
 * moves — an ephemeral publication, a recreated container — every terminal opened
 * before the change carries a port that no longer exists.
 *
 * That is worse than a stale readout because Laravel's dotenv is IMMUTABLE: an
 * already-set variable beats the app's own `.env`, so the terminal silently
 * overrides correct configuration. `php artisan migrate` fails with "connection
 * refused" against a perfectly healthy database, and the reporter's fingerprint is
 * that `artisan serve` works in the SAME shell — its passthrough allowlist strips
 * `DB_*`, so the dev server falls back to `.env`.
 *
 * The only remedy is a new terminal, and nothing tells you so. This is the telling.
 */

describe('spotting the drift', () => {
    it('reports a port that moved, with both values', () => {
        const drift = serviceEnvDrift({ DB_PORT: '51157' }, { DB_PORT: '58377' });

        expect(drift).toEqual([{ key: 'DB_PORT', was: '51157', now: '58377' }]);
    });

    it('says nothing when everything still matches', () => {
        expect(serviceEnvDrift({ DB_PORT: '58377' }, { DB_PORT: '58377' })).toEqual([]);
    });

    it('reports a variable the workspace no longer has', () => {
        // The engine was removed. The terminal still points at where it was.
        const drift = serviceEnvDrift({ REDIS_PORT: '51153' }, {});
        expect(drift).toEqual([{ key: 'REDIS_PORT', was: '51153' }]);
    });

    it('ignores a variable the terminal never had', () => {
        // A service added after this terminal opened is not DRIFT — the terminal
        // simply predates it, and saying "changed" would be wrong.
        expect(serviceEnvDrift({}, { DB_PORT: '58377' })).toEqual([]);
    });

    it('is stable in order, so the notice does not reshuffle between calls', () => {
        const drift = serviceEnvDrift(
            { DB_PORT: '1', REDIS_PORT: '2', DB_HOST: '3' },
            { DB_PORT: 'x', REDIS_PORT: 'y', DB_HOST: 'z' },
        );
        expect(drift.map((d) => d.key)).toEqual(['DB_HOST', 'DB_PORT', 'REDIS_PORT']);
    });
});

describe('never printing a secret to say one changed', () => {
    it('redacts a password while still reporting that it moved', () => {
        const drift = serviceEnvDrift({ DB_PASSWORD: 'old-secret' }, { DB_PASSWORD: 'new-secret' });

        expect(drift).toEqual([{ key: 'DB_PASSWORD', was: '<redacted>', now: '<redacted>' }]);
    });

    it('redacts a connection URL, which carries the password inside it', () => {
        // The trap: DATABASE_URL looks like an address and IS a credential.
        const drift = serviceEnvDrift(
            { DATABASE_URL: 'postgresql://u:pw@127.0.0.1:51157/db' },
            { DATABASE_URL: 'postgresql://u:pw@127.0.0.1:58377/db' },
        );

        expect(drift[0]?.key).toBe('DATABASE_URL');
        expect(JSON.stringify(drift)).not.toContain('pw');
    });

    it('still shows a port, which is the whole point of the notice', () => {
        expect(serviceEnvDrift({ PGPORT: '51157' }, { PGPORT: '58377' })[0]?.now).toBe('58377');
    });
});

describe('what the notice says', () => {
    it('is null when there is no drift, so nothing is added to a clean answer', () => {
        expect(driftNotice([])).toBeNull();
    });

    it('names the variables and tells the user the ONLY remedy', () => {
        // A shell's environment cannot be changed after it starts. Saying "restart
        // the service" would send someone in a circle.
        const notice = driftNotice([{ key: 'DB_PORT', was: '51157', now: '58377' }]);

        expect(notice).toContain('DB_PORT');
        expect(notice).toContain('51157');
        expect(notice).toContain('58377');
        expect(notice).toMatch(/new terminal/i);
    });

    it('warns that the stale value can BEAT a correct .env', () => {
        // Without this the reader assumes their .env wins and looks elsewhere —
        // which is exactly the time both reporters lost.
        expect(driftNotice([{ key: 'DB_PORT', was: '1', now: '2' }])).toMatch(/\.env/);
    });
});
