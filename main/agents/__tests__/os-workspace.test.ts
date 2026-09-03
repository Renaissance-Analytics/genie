import path from 'path';
import fs from 'fs';
import os from 'os';
import { describe, expect, it } from 'vitest';
import { genieOsWorkspacePath, listGenieOsEntries, syncGenieOsWorkspace } from '../os-workspace';

describe('Genie OS workspace', () => {
    it('lists the real managed repository directory for Fancy Git UI', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'genie-os-list-'));
        await fs.promises.mkdir(path.join(root, '.gosa', '.ai'), { recursive: true });
        await fs.promises.writeFile(path.join(root, '.gosa', 'project.json'), '{}');
        await expect(listGenieOsEntries(root, '')).resolves.toEqual([
            { id: '.ai', name: '.ai', path: '.ai', kind: 'directory' },
            { id: 'project.json', name: 'project.json', path: 'project.json', kind: 'file' },
        ]);
        await fs.promises.rm(root, { recursive: true, force: true });
    });
    it('lives in its own protected envelope, outside the reset boundary', () => {
        expect(genieOsWorkspacePath(path.join('C:', 'Users', 'wishborn'))).toBe(
            path.join('C:', 'Users', 'wishborn', '.gosa'),
        );
    });

    it('rejects non-GitHub and non-HTTPS sync destinations before touching git', async () => {
        await expect(syncGenieOsWorkspace('unused', 'file:///tmp/steal.git')).rejects.toThrow(/GitHub HTTPS/);
        await expect(syncGenieOsWorkspace('unused', 'https://evil.example/repo.git')).rejects.toThrow(/GitHub HTTPS/);
    });
});
