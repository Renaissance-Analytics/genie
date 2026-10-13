import { describe, expect, it } from 'vitest';
import { v1Leftovers } from '../src/core/v1-reap.js';
import type { RunningProcess } from '../src/main/upgrade.js';

/**
 * AFTER THE UPGRADE, v1's RUNTIME IS GONE. The owner's first real upgrade left 73 of v1's processes
 * running: shells orphaned by v1's dead pty host, caddy site servers, php, node — all from
 * `%APPDATA%\genie\{runtime,toolchain}` or Git's bash. The rule is pure; every claim has a control.
 */
const p = (pid: number, executable: string, parentPid: number | null, commandLine: string | null = null): RunningProcess => ({ pid, executable, parentPid, commandLine });
const roots = ['C:\\Users\\u\\AppData\\Roaming\\genie\\runtime', 'C:\\Users\\u\\AppData\\Roaming\\genie\\toolchain', 'C:\\Users\\u\\AppData\\Roaming\\genie\\pty-host'];

const processes: RunningProcess[] = [
    p(4, 'C:\\Windows\\System32\\ntoskrnl.exe', null),
    p(100, 'C:\\Windows\\explorer.exe', 4),
    // Genie 2 and its ancestry
    p(200, 'C:\\Users\\u\\AppData\\Local\\Programs\\Genie\\Genie.exe', 100),
    p(201, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 200), // a Genie 2 terminal: parent alive
    // v1's runtime, orphaned (pty host 17280 is dead)
    p(300, 'C:\\Users\\u\\AppData\\Roaming\\genie\\runtime\\20.20.2-win32-x64-caddy2.9.1\\caddy.exe', 17280),
    p(301, 'c:\\users\\u\\appdata\\roaming\\GENIE\\toolchain\\php\\8.4.24\\php.exe', 17281),
    p(302, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 17280, '\"C:\\Program Files\\Git\\usr\\bin\\bash.exe\" --login -i'), // v1 terminal shell (interactive), orphaned
    p(303, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 302), // its child shell
    p(304, 'C:\\Windows\\System32\\conhost.exe', 303), // grandchild
    p(305, 'C:\\Users\\u\\.claude\\claude.exe', 303), // an agent TUI inside the dead terminal
    // the person's own things: left alone
    p(400, 'C:\\Program Files\\Git\\usr\\bin\\mintty.exe', 100),
    p(401, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 400), // a bash with a live parent
    p(402, 'C:\\Windows\\System32\\OpenSSH\\sshd.exe', 4),
    p(403, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 402), // an SSH session's shell
    p(404, 'C:\\Users\\u\\.genie\\runtime\\caddy\\caddy.exe', 200), // GENIE 2's own caddy, under ITS root
    p(405, 'C:\\Program Files\\Docker\\Docker\\com.docker.backend.exe', 100),
];

describe('v1Leftovers', () => {
    // The boot that imports Genie 1 — the only one that takes orphaned shells (v1-reap-scripts.test).
    const victims = v1Leftovers(processes, { roots, selfPid: 200, includeShells: true });
    const pids = victims.map((v) => v.pid).sort((a, b) => a - b);

    it('takes v1 runtime binaries (case-insensitively), orphaned shells, and every descendant — with the reason each', () => {
        expect(pids).toEqual([300, 301, 302, 303, 304, 305]);
        const why = Object.fromEntries(victims.map((v) => [v.pid, v.why]));
        expect(why[300]).toBe('v1 runtime binary');
        expect(why[301]).toBe('v1 runtime binary');
        expect(why[302]).toBe('orphaned shell');
        expect(why[303]).toBe('child of a victim');
        expect(why[305]).toBe('child of a victim');
    });

    it("CONTROL: a shell with a live parent, Genie 2's own terminal and caddy, Genie 2 itself and its ancestors, SSH, Docker — none are victims", () => {
        for (const keep of [4, 100, 200, 201, 400, 401, 402, 403, 404, 405]) expect(pids, String(keep)).not.toContain(keep);
    });

    it('CONTROL: with nothing of v1 running and no orphans, the list is empty — the rule does not invent victims', () => {
        const clean = processes.filter((x) => x.pid < 300 || x.pid >= 400);
        expect(v1Leftovers(clean, { roots, selfPid: 200, includeShells: true })).toEqual([]);
    });

    it("Genie 2's own ancestry is protected even when it is a shell with a dead parent (a crashed launcher)", () => {
        const odd = [...processes, p(500, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 99999), p(501, 'C:\\Users\\u\\AppData\\Local\\Programs\\Genie\\Genie.exe', 500)];
        const v = v1Leftovers(odd, { roots, selfPid: 501, includeShells: true }).map((x) => x.pid);
        expect(v).not.toContain(500);
        expect(v).not.toContain(501);
    });
});
