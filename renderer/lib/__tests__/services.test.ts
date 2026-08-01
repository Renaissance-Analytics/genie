import { describe, expect, it } from 'vitest';
import {
    enabledServiceCount,
    envConflictNote,
    envWriteNote,
    ENV_SECRET_PLACEHOLDER,
    serviceEngineNote,
    serviceEnvPreview,
    serviceManagerRows,
    serviceStatusLabel,
    serviceStatusTone,
    servicesUnavailableNote,
    type ServiceManagerRow,
} from '../services';
import type { ServiceRow } from '../genie';

/**
 * The Site Manager's SERVICES tab view model (Tynn #232, P3 wiring).
 *
 * Same arrangement as `hosting.test.ts` and for the same reason: the renderer
 * test env is Node-only, so the surface itself is verified by hand / e2e and
 * every decision it makes lives in `lib/services.ts` as a pure function — which
 * services the tab lists (both kinds, always, configured or not), what each one's
 * status reads as, and what it claims about the `.env` it writes.
 */

const row = (over: Partial<ServiceRow> = {}): ServiceRow => ({
    workspaceId: 'ws1',
    serviceId: 'svc-pg',
    kind: 'postgres',
    enabled: true,
    state: 'stopped',
    port: 21042,
    endpoint: null,
    database: 'genie',
    user: 'genie',
    ...over,
});

describe('serviceManagerRows', () => {
    it('always offers EVERY kind, so an unconfigured service is one click away', () => {
        const rows = serviceManagerRows([]);
        expect(rows.map((r) => r.kind)).toEqual(['postgres', 'redis']);
        expect(rows.every((r) => !r.configured)).toBe(true);
        expect(rows.every((r) => !r.enabled)).toBe(true);
    });

    it('merges a configured service onto its kind rather than adding a row', () => {
        const rows = serviceManagerRows([row()]);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            kind: 'postgres',
            configured: true,
            enabled: true,
            serviceId: 'svc-pg',
            port: 21042,
            database: 'genie',
            user: 'genie',
        });
        expect(rows[1]).toMatchObject({ kind: 'redis', configured: false });
    });

    it('names the ENGINE separately from the kind — redis is served by Garnet', () => {
        const [postgres, redis] = serviceManagerRows([]);
        expect(postgres!.engine).toBe('postgres');
        expect(redis!.engine).toBe('garnet');
    });

    it('has no port until the service is configured (main derives it)', () => {
        const [postgres] = serviceManagerRows([]);
        expect(postgres!.port).toBeNull();
    });

    it('keys a row stably — by serviceId once configured, by kind before that', () => {
        expect(serviceManagerRows([])[0]!.key).toBe('kind:postgres');
        expect(serviceManagerRows([row()])[0]!.key).toBe('svc-pg');
    });
});

const managerRow = (over: Partial<ServiceManagerRow> = {}): ServiceManagerRow => ({
    ...serviceManagerRows([row()])[0]!,
    ...over,
});

describe('serviceStatusLabel', () => {
    it('reads as the ENDPOINT when running — the thing the user came for', () => {
        expect(
            serviceStatusLabel(
                managerRow({ state: 'running', endpoint: { host: '127.0.0.1', port: 21042 } }),
            ),
        ).toBe('127.0.0.1:21042');
    });

    it('falls back to the derived port when a running service reports no endpoint', () => {
        expect(serviceStatusLabel(managerRow({ state: 'running', endpoint: null }))).toBe(
            '127.0.0.1:21042',
        );
    });

    it('reads as the REASON when it failed, never as merely off', () => {
        expect(
            serviceStatusLabel(managerRow({ state: 'failed', error: 'initdb exited 1' })),
        ).toBe('initdb exited 1');
    });

    it('distinguishes never-set-up from turned-off', () => {
        expect(serviceStatusLabel(managerRow({ configured: false, enabled: false }))).toBe(
            'Not set up yet',
        );
        expect(serviceStatusLabel(managerRow({ configured: true, enabled: false }))).toBe(
            'Disabled',
        );
    });

    it('reads as starting while an enabled service has not come up', () => {
        expect(serviceStatusLabel(managerRow({ state: 'stopped' }))).toBe('Starting…');
    });
});

describe('serviceStatusTone', () => {
    it('tones match the sites tab', () => {
        expect(serviceStatusTone(managerRow({ state: 'running' }))).toBe('running');
        expect(serviceStatusTone(managerRow({ state: 'failed' }))).toBe('failed');
        expect(serviceStatusTone(managerRow({ state: 'stopped' }))).toBe('starting');
        expect(serviceStatusTone(managerRow({ enabled: false }))).toBe('idle');
        expect(serviceStatusTone(managerRow({ configured: false, enabled: false }))).toBe('idle');
    });
});

