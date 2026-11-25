import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEP_WRAPPER, STEP_WRAPPER_NAME, batchRefusal, checkFailure, commandLine, passwordRefusal, sudoCheckArgs, sudoStepArgs, type ElevatedBatch, type ElevationPromptEvent } from '../src/core/elevation.js';
import { MAX_PASSWORD_TRIES, privilegedBatch, privilegedOutcome, realSudoPath, realSudoSpawn, runElevatedWithPassword, serialized, type PasswordAnswer, type PasswordQuestion, type SudoSpawn } from '../src/main/linux-elevation.js';
import type { PrivilegedStep } from '../src/main/elevate.js';
import { ElevationBroker, NOT_CAPABLE, NO_CLIENT } from '../src/main/elevation-broker.js';

/**
 * TYNN #973 — elevation on Linux asks the CLIENT the person clicked from; the host runs the batch once with the password
 * on sudo's stdin and drops it. The most important property is the first: the password is never in an argv, an env, a log
 * line, an event or a result. Then: a wrong password asks again; no client is a refusal with a reason, never a hang; and
 * no shell ever reads an argument.
 */

const PW = 'Corr3ct-h0rse $(touch /tmp/x) `id` ; "q\'';
const batch = (over: Partial<ElevatedBatch> = {}): ElevatedBatch => ({
    title: 'Install git',
    items: ['git'],
    steps: [{ command: 'apt-get', args: ['update'] }, { command: 'apt-get', args: ['install', '-y', 'git'] }],
    ...over,
});

interface Call { command: string; args: readonly string[]; stdin: string; timeoutMs: number }

/** A fake sudo: accepts `right`, says what real sudo says otherwise, and records every call. */
function fakeSudo(opts: { right: string; stepExit?: (i: number) => number; notAllowed?: boolean }) {
    const calls: Call[] = [];
    let step = 0;
    const spawn: SudoSpawn = async (command, args, stdin, options) => {
        calls.push({ command, args: [...args], stdin, timeoutMs: options.timeoutMs });
        if (opts.notAllowed) return { exitCode: 1, stdout: '', stderr: 'genie is not in the sudoers file.\n' };
        if (stdin !== `${opts.right}\n`) return { exitCode: 1, stdout: '', stderr: 'Sorry, try again.\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n' };
        if (args.at(-1) === 'true') return { exitCode: 0, stdout: '', stderr: '' };
        const i = step++;
        return { exitCode: opts.stepExit?.(i) ?? 0, stdout: `step ${i} ok\n`, stderr: '' };
    };
    return { calls, spawn };
}

function asker(answers: PasswordAnswer[]) {
    const asked: PasswordQuestion[] = [];
    return { asked, ask: async (q: PasswordQuestion) => { asked.push(q); return answers.shift() ?? { refused: 'no more answers' }; } };
}

