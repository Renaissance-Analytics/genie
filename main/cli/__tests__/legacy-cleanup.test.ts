import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    cleanupLegacyTynnCliAt,
    removeManagedBashrcLines,
    removePathEntries,
} from '../legacy-cleanup';

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy tynn-cli cleanup', () => {
    it('removes the managed bashrc block and its spacer', () => {
        const input = 'export PATH="/usr/bin:$PATH"\n\n# tynn-cli\nexport PATH="/home/me/.genie/tynn-cli/.custom:/home/me/.genie/tynn-cli/bin:$PATH"\n';
        expect(removeManagedBashrcLines(input)).toBe('export PATH="/usr/bin:$PATH"\n');
    });

    it('removes orphaned managed exports but preserves independent installs', () => {
        const input = [
            'export PATH="/home/me/.genie/tynn-cli/bin:$PATH"',
            '# tynn-cli',
            'export PATH="/home/me/.local/share/tynn-cli/bin:$PATH"',
            '',
        ].join('\n');
        expect(removeManagedBashrcLines(input)).toBe(
            '# tynn-cli\nexport PATH="/home/me/.local/share/tynn-cli/bin:$PATH"\n',
        );
    });

    it('preserves CRLF and is idempotent when no managed entry exists', () => {
        const input = 'export PATH="/usr/bin:$PATH"\r\n';
        expect(removeManagedBashrcLines(input)).toBe(input);
    });

    it('removes normalized Windows PATH entries without reordering the rest', () => {
        const current = 'C:\\Tools;C:/Users/Me/.genie/tynn-cli/win-shims\\;C:\\Other';
        expect(removePathEntries(
            current,
            ['c:\\users\\me\\.genie\\tynn-cli\\win-shims'],
            ';',
            'win32',
        )).toEqual({ value: 'C:\\Tools;C:\\Other', changed: true });
    });

    it('leaves unrelated PATH entries unchanged', () => {
        expect(removePathEntries('/usr/bin:/opt/bin', ['/missing'], ':', 'linux')).toEqual({
            value: '/usr/bin:/opt/bin',
            changed: false,
        });
    });

    it('backs up user files, deletes tools, cleans bashrc, and is idempotent', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-cli-cleanup-'));
        roots.push(home);
        const install = path.join(home, '.genie', 'tynn-cli');
        fs.mkdirSync(path.join(install, '.custom'), { recursive: true });
        fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(install, 'tynn.config'), 'LICENSE=secret');
        fs.writeFileSync(path.join(install, '.custom', 'mine'), 'custom');
        fs.writeFileSync(path.join(install, 'bin', 'resetme'), 'tool');
        fs.writeFileSync(
            path.join(home, '.bashrc'),
            `# tynn-cli\nexport PATH="${install}/.custom:${install}/bin:$PATH"\n`,
        );
        const environment = { PATH: `${path.join(install, 'bin')};C:\\Windows` };

        const first = await cleanupLegacyTynnCliAt(home, {
            platform: 'win32',
            environment,
            removeWindowsPath: async () => {},
        });

        expect(first.cleaned).toBe(true);
        expect(first.backupDir).not.toBeNull();
        expect(fs.readFileSync(path.join(first.backupDir!, 'tynn.config'), 'utf8')).toBe('LICENSE=secret');
        expect(fs.readFileSync(path.join(first.backupDir!, '.custom', 'mine'), 'utf8')).toBe('custom');
        expect(fs.existsSync(install)).toBe(false);
        expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe('');
        expect(environment.PATH).toBe('C:\\Windows');

        await expect(cleanupLegacyTynnCliAt(home, {
            platform: 'win32',
            environment,
            removeWindowsPath: async () => {},
        }))
            .resolves.toMatchObject({ cleaned: false, skipped: true });
    });
});
