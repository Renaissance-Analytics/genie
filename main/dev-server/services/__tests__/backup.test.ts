import { describe, expect, it } from 'vitest';
import { backupJobsFor, prunableDumps, resolveBackupSettings } from '../backup';
import type { BackupSettings, DumpTarget } from '../backup';

/**
 * BACKING UP A GAPP'S DATA (Tynn #250, step 4, second half).
 *
 * The owner's ask: a configurable backup, settable at the WORKSTATION level with
 * a PER-GAPP override — where the db dumps land — and pointable at a shared
 * folder. Everything that decides *what runs* and *where it lands* is pure and
 * lives here, for the same reason `provision.ts` is pure: these are the
 * decisions that determine whether a restore is possible, and they should be
 * readable without a database or a container to run them against.
 */

const WORKSTATION: BackupSettings = {
    enabled: true,
    dir: '/Volumes/Shared/genie-backups',
    keep: 7,
};

const PG: DumpTarget = {
    engine: 'postgres',
    version: '17',
    image: 'pgvector/pgvector:pg17',
    host: 'genie-svc-postgres-17',
    port: 5432,
    slice: { identifier: 'ws_notes_1a2b3c4d', password: 'pw-Abc_123' },
};

const MYSQL: DumpTarget = {
    engine: 'mysql',
    version: '8.4',
    image: 'mysql:8.4',
    host: 'genie-svc-mysql-8-4',
    port: 3306,
    slice: { identifier: 'ws_notes_1a2b3c4d', password: 'pw-Abc_123' },
};

const AT = new Date('2026-08-22T01:02:03.000Z');

describe('resolveBackupSettings', () => {
    it('uses the workstation default when a GApp says nothing', () => {
        const r = resolveBackupSettings(WORKSTATION, null);
        expect(r).toMatchObject({ enabled: true, dir: '/Volumes/Shared/genie-backups', keep: 7 });
        expect(r.from.dir).toBe('workstation');
    });

    it('lets a GApp redirect the folder WITHOUT restating retention', () => {
        const r = resolveBackupSettings(WORKSTATION, { dir: '/Volumes/Vault/notes' });
        expect(r.dir).toBe('/Volumes/Vault/notes');
        expect(r.from.dir).toBe('app');
        // The point of per-FIELD resolution: retention still comes from the
        // workstation, so an app that only wanted a different folder gets one.
        expect(r.keep).toBe(7);
        expect(r.from.keep).toBe('workstation');
    });

    it('lets a GApp opt IN when the workstation default is off', () => {
        const r = resolveBackupSettings({ ...WORKSTATION, enabled: false }, { enabled: true });
        expect(r.enabled).toBe(true);
        expect(r.from.enabled).toBe('app');
    });

    it('lets a GApp opt OUT when the workstation default is on', () => {
        expect(resolveBackupSettings(WORKSTATION, { enabled: false }).enabled).toBe(false);
    });

    it('never resolves keep below 1 — a retention of 0 deletes what it just wrote', () => {
        expect(resolveBackupSettings({ ...WORKSTATION, keep: 0 }, null).keep).toBe(1);
        expect(resolveBackupSettings(WORKSTATION, { keep: -3 }).keep).toBe(1);
    });

    it('ignores a RELATIVE directory rather than resolving it against a stray cwd', () => {
        // A relative backup path lands wherever the process happened to be, which
        // for a desktop app is not a place anyone will look again.
        const r = resolveBackupSettings(WORKSTATION, { dir: 'backups' });
        expect(r.dir).toBe(WORKSTATION.dir);
        expect(r.from.dir).toBe('workstation');
    });

    it('is DISABLED when no directory is configured anywhere', () => {
        // Never invent a location: a dump written somewhere the owner did not ask
        // for is a dump nobody finds when they need it.
        const r = resolveBackupSettings({ enabled: true, dir: '  ', keep: 7 }, null);
        expect(r.enabled).toBe(false);
        expect(r.reason).toMatch(/no backup folder/i);
    });
});