describe('the sudo argv: the password is never on it, and no shell reads an argument', () => {
    it('a step is sudo -S -k -p "" -- /bin/sh -c <a constant> genie-elevated <its words verbatim>', () => {
        expect(sudoStepArgs({ command: 'apt-get', args: ['install', '-y', 'git'] })).toEqual(['-S', '-k', '-p', '', '--', '/bin/sh', '-c', 'exec "$@" </dev/null', 'genie-elevated', 'apt-get', 'install', '-y', 'git']);
        expect(sudoCheckArgs()).toEqual(['-S', '-k', '-p', '', '--', 'true']);
    });

    it('HOSTILE words reach the program as single arguments, unchanged, and the shell text stays the constant', () => {
        const hostile = ['; rm -rf ~', '$(touch /tmp/pwned)', '`touch /tmp/pwned`', '&& reboot', '| sh', "'; id; '", '"$HOME"', '*', '-rf'];
        const args = sudoStepArgs({ command: 'pacman', args: ['-S', '--noconfirm', ...hostile] });
        expect(args.slice(0, 9)).toEqual(['-S', '-k', '-p', '', '--', '/bin/sh', '-c', STEP_WRAPPER, STEP_WRAPPER_NAME]);
        expect(args.slice(9)).toEqual(['pacman', '-S', '--noconfirm', ...hostile]);
        expect(batchRefusal(batch({ steps: [{ command: 'pacman', args: hostile }] }))).toBeNull();
    });

    it.skipIf(process.platform === 'win32')('the wrapper, run by a real /bin/sh, executes nothing it is given and gives the step an EMPTY stdin', () => {
        const dir = mkdtempSync(join(tmpdir(), 'elev973-'));
        try {
            const hostile = [`$(touch ${dir}/a)`, `\`touch ${dir}/b\``, `; touch ${dir}/c`, `&& touch ${dir}/d`, `| touch ${dir}/e`];
            const out = execFileSync('/bin/sh', ['-c', STEP_WRAPPER, STEP_WRAPPER_NAME, 'printf', '%s\\n', ...hostile], { encoding: 'utf8' });
            expect(out.split('\n').filter(Boolean)).toEqual(hostile);
            for (const f of ['a', 'b', 'c', 'd', 'e']) expect(existsSync(join(dir, f))).toBe(false);
            // A password line on the wrapper's stdin never reaches the step: `cat` reads nothing.
            const read = execFileSync('/bin/sh', ['-c', STEP_WRAPPER, STEP_WRAPPER_NAME, 'cat'], { encoding: 'utf8', input: `${PW}\n` });
            expect(read).toBe('');
            // CONTROL: without the wrapper the same cat does read it, so the empty read above is the wrapper's doing.
            expect(execFileSync('cat', [], { encoding: 'utf8', input: 'x\n' })).toBe('x\n');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('refuses before anything is asked: no steps, nothing named, an option as a program, a shell line as a program, a newline or NUL in an argument', () => {
        expect(batchRefusal(batch({ steps: [] }))).toMatch(/nothing to run/);
        expect(batchRefusal(batch({ items: [] }))).toMatch(/must name what it changes/);
        expect(batchRefusal(batch({ title: ' ' }))).toMatch(/must say what it is for/);
        expect(batchRefusal(batch({ steps: [{ command: '-u', args: ['root', 'id'] }] }))).toMatch(/not a program/);
        expect(batchRefusal(batch({ steps: [{ command: 'apt-get update && id', args: [] }] }))).toMatch(/not a program/);
        expect(batchRefusal(batch({ steps: [{ command: 'rm;id', args: [] }] }))).toMatch(/not a program/);
        expect(batchRefusal(batch({ steps: [{ command: 'apt-get', args: ['install', 'git\nid'] }] }))).toMatch(/not one Genie passes/);
        expect(batchRefusal(batch({ steps: [{ command: 'apt-get', args: ['a\0b'] }] }))).toMatch(/not one Genie passes/);
        expect(batchRefusal(batch({ steps: [{ command: '/usr/bin/systemctl', args: ['enable', '--now', 'docker.socket'] }] }))).toBeNull();
    });

    it('the prompt shows each step as its command line; display only', () => {
        expect(commandLine({ command: 'apt-get', args: ['install', '-y', 'git'] })).toBe('apt-get install -y git');
        expect(commandLine({ command: 'sh', args: ['-c', "a 'b'"] })).toBe(`sh -c 'a '\\''b'\\'''`);
    });

    it('sudo words, C locale: not allowed, not accepted, other', () => {
        expect(checkFailure('genie is not in the sudoers file.  This incident will be reported.')).toBe('not-allowed');
        expect(checkFailure('Sorry, user genie is not allowed to execute \'/usr/bin/true\' as root on vm.')).toBe('not-allowed');
        expect(checkFailure('Sorry, try again.\nsudo: 1 incorrect password attempt')).toBe('not-accepted');
        expect(checkFailure('sudo: no password was provided')).toBe('not-accepted');
        expect(checkFailure('sudo: unable to resolve host')).toBe('other');
        expect(passwordRefusal('')).toMatch(/empty/);
        expect(passwordRefusal('a\nb')).toMatch(/line break/);
        expect(passwordRefusal(null)).toMatch(/empty/);
        expect(passwordRefusal(PW)).toBeNull();
    });
});

describe('runElevatedWithPassword', () => {
    it('THE PASSWORD GOES ONLY TO SUDO\'S STDIN: never an argv, a log line or the result; checked once, then every step, in order', async () => {
        const sudo = fakeSudo({ right: PW });
        const a = asker([{ password: PW }]);
        const log: string[] = [];
        const r = await runElevatedWithPassword(batch(), { ask: a.ask, spawn: sudo.spawn, sudo: '/usr/bin/sudo', log: (l) => log.push(l) });
        expect(r).toEqual({ kind: 'ran', exitCode: 0, output: 'step 0 ok\n\nstep 1 ok\n', failedStep: null });
        expect(sudo.calls.map((c) => c.args.slice(9).join(' ') || c.args.at(-1))).toEqual(['true', 'apt-get update', 'apt-get install -y git']);
        for (const c of sudo.calls) {
            expect(c.command).toBe('/usr/bin/sudo');
            expect(c.stdin).toBe(`${PW}\n`);
            expect(JSON.stringify(c.args)).not.toContain(PW);
            expect(c.args.slice(0, 4)).toEqual(['-S', '-k', '-p', '']);
        }
        expect(JSON.stringify(r)).not.toContain(PW);
        expect(log.join('\n')).not.toContain(PW);
        expect(log.length).toBeGreaterThan(0); // CONTROL: there were log lines to look in
        // What the person was asked: the title, the exact packages, the commands, try 1.
        expect(a.asked).toEqual([{ title: 'Install git', items: ['git'], commands: ['apt-get update', 'apt-get install -y git'], attempt: 1, retry: null }]);
    });

    it('A WRONG PASSWORD ASKS AGAIN, saying so; no step runs until one is accepted', async () => {
        const sudo = fakeSudo({ right: PW });
        const a = asker([{ password: 'wrong-1' }, { password: PW }]);
        const r = await runElevatedWithPassword(batch(), { ask: a.ask, spawn: sudo.spawn, sudo: '/usr/bin/sudo' });
        expect(r).toMatchObject({ kind: 'ran', exitCode: 0 });
        expect(a.asked.map((q) => [q.attempt, q.retry])).toEqual([[1, null], [2, 'that password was not accepted']]);
        expect(sudo.calls.map((c) => c.args.at(-1))).toEqual(['true', 'true', 'update', 'git']);
        expect(sudo.calls[0]!.stdin).toBe('wrong-1\n');
    });

    it(`${MAX_PASSWORD_TRIES} wrong passwords: refused, and NOTHING ran`, async () => {
        const sudo = fakeSudo({ right: PW });
        const a = asker([{ password: 'w1' }, { password: 'w2' }, { password: 'w3' }, { password: PW }]);
        const r = await runElevatedWithPassword(batch(), { ask: a.ask, spawn: sudo.spawn, sudo: '/usr/bin/sudo' });
        expect(r).toEqual({ kind: 'refused', reason: `the password was not accepted ${MAX_PASSWORD_TRIES} times; nothing was run` });
        expect(sudo.calls.every((c) => c.args.at(-1) === 'true')).toBe(true);
        expect(a.asked).toHaveLength(MAX_PASSWORD_TRIES);
    });

    it('an account that may not use sudo is refused at once, never asked again', async () => {
        const sudo = fakeSudo({ right: PW, notAllowed: true });
        const a = asker([{ password: PW }, { password: PW }]);
        const r = await runElevatedWithPassword(batch(), { ask: a.ask, spawn: sudo.spawn, sudo: '/usr/bin/sudo' });
        expect(r).toMatchObject({ kind: 'refused', reason: expect.stringContaining('may not use sudo') });
        expect(a.asked).toHaveLength(1);
    });

    it('Cancel, or no client: refused with the asker\'s reason, and sudo is never started', async () => {
        const sudo = fakeSudo({ right: PW });
        const r = await runElevatedWithPassword(batch(), { ask: async () => ({ refused: NO_CLIENT }), spawn: sudo.spawn, sudo: '/usr/bin/sudo' });
        expect(r).toEqual({ kind: 'refused', reason: NO_CLIENT });
        expect(sudo.calls).toEqual([]);
    });

    it('no trustworthy sudo, or a batch that may not run: refused before anyone is asked', async () => {
        const a = asker([{ password: PW }]);
        const sudo = fakeSudo({ right: PW });
        expect(await runElevatedWithPassword(batch(), { ask: a.ask, spawn: sudo.spawn, sudo: null })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('sudo is not installed') });
        expect(await runElevatedWithPassword(batch({ steps: [] }), { ask: a.ask, spawn: sudo.spawn, sudo: '/usr/bin/sudo' })).toMatchObject({ kind: 'refused' });
        expect(a.asked).toEqual([]);
        expect(sudo.calls).toEqual([]);
    });

    it('a step that fails stops the batch: its index and exit code; the steps after it do not run', async () => {
        const sudo = fakeSudo({ right: PW, stepExit: (i) => (i === 0 ? 100 : 0) });
        const r = await runElevatedWithPassword(batch(), { ask: asker([{ password: PW }]).ask, spawn: sudo.spawn, sudo: '/usr/bin/sudo' });
        expect(r).toMatchObject({ kind: 'ran', exitCode: 100, failedStep: 0 });
        expect(sudo.calls).toHaveLength(2);
    });

    it('output that ever echoed the password is scrubbed', async () => {
        const spawn: SudoSpawn = async (_c, args, stdin) => ({ exitCode: 0, stdout: args.at(-1) === 'true' ? '' : `echo: ${stdin}`, stderr: '' });
        const r = await runElevatedWithPassword(batch({ steps: [{ command: 'cat', args: [] }] }), { ask: asker([{ password: PW }]).ask, spawn, sudo: '/usr/bin/sudo' });
        expect(r).toMatchObject({ kind: 'ran', output: 'echo: <password>\n' });
    });

    it('one prompt at a time: a second batch waits for the first', async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const run = serialized(async (b) => { order.push(`start ${b.title}`); if (b.title === 'one') await gate; order.push(`end ${b.title}`); return { kind: 'refused', reason: 'x' }; });
        const p1 = run(batch({ title: 'one' }));
        const p2 = run(batch({ title: 'two' }));
        await new Promise((r) => setTimeout(r, 10));
        expect(order).toEqual(['start one']);
        release();
        await Promise.all([p1, p2]);
        expect(order).toEqual(['start one', 'end one', 'start two', 'end two']);
    });
});

describe('ElevationBroker: the client that clicked, and only it', () => {
    const owner = { connectionId: 'conn_1', isOwner: true, readonly: false };
    const q: PasswordQuestion = { title: 'Install git', items: ['git'], commands: ['apt-get install -y git'], attempt: 1, retry: null };
    const make = (opts: { capable?: boolean; connected?: boolean } = {}) => {
        const sent: Array<[string, ElevationPromptEvent]> = [];
        const timers: Array<() => void> = [];
        const broker = new ElevationBroker({
            send: (id, e) => { if (opts.connected === false) return false; sent.push([id, e]); return true; },
            capable: () => opts.capable ?? true,
            newId: () => 'p1', now: () => 1000, timeoutMs: 300_000,
            schedule: (_ms, fn) => { timers.push(fn); return () => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); }; },
        });
        return { broker, sent, timers };
    };

    it('asks the clicking connection, carrying no secret; its answer for that prompt is the password; the prompt is closed after', async () => {
        const { broker, sent } = make();
        const answer = broker.ask(owner, q);
        expect(sent).toEqual([['conn_1', { kind: 'ask', id: 'p1', title: 'Install git', items: ['git'], commands: ['apt-get install -y git'], attempt: 1, retry: null, expiresAt: 301_000 }]]);
        expect(broker.answer('conn_2', 'p1', 'from-elsewhere')).toBe(false); // ANOTHER connection: ignored
        expect(broker.answer('conn_1', 'p9', PW)).toBe(false); // another prompt id: ignored
        expect(broker.answer('conn_1', 'p1', PW)).toBe(true);
        expect(await answer).toEqual({ password: PW });
        expect(sent.at(-1)).toEqual(['conn_1', { kind: 'close', id: 'p1' }]);
        expect(JSON.stringify(sent)).not.toContain(PW);
        expect(broker.answer('conn_1', 'p1', PW)).toBe(false); // once
        expect(broker.open).toBe(0);
    });

    it('NO CLIENT, or one that cannot show the prompt, or a guest: refused at once with a reason — never a hang', async () => {
        expect(await make().broker.ask(null, q)).toEqual({ refused: NO_CLIENT });
        expect(await make({ connected: false }).broker.ask(owner, q)).toEqual({ refused: NO_CLIENT });
        expect(await make({ capable: false }).broker.ask(owner, q)).toEqual({ refused: NOT_CAPABLE });
        expect(await make().broker.ask({ ...owner, isOwner: false }, q)).toMatchObject({ refused: expect.stringContaining('only this machine’s owner') });
        expect(await make().broker.ask({ ...owner, readonly: true }, q)).toMatchObject({ refused: expect.stringContaining('only this machine’s owner') });
    });

    it('Cancel, the connection leaving, or no answer in time: refused, and the prompt closed', async () => {
        const c = make();
        const p = c.broker.ask(owner, q);
        c.broker.answer('conn_1', 'p1', null);
        expect(await p).toEqual({ refused: 'you cancelled the password prompt; nothing was run' });

        const d = make();
        const p2 = d.broker.ask(owner, q);
        d.broker.dropConnection('conn_1');
        expect(await p2).toMatchObject({ refused: expect.stringContaining('closed') });

        const t = make();
        const p3 = t.broker.ask(owner, q);
        expect(t.timers).toHaveLength(1);
        t.timers[0]!();
        expect(await p3).toMatchObject({ refused: expect.stringContaining('nobody answered the password prompt within 5 minutes') });
        expect(t.sent.at(-1)).toEqual(['conn_1', { kind: 'close', id: 'p1' }]);
    });
});

