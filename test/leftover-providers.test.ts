import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leftoverProviders, type ProcessRow } from '../src/core/leftover-providers.js';

/**
 * NO AGENT IS EVER DRIVEN BY TWO PROCESSES (Tynn #796, part 2). The owner, 2026-10-17: after an upgrade moic resumed
 * its session while a claude from the PREVIOUS Genie — `--resume` of the same session, its parent gone — went on
 * writing to the same worktree. A stop cannot reach a provider whose Genie was killed before the stop ran (an
 * installer closing it, a crash, Task Manager). So at boot, BEFORE Genie starts any agent, nothing can legitimately be
 * running one of its agents' sessions: whatever runs Genie's provider command line on an agent's thread is a leftover,
 * and it ends — with everything under it — before that agent is resumed.
 *
 * Genie's provider command line (prism-acp's ClaudeDriver): `claude --print --output-format stream-json
 * --input-format stream-json … --resume <thread>`; on Windows wrapped as `cmd.exe /d /s /c "claude … --resume <thread>"`.
 * A person's own `claude --resume <thread>` in a terminal (interactive, no --print/stream-json) is NEVER touched.
 */

const MOIC = '22aa2d90-d747-427e-a333-1aabb902d94e';
const TYNN = '87ed0119-cc77-42cf-9d4c-d7f44fe99c89';
const sessions = [{ name: 'moic', threadId: MOIC }, { name: 'tynn', threadId: TYNN }];
const provider = (thread: string) => `claude --print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --resume ${thread}`;

describe('the leftovers at boot', () => {
    it('the measured orphan: claude on an agent’s thread, parent gone → ended, named by its agent', () => {
        const rows: ProcessRow[] = [
            { pid: 49076, ppid: 46204, cmd: provider(MOIC) },
            { pid: 100, ppid: 1, cmd: 'C:\\Program Files\\Genie\\Genie.exe' },
        ];
        expect(leftoverProviders(rows, sessions)).toEqual([{ agent: 'moic', pids: [49076] }]);
    });

    it('the cmd.exe wrapper and everything under the provider go with it; the wrapper is the root', () => {
        const rows: ProcessRow[] = [
            { pid: 37268, ppid: 999, cmd: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "${provider(MOIC)}"` },
            { pid: 21436, ppid: 37268, cmd: provider(MOIC) },
            { pid: 54972, ppid: 21436, cmd: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm test"' },
            { pid: 28068, ppid: 54972, cmd: 'node vitest' },
        ];
        expect(leftoverProviders(rows, sessions)).toEqual([{ agent: 'moic', pids: [37268, 21436, 54972, 28068] }]);
    });

    it('NEVER a person’s own claude on the same thread (interactive: no --print / stream-json)', () => {
        const rows: ProcessRow[] = [{ pid: 50336, ppid: 55144, cmd: `C:\\Users\\a\\.local\\bin\\claude.exe --resume ${MOIC}` }];
        expect(leftoverProviders(rows, sessions)).toEqual([]);
    });

    it('NEVER a provider on a thread that is not one of Genie’s agents, or a prefix of one', () => {
        const rows: ProcessRow[] = [
            { pid: 1, ppid: 0, cmd: provider('11111111-2222-3333-4444-555555555555') },
            { pid: 2, ppid: 0, cmd: provider(MOIC.slice(0, 20)) },
            { pid: 3, ppid: 0, cmd: provider(`${MOIC}x`) },
        ];
        expect(leftoverProviders(rows, sessions)).toEqual([]);
    });

    it('NEVER the Claude desktop app, or anything without the provider shape', () => {
        const rows: ProcessRow[] = [
            { pid: 21184, ppid: 4332, cmd: '"C:\\Program Files\\WindowsApps\\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\\app\\claude.exe"' },
            { pid: 5, ppid: 0, cmd: `node something.js --print --output-format stream-json --resume ${MOIC}` },
        ];
        expect(leftoverProviders(rows, sessions)).toEqual([]);
    });

    it('two agents with leftovers → one entry each; an agent with no thread yet is skipped', () => {
        const rows: ProcessRow[] = [
            { pid: 10, ppid: 0, cmd: provider(MOIC) },
            { pid: 11, ppid: 0, cmd: provider(TYNN) },
        ];
        expect(leftoverProviders(rows, [...sessions, { name: 'fresh', threadId: null }])).toEqual([
            { agent: 'moic', pids: [10] },
            { agent: 'tynn', pids: [11] },
        ]);
    });

    it('NEVER a provider THIS Genie started: anything under the running Genie is its own, at any depth', () => {
        const SELF = 7000;
        const rows: ProcessRow[] = [
            { pid: 7100, ppid: SELF, cmd: `cmd.exe /d /s /c "${provider(MOIC)}"` },
            { pid: 7101, ppid: 7100, cmd: provider(MOIC) },
            { pid: 49076, ppid: 46204, cmd: provider(MOIC) }, // CONTROL, same table: the old Genie's orphan is still found
        ];
        expect(leftoverProviders(rows, sessions, SELF)).toEqual([{ agent: 'moic', pids: [49076] }]);
    });

    it('an unsafe thread id (not resumable) is never matched — it is never in a command line Genie writes', () => {
        expect(leftoverProviders([{ pid: 1, ppid: 0, cmd: provider('a&b') }], [{ name: 'x', threadId: 'a&b' }])).toEqual([]);
    });
});

describe('wired', () => {
    it('main sweeps the leftovers BEFORE the relaunch plan starts any agent', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        const sweep = main.indexOf('sweepLeftoverProviders(');
        const plan = main.indexOf('relaunchPlan({');
        expect(sweep).toBeGreaterThan(-1);
        expect(plan).toBeGreaterThan(sweep);
    });
});
