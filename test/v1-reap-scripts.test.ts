import { describe, expect, it } from 'vitest';
import { v1Leftovers } from '../src/core/v1-reap.js';

/**
 * GENIE KILLS ONLY WHAT IS PROVABLY GENIE 1's. Measured on the owner's desktop (2026-10-13): starting Genie logged
 * "reaped v1's runtime: 2 of 2 (2 orphaned shells)" — the two were background SCRIPTS (`bash rebuild-windows.sh`, a
 * release chain) whose launcher had exited, killed mid-run along with the VM rebuild they drove. The rule matched any
 * bash/cmd/powershell whose parent was gone, on EVERY boot. Genie 1's leftovers were INTERACTIVE shells orphaned by its
 * dead pty host, at the boot that replaced it. So: an orphaned shell is a victim only when (a) this is the boot that
 * imports Genie 1 (`includeShells`), and (b) its command line is an interactive shell — no script, no -c, no /c, no
 * -File/-Command. A command line Genie cannot read is not a victim: unknown is not "v1's".
 */
const roots = ['C:\\Users\\u\\AppData\\Roaming\\genie\\runtime'];
const BASH = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const p = (pid: number, executable: string, parentPid: number | null, commandLine: string | null) => ({ pid, executable, parentPid, commandLine });
const DEAD = 17280;

describe('orphaned shells', () => {
    const procs = [
        p(100, 'C:\\Windows\\explorer.exe', null, null),
        p(200, 'C:\\Users\\u\\AppData\\Local\\Programs\\Genie\\Genie.exe', 100, null),
        // Genie 1's: interactive shells its dead pty host left
        p(301, BASH, DEAD, `"${BASH}" --login -i`),
        p(302, BASH, DEAD, `"${BASH}"`),
        p(303, CMD, DEAD, CMD),
        p(304, PS, DEAD, 'powershell.exe -NoLogo'),
        // the person's own background work: orphaned too, NEVER a victim
        p(401, BASH, DEAD, `"${BASH}" .ai/sandbox/test-vm/rebuild-windows.sh`),
        p(402, BASH, DEAD, `"${BASH}" -c "sleep 600"`),
        p(403, CMD, DEAD, 'C:\\Windows\\system32\\cmd.exe /d /s /c "claude --print"'),
        p(404, PS, DEAD, 'powershell -NoProfile -File C:\\x\\build.ps1'),
        p(405, PS, DEAD, 'powershell -NoProfile -Command "Get-Date"'),
        p(406, BASH, DEAD, null),
        p(407, 'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe', 401, 'VBoxManage list runningvms'),
        // Genie 1's runtime binary (by path) — the control that the reaper still works
        p(500, 'C:\\Users\\u\\AppData\\Roaming\\genie\\runtime\\caddy\\caddy.exe', DEAD, null),
    ];

    it('on the boot that imports Genie 1: only the INTERACTIVE orphaned shells — counted; scripts, commands and unreadable ones survive', () => {
        const pids = v1Leftovers(procs, { roots, selfPid: 200, includeShells: true }).map((v) => v.pid).sort();
        expect(pids).toEqual([301, 302, 303, 304, 500]);
    });

    it('on every other boot: no shell at all — only Genie 1’s runtime binaries (the control: caddy is still taken)', () => {
        const pids = v1Leftovers(procs, { roots, selfPid: 200 }).map((v) => v.pid).sort();
        expect(pids).toEqual([500]);
    });
});
