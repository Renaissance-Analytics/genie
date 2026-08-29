import path from 'path';
import { describe, expect, it } from 'vitest';
import { genieOsWorkspacePath, syncGenieOsWorkspace } from '../os-workspace';

describe('Genie OS workspace', () => {
    it('lives in its own AGI envelope instead of using the user home directory', () => {
        expect(genieOsWorkspacePath(path.join('C:', 'GenieData'))).toBe(
            path.join('C:', 'GenieData', 'genie-os.agi'),
        );
    });

    it('rejects non-GitHub and non-HTTPS sync destinations before touching git', async () => {
        await expect(syncGenieOsWorkspace('unused', 'file:///tmp/steal.git')).rejects.toThrow(/GitHub HTTPS/);
        await expect(syncGenieOsWorkspace('unused', 'https://evil.example/repo.git')).rejects.toThrow(/GitHub HTTPS/);
    });
});
