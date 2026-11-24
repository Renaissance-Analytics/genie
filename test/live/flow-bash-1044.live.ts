/**
 * A FLOW'S `bash` IS THE KEPT PROCESS'S `bash`, FOR REAL (Tynn #1044) — Windows, in a test VM only.
 *
 * The unit test (test/flow-shell-parity-1044.test.ts) proves the lookup with a fake engine. This runs the real one, through the
 * real supervisor, as genie-host composes it: a kept process (ProcessBook) and a flow's `genie/terminal_run`
 * (supervisedCommand) each run `bash -c uname`, and both must answer Git Bash's MINGW/MSYS, never WSL's Linux.
 *
 * The POSITIVE CONTROL, in the same run: System32's bash.exe asked directly. Where it answers Linux, this machine has a WSL
 * that a bare `bash` used to reach, and the check above distinguishes the bug. Where it does not, the run says so: the check
 * then proves only that Git Bash runs, not that WSL was avoided.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { supervisedCommand } from '../../src/main/flow-runner.js';
import { ProcessBook } from '../../src/main/process-book.js';
import { ProcessSupervisor, type ProcessStatus } from '../../src/main/process-supervisor.js';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

function ended(supervisor: ProcessSupervisor, id: string, ms: number): Promise<ProcessStatus | null> {
    return new Promise((resolveEnd) => {
        const t = setTimeout(() => { off(); resolveEnd(null); }, ms);
        const off = supervisor.onChange((s) => {
            if (s.id === id && (s.state === 'exited' || s.state === 'failed')) { clearTimeout(t); off(); resolveEnd(s); }
        });
    });
}

async function main(): Promise<void> {
    if (process.platform !== 'win32') { console.log('Windows only: nothing to check here.'); return; }
    const home = mkdtempSync(join(tmpdir(), 'genie2-1044-home-'));
    const ws = { id: 'ws-1044', path: mkdtempSync(join(tmpdir(), 'genie2-1044-ws-')) };
    const supervisor = new ProcessSupervisor(realFancyTermPort());
    const envFor = () => ({ GENIE_1044_PROBE: 'service-env' });
    const book = await ProcessBook.open(home, { supervisor, envFor, asleep: () => false });

    const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'bash.exe');
    let wsl = false;
    if (existsSync(system32)) {
        const id = 'control-wsl';
        const done = ended(supervisor, id, 90_000);
        supervisor.start({ id, workspaceId: ws.id, name: 'control', command: `"${system32}" -c uname`, cwd: ws.path, restart: 'never' });
        const s = await done;
        const out = supervisor.readLog(id)?.text ?? '';
        wsl = /\bLinux\b/.test(out);
        console.log(`  CONTROL  System32 bash.exe -c uname: exit ${s?.exitCode ?? 'none'}; answers Linux: ${wsl}`);
    } else {
        console.log('  CONTROL  no System32 bash.exe on this machine: WSL is not here, so WSL being avoided is NOT proven by this run');
    }

    // The end is listened for BEFORE the start: a quick command can exit inside create.
    let keptId = '';
    const keptEnd = new Promise<ProcessStatus | null>((resolveEnd) => {
        const t = setTimeout(() => { off(); resolveEnd(null); }, 90_000);
        const off = supervisor.onChange((s) => {
            if (s.id === keptId || (keptId === '' && s.name === 'probe')) {
                if (s.state === 'exited' || s.state === 'failed') { clearTimeout(t); off(); resolveEnd(s); }
            }
        });
    });
    const kept = await book.create({ workspaceId: ws.id, workspacePath: ws.path, name: 'probe', command: 'bash -c "uname; echo $GENIE_1044_PROBE"', restart: 'never' });
    keptId = kept.id;
    const keptStatus = await keptEnd;
    const keptOut = supervisor.readLog(kept.id)?.text ?? '';

    const run = supervisedCommand({ supervisor, workspacePath: (id) => (id === ws.id ? ws.path : null), envFor }, { processId: 'flow-run:1044', name: 'flow: 1044' });
    const flow = await run(ws.id, 'bash -c "uname; echo $GENIE_1044_PROBE"', undefined);

    const flowUname = /(MINGW|MSYS)\S*/.exec(flow.output)?.[0] ?? null;
    const keptUname = /(MINGW|MSYS)\S*/.exec(keptOut)?.[0] ?? null;
    console.log(`  kept process: exit ${keptStatus?.exitCode ?? 'none'}, uname ${keptUname ?? 'not MINGW/MSYS'}`);
    console.log(`  flow step:    exit ${flow.exitCode}, uname ${flowUname ?? 'not MINGW/MSYS'}`);
    check(!/\bLinux\b/.test(flow.output), "1. the flow's bash is not WSL's (uname is not Linux)", flow.output.trim().slice(-200));
    check(flowUname !== null, "2. the flow's bash is Git Bash (uname MINGW/MSYS)");
    check(flowUname !== null && flowUname === keptUname, '3. the kept process answers the same', `${keptUname} vs ${flowUname}`);
    check(flow.output.includes('service-env') && keptOut.includes('service-env'), '4. both had the workspace service env');
    console.log(wsl ? '\nWSL PRESENT: the control answered Linux, so checks 1-3 distinguish the bug.' : '\nWSL NOT PRESENT (or answers no Linux): checks 1-3 prove Git Bash runs, not that WSL was avoided.');

    if (failures.length > 0) { console.log(`\nFAILED: ${failures.join('; ')}`); process.exit(1); }
    console.log('\nALL PASS');
    process.exit(0);
}

void main().catch((error: unknown) => { console.error(error); process.exit(2); });
