import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingWorkstationReset, isWorkstationResetPending, requestWorkstationReset } from '../reset';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-reset-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'toolchain', 'node', '22'), { recursive: true });
    fs.writeFileSync(path.join(root, 'toolchain', 'node', '22', 'node.exe'), 'owned tool');
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', 'installed.json'), '{}');
    fs.writeFileSync(path.join(root, 'genie.db'), 'state');
    return root;
}

describe('workstation reset boundary', () => {
    it('defers the destructive reset until the clean restart boundary', () => {
        const root = fixture();

        requestWorkstationReset(root);

        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(true);
        expect(fs.existsSync(path.join(root, '.reset-workstation'))).toBe(true);
        expect(isWorkstationResetPending(root)).toBe(true);
    });

    it('removes Genie workstation state while preserving the entire managed toolchain', () => {
        const root = fixture();
        requestWorkstationReset(root);

        expect(applyPendingWorkstationReset(root)).toEqual({ applied: true, preserved: ['toolchain'] });
        expect(fs.readFileSync(path.join(root, 'toolchain', 'node', '22', 'node.exe'), 'utf8')).toBe(
            'owned tool',
        );
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'plugins'))).toBe(false);
        expect(fs.existsSync(path.join(root, '.reset-workstation'))).toBe(false);
    });

    it('does nothing without an explicit pending-reset marker', () => {
        const root = fixture();
        expect(applyPendingWorkstationReset(root)).toEqual({ applied: false, preserved: [] });
        expect(fs.existsSync(path.join(root, 'genie.db'))).toBe(true);
    });
});