describe('the real sudo and spawn', () => {
    it('only a root-owned setuid sudo in /usr/bin or /bin', () => {
        const file = (uid: number, mode: number) => ({ uid, mode, isFile: () => true });
        expect(realSudoPath((p) => (p === '/usr/bin/sudo' ? file(0, 0o104755) : null))).toBe('/usr/bin/sudo');
        expect(realSudoPath((p) => (p === '/bin/sudo' ? file(0, 0o104755) : null))).toBe('/bin/sudo');
        expect(realSudoPath((p) => (p === '/usr/bin/sudo' ? file(1000, 0o104755) : null))).toBeNull(); // not root's
        expect(realSudoPath((p) => (p === '/usr/bin/sudo' ? file(0, 0o100755) : null))).toBeNull(); // not setuid
        expect(realSudoPath(() => null)).toBeNull();
    });

    it.skipIf(process.platform === 'win32')('the spawn writes stdin to the pipe and closes it; no shell; LC_ALL=C', async () => {
        const r = await realSudoSpawn('/bin/sh', ['-c', 'cat; printf "|%s" "$LC_ALL"'], 'line\n', { timeoutMs: 10_000 });
        expect(r).toEqual({ exitCode: 0, stdout: 'line\n|C', stderr: '' });
        const missing = await realSudoSpawn('/no/such/sudo', [], 'secret-x\n', { timeoutMs: 10_000 });
        expect(missing.exitCode).toBe(-1);
        expect(JSON.stringify(missing)).not.toContain('secret-x');
    });
});


