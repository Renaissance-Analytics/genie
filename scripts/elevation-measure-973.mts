#!/usr/bin/env -S npx tsx
/**
 * TYNN #973 — THE MECHANISM, MEASURED BOTH WAYS ON A TEST MACHINE (RULES: "a proposed fix is a hypothesis"). Not a unit
 * test: it changes sudo (a real password, NOPASSWD moved aside) and runs real sudo, so it refuses anywhere but a test VM
 * (user genie, or GENIE_TEST_MACHINE=1). It drives Genie's own runElevatedWithPassword + realSudoSpawn + realSudoPath,
 * the functions genie-host runs, with an asker standing in for the client.
 *
 *   npx tsx scripts/elevation-measure-973.mts        (ci-out/973-measure/ gets the evidence; the password never does)
 *
 * Every absence is read by a gauge first shown to find the same kind of thing (RULES: a gauge that reads 0 and 2 can read
 * ONE as nothing): a root sampler copies every process's argv and environment while the step runs, and a control process
 * with known markers in its argv and env must be found in those copies before "the password was not there" counts.
 *
 * Prints `MEASURE <check> PASS|FAIL <what was seen>`; exit 1 when any is not PASS. The password is never printed, and no
 * harness command carries it on an argv: it goes to sudo, grep and sh on stdin only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { runElevatedWithPassword, realSudoPath, realSudoSpawn, type PasswordQuestion } from '../src/main/linux-elevation.js';
import { ElevationBroker, NO_CLIENT } from '../src/main/elevation-broker.js';
import { sudoStepArgs } from '../src/core/elevation.js';

if (process.env.GENIE_TEST_MACHINE !== '1' && userInfo().username !== 'genie') {
    console.error('refusing: this changes sudo; test machines only');
    process.exit(2);
}
const USER = userInfo().username;
const NOPASSWD = '/etc/sudoers.d/10-genie-test';
const ASIDE = '/var/tmp/genie-973-10-genie-test';
const PERSON = '/etc/sudoers.d/20-genie-973-person';
const SAMPLES = '/var/tmp/genie-973-samples';
/** The sampler stops itself when this appears. */
const STOP = '/var/tmp/genie-973-samples.stop';
const OUT = join(process.cwd(), 'ci-out', '973-measure');
mkdirSync(OUT, { recursive: true });
const PW = `P${randomBytes(16).toString('hex')}7q`;
const WRONG = `w${randomBytes(8).toString('hex')}`;
const MARK_ARGV = `m973argv${randomBytes(6).toString('hex')}`;
const MARK_ENV = `m973env${randomBytes(6).toString('hex')}`;
const NL = String.fromCharCode(10);
const results: Array<{ check: string; ok: boolean }> = [];
const measure = (check: string, ok: boolean, words: string) => {
    const said = words.split(PW).join('<password>').replace(/\s+/g, ' ').trim().slice(0, 500);
    console.log(`MEASURE ${check} ${ok ? 'PASS' : 'FAIL'} ${said}`);
    results.push({ check, ok });
};
const run = (cmd: string, args: string[], input?: string) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...(input !== undefined ? { input } : {}) });
const lines = (text: string) => text.trim().split(NL).filter(Boolean);
const sudoN = (...args: string[]) => run('sudo', ['-n', ...args]).status === 0;
/**
 * sudo as a person runs it, the password on stdin, `extra` after it on the same stdin (the harness's own calls, never
 * Genie's path). -k on every one: none may leave a credential that a later check would read as Genie's.
 */
