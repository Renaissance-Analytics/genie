import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL_BEGIN, SHELL_END, applyShellBlock, removeShellBlock, shellFilesToEdit, windowsPathWith, windowsPathWithout } from '../src/core/machine-path.js';
import { applyMachinePath, machinePathStatus, removeMachinePath, type MachinePathPorts } from '../src/main/machine-path.js';

/**
 * THE MACHINE'S OWN PATH, ONCE, WITH CONSENT (the owner's decision 3, 2026-10-18: "The default applies to the whole
 * machine: the shims directory goes on the machine's PATH (a one-time consented change), so terminals outside Genie use
 * the chosen version too"; plan `.ai/plans/genie-2-toolchain-rest.md`, row TC3b).
 *
 * What goes on is the FIXED `current` entries (core/toolchain-defaults.ts): choosing a default afterwards only repoints a
 * link, so this change is made once. It is the person's own PATH, so the rules are strict:
 *   - nothing without consent; applying twice changes nothing the second time;
 *   - Undo restores EXACTLY what was there (byte-for-byte), removing only what Genie added;
 *   - Windows: the user PATH is read RAW (unexpanded) and written back as an expandable string, so `%USERPROFILE%\…`
 *     entries keep working — `setx` (truncates at 1024) and a plain .NET write (can turn %…% entries literal) would not;
 *   - macOS/Linux: one marked block in the shell's startup files, nothing else touched.
 */

const ENTRIES_WIN = ['C:\\Users\\me\\.genie\\genie2-toolchain\\current\\node', 'C:\\Users\\me\\.genie\\genie2-toolchain\\current\\go\\bin'];
const ENTRIES_NIX = ['/home/me/.genie/genie2-toolchain/current/node/bin', '/home/me/.genie/genie2-toolchain/current/go/bin'];

describe('the shell block (macOS/Linux)', () => {
    it('appended once, marked, exporting the entries ahead of the existing PATH; applying again is the same text', () => {
        const before = 'export EDITOR=vim\nalias ll="ls -l"\n';
        const once = applyShellBlock(before, ENTRIES_NIX);
        expect(once.startsWith(before)).toBe(true);
        expect(once).toContain(`${SHELL_BEGIN}\nexport PATH="${ENTRIES_NIX.join(':')}:$PATH"\n${SHELL_END}\n`);
        expect(applyShellBlock(once, ENTRIES_NIX)).toBe(once);
    });

    it('Undo restores the file EXACTLY — with or without a trailing newline, and for a file Genie created', () => {
        for (const before of ['export A=1\n', 'export A=1', '']) {
            expect(removeShellBlock(applyShellBlock(before, ENTRIES_NIX)), JSON.stringify(before)).toBe(before);
        }
        // Text with no block is left alone.
        expect(removeShellBlock('export A=1\n')).toBe('export A=1\n');
    });

    it('which startup files: ~/.profile always, plus each of .bash_profile / .bashrc / .zprofile / .zshrc that exists', () => {
        expect(shellFilesToEdit(['.zshrc', '.bashrc'])).toEqual(['.profile', '.bashrc', '.zshrc']);
        expect(shellFilesToEdit([])).toEqual(['.profile']);
    });
});

describe('the Windows user PATH (raw)', () => {
    it('missing entries go FIRST; everything else — %USERPROFILE% entries included — is kept byte-for-byte', () => {
        const raw = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools';
        const next = windowsPathWith(raw, ENTRIES_WIN);
        expect(next).toBe(`${ENTRIES_WIN.join(';')};${raw}`);
        expect(windowsPathWith(next, ENTRIES_WIN)).toBe(next);
    });

    it('an entry already there (any case, trailing slash) is not added twice; Undo removes ONLY Genie’s entries', () => {
        const raw = `C:\\Tools;${ENTRIES_WIN[1]!.toUpperCase()}\\`;
        const next = windowsPathWith(raw, ENTRIES_WIN);
        expect(next).toBe(`${ENTRIES_WIN[0]};${raw}`);
        expect(windowsPathWithout(windowsPathWith('%USERPROFILE%\\x;C:\\Tools', ENTRIES_WIN), ENTRIES_WIN)).toBe('%USERPROFILE%\\x;C:\\Tools');
    });
});

