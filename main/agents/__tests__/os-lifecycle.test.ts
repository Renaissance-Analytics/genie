import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { markOsAgentOriented, osAgentBootMode } from '../os-lifecycle';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('Genie OSA lifecycle', () => {
    it('stays in first-boot setup until Genie records completed orientation', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-osa-life-'));
        roots.push(root);
        expect(osAgentBootMode(root)).toBe('first-boot');
        markOsAgentOriented(root);
        expect(osAgentBootMode(root)).toBe('recovery');
    });
});