describe('backupJobsFor', () => {
    const jobs = backupJobsFor({
        appSlug: 'notes',
        machine: 'Glenn’s MacBook Pro',
        at: AT,
        targets: [PG, MYSQL],
    });

    it('separates by MACHINE first, so a shared folder can hold several', () => {
        // Two workstations pointed at the same share must not interleave — and,
        // more importantly, must never prune each other's dumps.
        expect(jobs[0]?.dir.split('/')[0]).toBe('glenn-s-macbook-pro');
    });

    it('files a dump under the app and the exact engine version', () => {
        expect(jobs[0]?.dir).toBe('glenn-s-macbook-pro/notes/postgres-17');
        expect(jobs[1]?.dir).toBe('glenn-s-macbook-pro/notes/mysql-8.4');
    });

    it('names the dump by an ordered, sortable timestamp', () => {
        expect(jobs[0]?.fileName).toBe('20260822T010203Z.dump');
        expect(jobs[1]?.fileName).toBe('20260822T010203Z.sql');
    });

    it('runs the ENGINE’s own image, so the dump tool matches the server', () => {
        // pg_dump refuses a server newer than itself, so the version that made
        // the data is the only safe version to dump it with.
        expect(jobs[0]?.image).toBe('pgvector/pgvector:pg17');
        expect(jobs[1]?.image).toBe('mysql:8.4');
    });

    it('writes a .part and RENAMES it, so a half-written dump is never mistaken for a good one', () => {
        for (const job of jobs) {
            const argv = job.command.join(' ');
            expect(argv).toContain(`${job.fileName}.part`);
            expect(argv).toContain(`mv `);
            expect(argv).toContain(`${job.mountTarget}/${job.fileName}`);
        }
    });

    it('connects as the WORKSPACE, never as the engine superuser', () => {
        // The workspace role owns its own database, so it can dump it; handing a
        // backup job the engine admin would put root on another command line for
        // no gain (Tynn #250, step 4).
        expect(jobs[0]?.command.join(' ')).toContain('ws_notes_1a2b3c4d:pw-Abc_123');
        expect(jobs[1]?.command.join(' ')).toContain('--user=ws_notes_1a2b3c4d');
    });

    it('dials the engine by CONTAINER NAME, never a published loopback port', () => {
        // The dump runs in a container on the shared services network; 127.0.0.1
        // there is the dump container itself.
        expect(jobs[0]?.command.join(' ')).toContain('genie-svc-postgres-17:5432');
        expect(jobs[0]?.command.join(' ')).not.toContain('127.0.0.1');
    });

    it('skips an engine it has no dump for, rather than pretending', () => {
        const redis: DumpTarget = {
            engine: 'redis',
            version: '7',
            image: 'redis:7-alpine',
            host: 'genie-svc-redis-7',
            port: 6379,
            slice: { identifier: 'ws_notes_1a2b3c4d', password: 'pw-Abc_123' },
        };
        expect(backupJobsFor({ appSlug: 'notes', machine: 'm', at: AT, targets: [redis] })).toEqual(
            [],
        );
    });

    it('refuses a credential that is not a derived one', () => {
        expect(() =>
            backupJobsFor({
                appSlug: 'notes',
                machine: 'm',
                at: AT,
                targets: [{ ...PG, slice: { identifier: 'ws_x', password: "p'; rm -rf /" } }],
            }),
        ).toThrow(/not a generated one/);
    });
});

describe('prunableDumps', () => {
    const names = [
        '20260820T010203Z.dump',
        '20260821T010203Z.dump',
        '20260822T010203Z.dump',
    ];

    it('keeps the newest N and returns the rest, oldest first', () => {
        expect(prunableDumps(names, 2)).toEqual(['20260820T010203Z.dump']);
        expect(prunableDumps(names, 1)).toEqual([
            '20260820T010203Z.dump',
            '20260821T010203Z.dump',
        ]);
    });

    it('returns nothing when there is room', () => {
        expect(prunableDumps(names, 7)).toEqual([]);
    });

    it('NEVER touches a file it did not write', () => {
        // The whole point of pointing this at a shared folder is that other
        // things live there. Deleting by "oldest in the directory" would eat them.
        const mixed = [...names, 'notes.txt', 'important-manual-backup.dump', '.DS_Store'];
        expect(prunableDumps(mixed, 1)).toEqual([
            '20260820T010203Z.dump',
            '20260821T010203Z.dump',
        ]);
    });

    it('leaves a half-written .part alone — the runner owns those', () => {
        expect(prunableDumps([...names, '20260823T010203Z.dump.part'], 3)).toEqual([]);
    });
});
