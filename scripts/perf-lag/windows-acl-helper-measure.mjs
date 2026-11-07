#!/usr/bin/env node
/**
 * COULD ONE LONG-LIVED POWERSHELL RUN TODAY'S ACL WORK, WITH THE SAME VERIFICATION? Measured before anything is built. Run on genie-test-windows. It changes nothing in the product and writes
 * only to a temp folder of its own, and no secret goes through it: paths and a SID are all the script holds.
 *
 *   node scripts/perf-lag/windows-acl-helper-measure.mjs
 *
 * It takes the ACL script the product really generates, by running the product's own preparePrivateCredential with child_process wrapped, and sends that script's body, byte for byte, to a helper
 * started with the same flags. Only the wrapper differs: `exit 0` / `exit 1` would end the helper, so it reports the result instead.
 *
 *   baseline-one-shot       the product's write today, a launch each
 *   helper-cold-start       the one launch
 *   helper-acl              the same verification through the helper, several times, and the real ACL it leaves against what the one-shot leaves
 *   helper-refuses          a path that is not there: it says so, and the helper lives
 *   helper-handshake        today's handshake shape, including its reader's Dispose, twice in a row on one stdin. If Dispose closes stdin this fails, and the nonce handshake cannot move as it is
 *   helper-garbage          a line that is not a request
 *   owner-killed-idle       the owner dies with the helper idle: how long until it is gone
 *   owner-killed-busy       the owner dies with the helper mid-request: how long until it is gone. It sees stdin's EOF only when the request ends, so this says whether it needs a job object
 *
 * Prints `### acl-helper <step>=<ms>  detail`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32') { console.error('Windows only'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'acl-helper-'));
const say = (step, ms, detail = '') => console.log(`### acl-helper ${step}=${typeof ms === 'number' ? Math.round(ms) : ms}${detail ? `  ${detail}` : ''}`);
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden'];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
const sddl = (path) => spawnSync(POWERSHELL, [...FLAGS, '-Command', `(Get-Acl -LiteralPath '${path}').Sddl`], { encoding: 'utf8', windowsHide: true }).stdout.trim();

// The helper: one request a line, `<id> <base64 UTF-16 body>`, and `DONE <id> 0|1` back. stdin's end is the end of it.
const LOOP = `
$utf=[Text.UTF8Encoding]::new($false)
$in=[IO.StreamReader]::new([Console]::OpenStandardInput(),$utf)
$out=[Console]::OpenStandardOutput()
function Send-Line([string]$m){ $b=$utf.GetBytes($m+[Environment]::NewLine); $out.Write($b,0,$b.Length); $out.Flush() }
Send-Line 'READY'
while($null -ne ($line=$in.ReadLine())){
    $id,$body=$line -split ' ',2
    try {
        $s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($body))
        $ErrorActionPreference='Stop'
        & ([scriptblock]::Create($s)) | Out-Null
        Send-Line "DONE $id 0"
    } catch { Send-Line "DONE $id 1" }
}
exit 0
`;
function startHelper() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    const child = spawn(POWERSHELL, [...FLAGS, '-EncodedCommand', encoded(LOOP)], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    const waitFor = async (pattern, ms = 60_000) => {
        const began = performance.now();
        for (;;) {
            const m = pattern.exec(text);
            if (m) { text = text.slice(m.index + m[0].length); return m; }
            if (performance.now() - began > ms) throw new Error(`no ${pattern} within ${ms} ms; had ${JSON.stringify(text.slice(0, 200))}`);
            await sleep(2);
        }
    };
    let next = 0;
    const ask = async (body) => {
        const id = ++next;
        child.stdin.write(`${id} ${encoded(body)}\n`);
        const m = await waitFor(new RegExp(`DONE ${id} (\\d)`));
        return Number(m[1]);
    };
    return { child, ask, waitFor };
}

try {
    // The product's own script. Wrap child_process before the bundle binds it.
    const cp = require('node:child_process');
    const util = require('node:util');
    const scripts = [];
    const real = util.promisify(cp.execFile);
    const wrapped = (...args) => cp.__realExecFile(...args);
    wrapped[util.promisify.custom] = (file, args, options) => {
        const i = args.indexOf('-EncodedCommand');
        if (i >= 0) scripts.push(Buffer.from(args[i + 1], 'base64').toString('utf16le'));
        return real(file, args, options);
    };
    cp.__realExecFile = cp.execFile;
    cp.execFile = wrapped;
    syncBuiltinESMExports();
    const out = join(root, 'bundle.mjs');
    require('esbuild').buildSync({ stdin: { contents: "export { preparePrivateCredential, writePrivateCredential } from './src/main/private-credentials.ts';", resolveDir: join(here, '..', '..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
    const { preparePrivateCredential, writePrivateCredential } = await import(pathToFileURL(out).href);

    const folder = join(root, 'vault');
    const file = join(folder, 'agents.json');
    for (const n of [1, 2, 3]) {
        const began = performance.now();
        await writePrivateCredential(file, `{"n":${n}}`);
        say(`baseline-one-shot-${n}`, performance.now() - began);
    }
    const oneShotFolder = sddl(folder);
    const oneShotFile = sddl(file);
    console.log(`--- one-shot leaves  folder ${oneShotFolder}\n---                  file   ${oneShotFile}`);

    scripts.length = 0;
    await preparePrivateCredential(file);
    const captured = scripts[0];
    const WRAP = /^\$ErrorActionPreference='Stop'\ntry \{\n([\s\S]*)\nexit 0\n\} catch \{ exit 1 \}$/;
    const body = WRAP.exec(captured.split('\r\n').join('\n'))?.[1];
    if (!body) throw new Error(`the product's script is not in the shape this expects: ${captured.slice(0, 120)}`);
    say('product-script', body.length, 'characters, its body sent unchanged');

    const began = performance.now();
    const helper = startHelper();
    await helper.waitFor(/READY/);
    say('helper-cold-start', performance.now() - began, `pid ${helper.child.pid}`);
    for (const n of [1, 2, 3, 4, 5]) {
        const t = performance.now();
        const code = await helper.ask(body);
        say(`helper-acl-${n}`, performance.now() - t, `result ${code}`);
    }
    const helperFolder = sddl(folder);
    const helperFile = sddl(file);
    say('helper-acl-leaves-the-same-acl', helperFolder === oneShotFolder && helperFile === oneShotFile ? 'SAME' : 'DIFFERENT', helperFolder === oneShotFolder && helperFile === oneShotFile ? '' : `${helperFolder} ${helperFile}`);

    // A foreign grant must be removed through the helper too, or "same verification" is a claim and not a result.
    spawnSync('icacls', [file, '/grant', '*S-1-5-32-545:R', '/q'], { windowsHide: true });
    const dirty = sddl(file);
    const cleaned = await helper.ask(body);
    say('helper-removes-a-foreign-grant', sddl(file) === oneShotFile ? 'YES' : 'NO', `result ${cleaned}; had ${dirty.slice(-60)}`);

    const missing = body.split(Buffer.from(folder, 'utf16le').toString('base64')).join(Buffer.from(join(root, 'not-there'), 'utf16le').toString('base64'));
    say('helper-refuses', missing === body ? 'NOT-TESTED' : await helper.ask(missing), missing === body ? "the script's path form is not what this replaced" : 'must be 1');
    say('helper-lives-after-a-refusal', await helper.ask(body), 'must be 0');

    // The shape of today's handshake: a reader on stdin, read, then Dispose in a finally. Two in a row on one stdin.
    const HANDSHAKE = `$r=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true)); try { $l=$r.ReadLine(); if ($l -cne 'CHALLENGE') { throw 'bad' } } finally { $r.Dispose() }`;
    for (const n of [1, 2]) {
        const t = performance.now();
        const id = 1000 + n;
        helper.child.stdin.write(`${id} ${encoded(HANDSHAKE)}\n`);
        await sleep(300);
        helper.child.stdin.write('CHALLENGE\n');
        const m = await helper.waitFor(new RegExp(`DONE ${id} (\\d)`), 15_000).catch((e) => ({ 1: `no answer: ${e.message.slice(0, 80)}` }));
        say(`helper-handshake-${n}`, performance.now() - t, `result ${m[1]}`);
    }
    if (alive(helper.child.pid) && helper.child.exitCode === null) {
        helper.child.stdin.write('this is not a request\n');
        const m = await helper.waitFor(/DONE this (\d)/, 15_000).catch(() => null);
        say('helper-garbage', m ? m[1] : 'no answer', 'must be 1, or nothing, and the helper must live');
        say('helper-lives-after-garbage', await helper.ask(body), 'must be 0');
        const t = performance.now();
        helper.child.stdin.end();
        while (alive(helper.child.pid) && performance.now() - t < 30_000) await sleep(20);
        say('helper-ends-on-stdin-eof', performance.now() - t, alive(helper.child.pid) ? 'STILL ALIVE' : 'gone');
    } else say('helper-died-on-the-handshake', 'YES', 'Dispose closed its stdin, or it exited');

    // The owner killed outright, as a SIGKILL of the host would be.
    for (const [name, request] of [['owner-killed-idle', null], ['owner-killed-busy', 'Start-Sleep -Seconds 45']]) {
        const ownerFile = join(root, `owner-${name}.cjs`);
        writeFileSync(ownerFile, `
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(POWERSHELL)}, ${JSON.stringify([...FLAGS, '-EncodedCommand', encoded(LOOP)])}, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
child.stdout.once('data', () => {
    ${request ? `child.stdin.write('1 ${encoded(request)}\\n');` : ''}
    console.log(child.pid);
});
setInterval(() => {}, 1000);
`);
        const owner = spawn(process.execPath, [ownerFile], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
        let said = '';
        owner.stdout.on('data', (d) => { said += d; });
        const t0 = performance.now();
        while (!/\d+/.test(said) && performance.now() - t0 < 30_000) await sleep(20);
        const pid = Number(/\d+/.exec(said)?.[0]);
        await sleep(1_000);
        const held = alive(pid);
        owner.kill('SIGKILL');
        const t = performance.now();
        while (alive(pid) && performance.now() - t < 60_000) await sleep(50);
        say(name, performance.now() - t, `helper ${pid} ${held ? 'was running' : 'WAS NOT RUNNING'}; now ${alive(pid) ? 'STILL ALIVE' : 'gone'}`);
        if (alive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    }
    console.log('### acl-helper=PASS');
} catch (error) {
    console.log(`### acl-helper=FAIL  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
