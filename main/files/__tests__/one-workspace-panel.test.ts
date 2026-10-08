import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTerminalSpec, getDb, initDatabase, listTerminalSpecs } from '../../db';

beforeAll(() => {
    initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'file-panel-')));
    getDb().prepare(`INSERT INTO workspaces
        (id, backend, project_id, project_name, tynn_project_id, tynn_project_name, shape, path, last_opened_at, created_by_genie)
        VALUES ('__system__', 'tynn', 'w', 'Workspace', 'w', 'Workspace', 'agi', '/w', null, 0)`).run();
});

describe('one persistent file panel per workspace', () => {
    it('returns the same workspace editor on repeated creation', () => {
        const first = createTerminalSpec({ id: 'files-first', workspace_id: '__system__', label: 'Files', cwd: '/w', type: 'code' });
        const second = createTerminalSpec({ id: 'files-second', workspace_id: '__system__', label: 'Files again', cwd: '/w', type: 'code' });
        expect(second.id).toBe(first.id);
        expect(listTerminalSpecs().filter((spec) => spec.type === 'code' && spec.workspace_id === '__system__')).toHaveLength(1);
    });

    it('keeps terminals independent', () => {
        const first = createTerminalSpec({ id: 'term-first', workspace_id: '__system__', label: 'Terminal', cwd: '/w' });
        const second = createTerminalSpec({ id: 'term-second', workspace_id: '__system__', label: 'Terminal', cwd: '/w' });
        expect(second.id).not.toBe(first.id);
    });
});