describe('serviceEnvPreview', () => {
    /* The KEYS are main/hosting/services/env.ts#serviceEnvVars — this is the
       user-facing mirror of the block Genie writes into their `.env`. */
    it('shows the postgres connection exactly as the managed block spells it', () => {
        const preview = serviceEnvPreview(
            managerRow({ state: 'running', endpoint: { host: '127.0.0.1', port: 21042 } }),
        );
        expect(preview.map((p) => p.key)).toEqual([
            'DB_CONNECTION',
            'DB_HOST',
            'DB_PORT',
            'DB_DATABASE',
            'DB_USERNAME',
            'DB_PASSWORD',
        ]);
        expect(preview.find((p) => p.key === 'DB_CONNECTION')!.value).toBe('pgsql');
        expect(preview.find((p) => p.key === 'DB_PORT')!.value).toBe('21042');
        expect(preview.find((p) => p.key === 'DB_DATABASE')!.value).toBe('genie');
    });

    it('NEVER renders the password — main does not send it and the UX must not invent one', () => {
        const password = serviceEnvPreview(managerRow())!.find((p) => p.key === 'DB_PASSWORD')!;
        expect(password.value).toBe(ENV_SECRET_PLACEHOLDER);
        expect(password.secret).toBe(true);
    });

    it('shows the redis connection, which has no credential at all', () => {
        const redis = serviceManagerRows([
            row({ kind: 'redis', serviceId: 'svc-redis', port: 21777, database: undefined, user: undefined }),
        ])[1]!;
        expect(serviceEnvPreview(redis).map((p) => p.key)).toEqual(['REDIS_HOST', 'REDIS_PORT']);
        expect(serviceEnvPreview(redis).some((p) => p.secret)).toBe(false);
    });

    it('previews nothing for a service that is not enabled — the block would not hold it', () => {
        expect(serviceEnvPreview(managerRow({ enabled: false }))).toEqual([]);
        expect(serviceEnvPreview(managerRow({ configured: false, enabled: false }))).toEqual([]);
    });
});

describe('serviceEngineNote', () => {
    it('says out loud that the redis slot is Garnet', () => {
        const redis = serviceManagerRows([])[1]!;
        expect(serviceEngineNote(redis)).toMatch(/Garnet/);
    });

    it('says nothing for a service that IS its engine', () => {
        expect(serviceEngineNote(serviceManagerRows([])[0]!)).toBeNull();
    });
});

describe('envConflictNote', () => {
    it('is silent when the user sets none of the managed keys themselves', () => {
        expect(envConflictNote([])).toBeNull();
    });

    it('names every superseded key — a silently overridden credential is the point', () => {
        const note = envConflictNote(['DB_PASSWORD', 'DB_HOST'])!;
        expect(note).toContain('DB_PASSWORD');
        expect(note).toContain('DB_HOST');
    });
});

describe('envWriteNote', () => {
    it('says nothing about a write that changed nothing and superseded nothing', () => {
        expect(envWriteNote({ path: 'C:/ws/.env', changed: false, conflicts: [] })).toBeNull();
        expect(envWriteNote(null)).toBeNull();
    });

    it('says the workspace has no .env, because Genie deliberately never creates one', () => {
        const note = envWriteNote({ path: null, changed: false, conflicts: [] })!;
        expect(note).toMatch(/no \.env/i);
    });

    it('reports the superseded keys even when the file was already up to date', () => {
        const note = envWriteNote({
            path: 'C:/ws/.env',
            changed: false,
            conflicts: ['DB_PASSWORD'],
        })!;
        expect(note).toContain('DB_PASSWORD');
    });
});

describe('servicesUnavailableNote', () => {
    it('is silent when services can run here', () => {
        expect(servicesUnavailableNote('ready')).toBeNull();
    });

    it('explains a REMOTE window rather than driving the wrong machine', () => {
        expect(servicesUnavailableNote('remote')).toMatch(/machine/i);
    });

    it('explains a host with no service manager at all', () => {
        expect(servicesUnavailableNote('unsupported')).toMatch(/not available/i);
    });
});

describe('enabledServiceCount', () => {
    it('counts the ones actually turned on, for the tab label', () => {
        expect(enabledServiceCount(serviceManagerRows([]))).toBe(0);
        expect(enabledServiceCount(serviceManagerRows([row()]))).toBe(1);
        expect(enabledServiceCount(serviceManagerRows([row({ enabled: false })]))).toBe(0);
    });
});