/** A fake machine: files in a home directory, and a Windows registry value read/written through PowerShell. */
function machine(platform: 'win32' | 'linux', files: Record<string, string> = {}, registryPath = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools') {
    const home = platform === 'win32' ? 'C:\\Users\\me' : '/home/me';
    const disk = new Map(Object.entries(files).map(([k, v]) => [join(home, k), v]));
    const reg = { value: registryPath, type: 'ExpandString', broadcasts: 0 };
    const ran: string[] = [];
    const p: MachinePathPorts = {
        platform, home, entries: platform === 'win32' ? ENTRIES_WIN : ENTRIES_NIX,
        fs: { exists: (f) => disk.has(f), readText: (f) => disk.get(f) ?? null, writeText: (f, t) => { disk.set(f, t); } },
        run: async (bin, args) => {
            const cmd = args.join(' ');
            ran.push(`${bin} ${cmd}`);
            if (/GetValue\('Path'/.test(cmd)) return { stdout: `${reg.value}\n`, exitCode: 0 };
            const m = /Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value '((?:[^']|'')*)' -Type ExpandString/.exec(cmd);
            if (m) { reg.value = m[1]!.replace(/''/g, "'"); reg.type = 'ExpandString'; if (/SendMessageTimeout/.test(cmd)) reg.broadcasts += 1; return { stdout: '', exitCode: 0 }; }
            return { stdout: '', exitCode: 1 };
        },
    };
    return { p, disk, reg, ran, home };
}

describe('applying it to a machine', () => {
    it('nothing without consent', async () => {
        const m = machine('linux', { '.profile': 'export A=1\n' });
        expect(await applyMachinePath(false, m.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/go-ahead/) });
        expect(m.disk.get(join(m.home, '.profile'))).toBe('export A=1\n');
    });

    it('Linux: the block goes into ~/.profile and each existing rc; status says applied; Undo restores every file exactly', async () => {
        const m = machine('linux', { '.profile': 'export A=1\n', '.bashrc': 'alias x=y\n' });
        expect(await machinePathStatus(m.p)).toEqual({ applied: false, where: [] });
        const r = await applyMachinePath(true, m.p);
        expect(r).toEqual({ kind: 'applied', where: [join(m.home, '.profile'), join(m.home, '.bashrc')] });
        expect(m.disk.get(join(m.home, '.bashrc'))).toContain(SHELL_BEGIN);
        expect(await machinePathStatus(m.p)).toEqual({ applied: true, where: [join(m.home, '.profile'), join(m.home, '.bashrc')] });
        expect(await removeMachinePath(m.p)).toEqual({ kind: 'removed', where: [join(m.home, '.profile'), join(m.home, '.bashrc')] });
        expect(m.disk.get(join(m.home, '.profile'))).toBe('export A=1\n');
        expect(m.disk.get(join(m.home, '.bashrc'))).toBe('alias x=y\n');
    });

    it('Windows: the RAW user PATH gets the entries first, written back as ExpandString with the change broadcast; measured by reading it back', async () => {
        const m = machine('win32');
        const original = m.reg.value;
        const r = await applyMachinePath(true, m.p);
        expect(r).toEqual({ kind: 'applied', where: ['the user PATH (HKCU\\Environment)'] });
        expect(m.reg.value).toBe(`${ENTRIES_WIN.join(';')};${original}`);
        expect(m.reg.value).toContain('%USERPROFILE%');
        expect(m.reg.type).toBe('ExpandString');
        expect(m.reg.broadcasts).toBe(1);
        // setx would truncate at 1024 characters; it is never used.
        expect(m.ran.some((c) => /\bsetx\b/i.test(c))).toBe(false);
        expect((await machinePathStatus(m.p)).applied).toBe(true);
        // Twice changes nothing; Undo restores the original exactly.
        await applyMachinePath(true, m.p);
        expect(m.reg.value).toBe(`${ENTRIES_WIN.join(';')};${original}`);
        await removeMachinePath(m.p);
        expect(m.reg.value).toBe(original);
    });

    it('Windows: a write that does not read back as asked is reported, not claimed', async () => {
        const m = machine('win32');
        const real = m.p.run;
        m.p = { ...m.p, run: async (bin, args) => (/Set-ItemProperty/.test(args.join(' ')) ? { stdout: '', exitCode: 0 } : real(bin, args)) };
        expect(await applyMachinePath(true, m.p)).toMatchObject({ kind: 'not-applied', reason: expect.stringMatching(/read back/) });
    });
});