const sudoP = (args: string[], extra = '') => run('sudo', ['-S', '-k', '-p', '', ...args], `${PW}${NL}${extra}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let asideDone = false;
let personDone = false;
async function finish(): Promise<never> {
    writeFileSync(STOP, '');
    if (asideDone) sudoP(['mv', '-f', ASIDE, NOPASSWD]);
    if (personDone) sudoP(['rm', '-f', PERSON]);
    sudoN('rm', '-rf', SAMPLES, STOP, '/root/m973-ran-as-root');
    measure('z-sudo-restored', sudoN('true'), 'sudo -n answers again, as the image had it');
    const bad = results.filter((r) => !r.ok);
    console.log(`### elevation-measure=${bad.length === 0 ? 'PASS' : 'FAIL'} ${results.length} checks, ${bad.length} failing: ${bad.map((r) => r.check).join(' ')}`);
    process.exit(bad.length === 0 ? 0 : 1);
}

try {
    // 0. THE ROOT SAMPLER, started while NOPASSWD still holds: every process's argv and environment, every 100 ms, copied
    // into a root-only folder. It does not know the password; the copies are searched for it afterwards by root, the
    // password given on grep's stdin (-f -), so no file and no argv ever holds it.
    run('rm', ['-f', STOP]);
    const sampler = [
        `mkdir -m 0700 -p ${SAMPLES}`, 'i=0',
        `while [ ! -e ${STOP} ]; do i=$((i+1)); d=${SAMPLES}/$i; mkdir -p "$d"`,
        `for p in /proc/[0-9]*; do n=$(basename "$p"); tr '\\000' ' ' < "$p/cmdline" > "$d/$n.argv" 2>/dev/null; tr '\\000' '\\n' < "$p/environ" > "$d/$n.env" 2>/dev/null; done`,
        'sleep 0.1; done',
    ].join(NL);
    const s = spawn('sudo', ['-n', '/bin/sh', '-c', sampler], { stdio: 'ignore', detached: true });
    s.unref();
    await sleep(1500);
    const sweeps0 = Number(run('sudo', ['-n', 'sh', '-c', `ls ${SAMPLES} | wc -l`]).stdout.trim());
    measure('control-sampler-runs', sweeps0 > 0, `root sampler made ${sweeps0} sweeps in 1.5 s`);

    // 1. SUDO AS A PERSON HAS IT: a real password, NOPASSWD moved aside, a password-required grant.
    const chp = run('sudo', ['-n', 'chpasswd'], `${USER}:${PW}${NL}`);
    const grantDir = mkdtempSync(join(tmpdir(), 'm973-'));
    writeFileSync(join(grantDir, 'grant'), `${USER} ALL=(ALL:ALL) ALL${NL}`);
    personDone = true;
    const written = sudoN('install', '-m', '0440', '-o', 'root', '-g', 'root', join(grantDir, 'grant'), PERSON);
    const hadNopasswd = sudoN('test', '-e', NOPASSWD);
    asideDone = hadNopasswd && sudoP(['mv', '-f', NOPASSWD, ASIDE]).status === 0;
    const asks = !sudoN('true') && sudoP(['true']).status === 0;
    measure('control-sudo-asks-for-the-password', chp.status === 0 && written && asks, `chpasswd ${chp.status}; grant ${written}; NOPASSWD aside ${asideDone}; sudo -n refused and sudo -S with the password works: ${asks}`);
    if (!asks) await finish();

    // 2. THE CACHE GAUGE: a sudo WITHOUT -k leaves a credential that `sudo -n` then uses (control), and `sudo -k` drops it.
    run('sudo', ['-S', '-p', '', 'true'], `${PW}${NL}`);
    const cachedControl = sudoN('true');
    run('sudo', ['-k']);
    measure('control-cache-gauge', cachedControl && !sudoN('true'), `after a plain sudo -S, sudo -n answers: ${cachedControl}; after sudo -k it does not`);

    // 3. THE BATCH, as genie-host runs it: a wrong password first, which must ask again, then the right one.
    const sudo = realSudoPath();
    measure('sudo-path', sudo === '/usr/bin/sudo' || sudo === '/bin/sudo', `realSudoPath: ${sudo}`);
    const asked: PasswordQuestion[] = [];
    const answers = [WRONG, PW];
    // A control process carrying markers in its argv and env, alive while the batch runs: the sampler must see both.
    const control = spawn('sh', ['-c', 'sleep 8', MARK_ARGV], { env: { ...process.env, M973: MARK_ENV }, stdio: 'ignore' });
    const started = new Date(Date.now() - 5000).toISOString().replace('T', ' ').slice(0, 19);
    const hostile = ['$(touch /tmp/m973-pwned-a)', '`touch /tmp/m973-pwned-b`', '; touch /tmp/m973-pwned-c', '&& touch /tmp/m973-pwned-d'];
    const log: string[] = [];
    const result = await runElevatedWithPassword({
        title: 'Measure #973', items: ['a marker file in /root', 'hostile words, printed'],
        steps: [
            { command: 'sleep', args: ['3'] },
            { command: 'touch', args: ['/root/m973-ran-as-root'] },
            { command: 'printf', args: ['%s|', ...hostile] },
            // The step's stdin: empty, though sudo's stdin held the password line.
            { command: 'cat', args: [] },
        ],
    }, { sudo, spawn: realSudoSpawn, log: (l) => log.push(l), ask: async (q) => { asked.push(q); return { password: answers.shift() ?? PW }; } });
    // DROPPED AFTER THE STEP, read FIRST, before any harness sudo: no credential cached (the gauge above can see one).
    measure('no-credential-after', !sudoN('true'), 'sudo -n refused right after the batch: -k left no cached credential');
    control.kill();
    writeFileSync(join(OUT, 'host-log.txt'), `${log.join(NL)}${NL}`);
    writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
    measure('batch-ran', result.kind === 'ran' && result.exitCode === 0, JSON.stringify(result).slice(0, 300));
    measure('wrong-password-asks-again', asked.length === 2 && asked[0]!.retry === null && asked[1]!.retry === 'that password was not accepted' && asked[1]!.attempt === 2, `asked ${asked.length} times: ${asked.map((q) => `${q.attempt}:${q.retry}`).join(', ')}`);
    measure('ran-as-root', sudoP(['test', '-f', '/root/m973-ran-as-root']).status === 0, '/root/m973-ran-as-root exists (only root can write in /root)');
    const printed = result.kind === 'ran' ? result.output : '';
    const pwned = ['a', 'b', 'c', 'd'].filter((x) => run('test', ['-e', `/tmp/m973-pwned-${x}`]).status === 0);
    measure('hostile-words-inert', hostile.every((h) => printed.includes(`${h}|`)) && pwned.length === 0, `printed verbatim: ${hostile.every((h) => printed.includes(`${h}|`))}; files a shell would have made: ${pwned.join(',') || 'none'}`);
    measure('step-stdin-empty', result.kind === 'ran' && !printed.includes(PW) && !printed.includes(WRONG), 'cat, the last step, read nothing: neither password reached a step');
    measure('host-log-clean', !log.join(NL).includes(PW) && !log.join(NL).includes(WRONG) && log.length > 0, `${log.length} host log lines, none with either password`);

    // 4. THE PASSWORD WAS NOWHERE WHILE IT RAN: the sampler's copies, searched by root.
    writeFileSync(STOP, '');
    await sleep(2000);
    const search = (pattern: string) => lines(sudoP(['grep', '-rlF', '-f', '-', SAMPLES], `${pattern}${NL}`).stdout);
    const copies = sudoP(['sh', '-c', `ls ${SAMPLES} | wc -l`]).stdout.trim();
    const argvControl = search(MARK_ARGV).filter((l) => l.endsWith('.argv')).length;
    const envControl = search(MARK_ENV).filter((l) => l.endsWith('.env')).length;
    const stepSeen = search(`genie-elevated sleep 3`).filter((l) => l.endsWith('.argv')).length;
    measure('control-sampler-sees-argv-and-env', argvControl > 0 && envControl > 0 && stepSeen > 0, `${copies} sweeps; the control's argv marker in ${argvControl} copies, its env marker in ${envControl}; the elevated step's own argv (${sudoStepArgs({ command: 'sleep', args: ['3'] }).join(' ')}) in ${stepSeen}`);
    const pwHits = search(PW);
    const wrongHits = search(WRONG);
    measure('password-not-in-any-argv-or-env', pwHits.length === 0 && wrongHits.length === 0, `the right password in ${pwHits.length} copies, the wrong one in ${wrongHits.length} (every process's argv and environment, root's included)`);

    // 5. NOR IN THE JOURNAL, /var/log, /tmp or this run's evidence. The pattern reaches grep on fd 3, never an argv.
    const journal = sudoP(['sh', '-c', `exec 3<&0; journalctl --since '${started}' --no-pager -o cat | grep -cF -f /dev/fd/3 || true`], `${PW}${NL}`).stdout.trim();
    const journalWrong = sudoP(['sh', '-c', `exec 3<&0; journalctl --since '${started}' --no-pager -o cat | grep -cF -f /dev/fd/3 || true`], `${WRONG}${NL}`).stdout.trim();
    const journalControl = sudoP(['sh', '-c', `journalctl --since '${started}' --no-pager -o cat | grep -c 'COMMAND=' || true`]).stdout.trim();
    const logs = lines(sudoP(['grep', '-rlsF', '-f', '-', '/var/log', '/tmp', '/var/tmp', OUT], `${PW}${NL}`).stdout).filter((l) => !l.startsWith(SAMPLES));
    measure('password-not-in-journal-or-logs', journal === '0' && journalWrong === '0' && logs.length === 0 && Number(journalControl) > 0, `journal lines with the password: ${journal}, with the wrong one: ${journalWrong} (the journal does hold this run's sudo COMMAND lines: ${journalControl}); files under /var/log, /tmp, /var/tmp and the evidence holding it: ${logs.join(', ') || 'none'}`);

    // 6. Nothing elevated left running.
    const left = run('pgrep', ['-f', 'genie-elevated']).stdout.trim();
    measure('nothing-left-running', left === '', `elevated processes still running: ${left || 'none'}`);

    // 7. NO CLIENT: refused at once with a reason, sudo never started.
    const broker = new ElevationBroker({ send: () => false, capable: () => true });
    const t0 = Date.now();
    const noClient = await runElevatedWithPassword({ title: 'Measure', items: ['x'], steps: [{ command: 'true', args: [] }] }, { sudo, spawn: async () => { throw new Error('sudo must not start'); }, ask: broker.askerFor({ connectionId: 'conn_gone', isOwner: true, readonly: false }) });
    measure('no-client-refused', noClient.kind === 'refused' && noClient.reason === NO_CLIENT && Date.now() - t0 < 1000, `${JSON.stringify(noClient)} in ${Date.now() - t0} ms`);

    // 8. A NOPASSWD STEP: sudo then never reads stdin, so the password line would be the command's input. The control
    // shows that leak without the wrapper; with it, the step reads nothing. (A throwaway word, not the account's password.)
    const decoy = `decoy${randomBytes(6).toString('hex')}`;
    sudoP(['mv', '-f', ASIDE, NOPASSWD]);
    asideDone = false;
    const leak = run('sudo', ['-S', '-k', '-p', '', '--', 'cat'], `${decoy}${NL}`).stdout;
    const guarded = await realSudoSpawn(sudo!, sudoStepArgs({ command: 'cat', args: [] }), `${decoy}${NL}`, { timeoutMs: 20_000 });
    measure('nopasswd-step-stdin-guard', leak.includes(decoy) && !guarded.stdout.includes(decoy) && guarded.exitCode === 0, `without the wrapper cat printed the line: ${leak.includes(decoy)}; with it: ${guarded.stdout.includes(decoy)} (exit ${guarded.exitCode})`);
} catch (error) {
    measure('the-run-threw', false, error instanceof Error ? error.message : String(error));
}
await finish();
