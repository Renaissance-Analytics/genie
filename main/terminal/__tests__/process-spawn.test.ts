import { describe, expect, it } from 'vitest';
import { buildProcessArgs } from '../process-spawn';

describe('buildProcessArgs', () => {
    const cmd = 'php artisan queue:work';

    it('runs bash/zsh as a login command shell', () => {
        expect(buildProcessArgs('/usr/bin/bash', cmd)).toEqual(['-lc', cmd]);
        expect(buildProcessArgs('zsh', cmd)).toEqual(['-lc', cmd]);
    });

    it('runs sh/dash with -c (no login)', () => {
        expect(buildProcessArgs('/bin/sh', cmd)).toEqual(['-c', cmd]);
        expect(buildProcessArgs('dash', cmd)).toEqual(['-c', cmd]);
    });

    it('runs PowerShell with -NoProfile -Command', () => {
        expect(buildProcessArgs('pwsh', cmd)).toEqual(['-NoProfile', '-Command', cmd]);
        expect(
            buildProcessArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cmd),
        ).toEqual(['-NoProfile', '-Command', cmd]);
    });

    it('runs cmd.exe with /c', () => {
        expect(buildProcessArgs('C:\\Windows\\System32\\cmd.exe', cmd)).toEqual(['/c', cmd]);
    });

    it('handles a Windows Git Bash path', () => {
        expect(buildProcessArgs('C:\\Program Files\\Git\\bin\\bash.exe', cmd)).toEqual([
            '-lc',
            cmd,
        ]);
    });

    it('falls back to -c for unknown shells', () => {
        expect(buildProcessArgs('/opt/weird/fish', cmd)).toEqual(['-c', cmd]);
    });
});
