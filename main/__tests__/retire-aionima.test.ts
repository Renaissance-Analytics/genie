import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureSystemWorkspaceRow, runMigrations } from '../db';
import { pickTynnLink } from '../workspace/tynn-link';

/**
 * AIONIMA SUPPORT IS RETIRED (genie#679).
 *
 * Owner, 2026-09-15: Aionima now runs as an agent TUI inside Genie like any other
 * agent, so Genie's own Aionima integration — a second work-management backend
 * with a host, a token, an inbox and a Settings section — goes entirely.
 *
 * One piece of it was never Aionima at all. `backend: 'aionima'` doubled as the
 * marker for workspaces backed by NO service: the System workspace and every
 * installed or dev GApp. A GApp keeps its MANIFEST id in `tynn_project_id`, and the
 * marker is the only thing stopping Tynn features reading that id as a Tynn
 * project. So those rows are relabelled `none` — not `tynn` — with everything else
 * left exactly as it was.
 */

const V_BEFORE = 76;

function upgradedFrom(before: (db: Database.Database) => void): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db, { upTo: V_BEFORE });
    before(db);
    runMigrations(db);
    return db;
}

function plantWorkspace(
    db: Database.Database,
    row: { id: string; backend: string; tynn_project_id: string; project_name: string },
): void {
    db.prepare(
        `INSERT INTO workspaces (id, backend, project_id, project_name, tynn_project_id, tynn_project_name,
                                 shape, path, created_by_genie)
         VALUES (@id, @backend, '', @project_name, @tynn_project_id, @project_name, 'agi', @path, 1)`,
    ).run({ ...row, path: `/work/${row.id}` });
}

const workspace = (db: Database.Database, id: string) =>
    db.prepare('SELECT backend, tynn_project_id, project_name FROM workspaces WHERE id = ?').get(id) as {
        backend: string;
        tynn_project_id: string;
        project_name: string;
    };

describe('the migration that retires Aionima', () => {
    it('relabels the no-backend workspaces `none`, keeping a GApp\'s manifest id where it was', () => {
        const db = upgradedFrom((d) => {
            plantWorkspace(d, { id: 'app-notes-1', backend: 'aionima', tynn_project_id: 'com.acme.notes', project_name: 'Notes' });
            plantWorkspace(d, { id: 'sys', backend: 'aionima', tynn_project_id: '', project_name: 'System' });
        });

        expect(workspace(db, 'app-notes-1')).toEqual({ backend: 'none', tynn_project_id: 'com.acme.notes', project_name: 'Notes' });
        expect(workspace(db, 'sys')).toEqual({ backend: 'none', tynn_project_id: '', project_name: 'System' });
    });

    it('POSITIVE CONTROL: leaves every Tynn workspace exactly as it was, linked or not', () => {
        const db = upgradedFrom((d) => {
            plantWorkspace(d, { id: 'tynn-linked', backend: 'tynn', tynn_project_id: '01JABCDEF', project_name: 'Tynn' });
            plantWorkspace(d, { id: 'tynn-unlinked', backend: 'tynn', tynn_project_id: '', project_name: 'Prism' });
        });
        expect(workspace(db, 'tynn-linked')).toEqual({ backend: 'tynn', tynn_project_id: '01JABCDEF', project_name: 'Tynn' });
        expect(workspace(db, 'tynn-unlinked')).toEqual({ backend: 'tynn', tynn_project_id: '', project_name: 'Prism' });
    });

    it('removes the stored Aionima host and token — the table only ever held Aionima\'s', () => {
        // `backend_connections` had one reader and one writer, both Aionima's; Tynn
        // keeps its session elsewhere. Dropping the table is what guarantees the
        // bearer token does not outlive the feature on anybody's disk.
        const db = upgradedFrom((d) => {
            d.prepare(
                `INSERT INTO backend_connections (backend, host, token, updated_at) VALUES ('aionima', 'https://192.168.0.144:3100', 'secret', 'x')`,
            ).run();
        });
        const table = db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backend_connections'`)
            .get();
        expect(table).toBeUndefined();
    });

    it('POSITIVE CONTROL: the table exists, holding the token, before the migration runs', () => {
        const db = new Database(':memory:');
        runMigrations(db, { upTo: V_BEFORE });
        db.prepare(
            `INSERT INTO backend_connections (backend, host, token, updated_at) VALUES ('aionima', 'h', 'secret', 'x')`,
        ).run();
        expect(db.prepare('SELECT token FROM backend_connections').get()).toEqual({ token: 'secret' });
    });
});

describe('the no-backend marker after retirement', () => {
    it('creates the System workspace as `none`', () => {
        const db = new Database(':memory:');
        runMigrations(db);
        const row = ensureSystemWorkspaceRow(db, '/genie/system');
        expect(row.backend).toBe('none');
    });

    it('never resolves a `none` workspace as a Tynn link, even with an id in tynn_project_id', () => {
        expect(
            pickTynnLink({
                projectJsonTynn: undefined,
                hasTynnKey: false,
                row: { backend: 'none', tynnProjectId: 'com.acme.notes', tynnProjectName: 'Notes' },
            }),
        ).toBeNull();
    });
});

describe('no Aionima left in Genie', () => {
    /**
     * A guard, so it cannot creep back in piece by piece. Allowed, and only:
     * the database migration history (old rows and an old CHECK constraint have
     * to be named to be migrated away), and the reserved-app-name list, which is
     * anti-impersonation for a real product rather than support for it.
     */
    const ALLOWED = new Set(['main/db.ts', 'main/apps/manifest.ts']);
    const ROOTS = ['main', 'renderer/components', 'renderer/lib', 'renderer/pages', 'renderer/styles', 'e2e', 'scripts'];

    function sources(dir: string, out: string[] = []): string[] {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
                sources(full, out);
            } else if (/\.(ts|tsx|js|mjs|cjs|css)$/.test(entry.name)) {
                out.push(full);
            }
        }
        return out;
    }

    it('names Aionima nowhere outside the migration history and the reserved names', () => {
        const repo = path.resolve(__dirname, '..', '..');
        const offenders = ROOTS.flatMap((root) => sources(path.join(repo, root)))
            .map((file) => path.relative(repo, file).replace(/\\/g, '/'))
            .filter((rel) => !ALLOWED.has(rel))
            .filter((rel) => /aionima/i.test(fs.readFileSync(path.join(repo, rel), 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('in db.ts, names it only inside the migrations', () => {
        const repo = path.resolve(__dirname, '..', '..');
        const lines = fs.readFileSync(path.join(repo, 'main/db.ts'), 'utf8').split(/\r?\n/);
        const end = lines.findIndex((l) => l.includes('const apply = d.transaction('));
        expect(end).toBeGreaterThan(0);
        const outside = lines
            .map((l, i) => ({ l, i }))
            .filter(({ l, i }) => i > end && /aionima/i.test(l))
            .map(({ l, i }) => `${i + 1}: ${l.trim()}`);
        expect(outside).toEqual([]);
    });
});