describe('Hosting on Linux (Tynn #973): the hosts file and the trust store through the same mechanism', () => {
    const trust: PrivilegedStep = { id: 'trust', label: 'install Genie’s certificate into the trust store', step: { command: '/opt/genie/caddy', args: ['trust', '--config', '/h/Caddyfile'], env: { XDG_DATA_HOME: '/h/data' } } };
    const hosts: PrivilegedStep = { id: 'hosts', label: 'update the hosts file', step: { command: '/bin/sh', args: ['-c', 'set -e; cat -- "$1" > "$2"', 'genie-hosts', '/tmp/h', '/etc/hosts', 'abc'] } };

    it('one batch, named by what each step does; env goes through `env K=V`, never a shell', () => {
        expect(privilegedBatch([trust, hosts])).toEqual({
            title: 'Set up Genie’s sites',
            items: ['install Genie’s certificate into the trust store', 'update the hosts file'],
            steps: [
                { command: 'env', args: ['XDG_DATA_HOME=/h/data', '/opt/genie/caddy', 'trust', '--config', '/h/Caddyfile'] },
                { command: '/bin/sh', args: ['-c', 'set -e; cat -- "$1" > "$2"', 'genie-hosts', '/tmp/h', '/etc/hosts', 'abc'] },
            ],
        });
        expect(batchRefusal(privilegedBatch([trust, hosts]))).toBeNull();
    });

    it('what the batch came to, as the hosting reads it: ok; the step that failed, by name; or nothing ran, with why', () => {
        expect(privilegedOutcome({ kind: 'ran', exitCode: 0, output: '', failedStep: null }, [trust, hosts])).toEqual({ ok: true });
        expect(privilegedOutcome({ kind: 'ran', exitCode: 3, output: 'genie: the prepared hosts file changed\n', failedStep: 1 }, [trust, hosts])).toEqual({ ok: false, failed: { id: 'hosts', label: 'update the hosts file' }, error: 'genie: the prepared hosts file changed' });
        expect(privilegedOutcome({ kind: 'ran', exitCode: 1, output: '', failedStep: 0 }, [trust, hosts])).toEqual({ ok: false, failed: { id: 'trust', label: 'install Genie’s certificate into the trust store' }, error: 'install Genie’s certificate into the trust store failed (exit 1)' });
        expect(privilegedOutcome({ kind: 'refused', reason: NO_CLIENT }, [trust])).toEqual({ ok: false, failed: null, error: NO_CLIENT });
    });
});
