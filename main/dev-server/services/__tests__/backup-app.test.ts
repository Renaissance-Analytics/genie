import { describe, expect, it } from 'vitest';
import { backupApp, dumpTargetsFor } from '../backup-app';
import type { BackupSettings } from '../backup';
import type { BackupResult } from '../backup-runner';
import type { DevServices } from '../services-config';

/**
 * ONE APP'S BACKUP (Tynn #250, step 4) — settings in, dumps out.
 *
 * The two things worth pinning here are the two ways a backup lies: running
 * against an engine that is not up (a dump that fails for a reason nobody can
 * read), and reporting success for an app whose data is partly in an engine
 * nothing knows how to dump.
 */

const PG = {
    engine: 'postgres' as const,
    version: '17',
    dedicated: false,
    password: 'workspace_pw_0123456789',
    enabled: true,
};

const SETTINGS: BackupSettings = { enabled: true, dir: '/Volumes/Shared/genie', keep: 7 };
const AT = new Date('2026-08-22T01:02:03.000Z');
const APP = { slug: 'notes', workspaceId: 'ws-notes' };

const input = (services: DevServices, running: string[], over: Record<string, unknown> = {}) => ({
    app: APP,
    machine: 'workstation',
    at: AT,
    settings: SETTINGS,
    override: null,
    services,
    running: new Set(running),
    ...over,
});

describe('dumpTargetsFor', () => {
    it('addresses the engine by its derived container name and the workspace’s own slice', () => {
        const [target] = dumpTargetsFor(input({ 'svc-1': { ...PG } }, ['svc-1']));
        expect(target).toMatchObject({
            engine: 'postgres',
            version: '17',
            host: 'genie-svc-postgres-17',
            port: 5432,
            image: 'pgvector/pgvector:pg17',
        });
        expect(target?.slice.identifier).toMatch(/^ws_/);
        expect(target?.slice.password).toBe(PG.password);
    });

    it('addresses a DEDICATED engine’s own container, not the shared one', () => {
        const [target] = dumpTargetsFor(
            input({ 'svc-1': { ...PG, dedicated: true } }, ['svc-1']),
        );
        expect(target?.host).toBe('genie-svc-postgres-17-ws-notes');
    });

    it('leaves out an engine that is not RUNNING', () => {
        // Dumping against a stopped engine produces a connection error, which is a
        // failed backup dressed up as a mysterious one.
        expect(dumpTargetsFor(input({ 'svc-1': { ...PG } }, []))).toEqual([]);
    });

    it('leaves out a service that is not enabled', () => {
        expect(
            dumpTargetsFor(input({ 'svc-1': { ...PG, enabled: false } }, ['svc-1'])),
        ).toEqual([]);
    });
});

describe('backupApp', () => {
    const ok = async (): Promise<BackupResult> => ({
        engine: 'postgres',
        version: '17',
        ok: true,
        path: '/Volumes/Shared/genie/workstation/notes/postgres-17/20260822T010203Z.dump',
        pruned: [],
    });

    it('runs a dump per live engine and reports where they landed', async () => {
        const run = [] as Array<{ root: string; keep: number }>;
        const result = await backupApp(input({ 'svc-1': { ...PG } }, ['svc-1']), async (_j, root, keep) => {
            run.push({ root, keep });
            return ok();
        });

        expect(result.ok).toBe(true);
        expect(result.results).toHaveLength(1);
        expect(run[0]).toEqual({ root: '/Volumes/Shared/genie', keep: 7 });
    });

    it('honours the per-GApp folder override', async () => {
        const run = [] as string[];
        await backupApp(
            input({ 'svc-1': { ...PG } }, ['svc-1'], { override: { dir: '/Volumes/Vault/notes' } }),
            async (_j, root) => {
                run.push(root);
                return ok();
            },
        );
        expect(run[0]).toBe('/Volumes/Vault/notes');
    });

    it('does nothing, and says why, when backups are switched off', async () => {
        let ran = false;
        const result = await backupApp(
            input({ 'svc-1': { ...PG } }, ['svc-1'], { override: { enabled: false } }),
            async () => {
                ran = true;
                return ok();
            },
        );
        expect(ran).toBe(false);
        expect(result.ok).toBe(true);
        expect(result.skipped).toMatch(/turned off/i);
    });

    it('NAMES the live engines it cannot dump instead of quietly omitting them', async () => {
        // A backup set that silently leaves out Redis is one somebody finds out
        // about during a restore.
        const result = await backupApp(
            input(
                {
                    'svc-1': { ...PG },
                    'svc-2': { ...PG, engine: 'redis' as const, version: '7' },
                },
                ['svc-1', 'svc-2'],
            ),
            ok,
        );
        expect(result.notCovered).toEqual(['redis 7']);
    });

    it('is NOT ok when any single dump failed', async () => {
        const result = await backupApp(input({ 'svc-1': { ...PG } }, ['svc-1']), async () => ({
            engine: 'postgres',
            version: '17',
            ok: false,
            error: 'connection refused',
            pruned: [],
        }));
        expect(result.ok).toBe(false);
        expect(result.results[0]?.error).toContain('connection refused');
    });

    it('says so when the app has no dumpable data at all', async () => {
        const result = await backupApp(input({}, []), ok);
        expect(result.ok).toBe(true);
        expect(result.skipped).toMatch(/nothing to back up/i);
    });
});
