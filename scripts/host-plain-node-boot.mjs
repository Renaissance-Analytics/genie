// GENIE-HOST ON PLAIN NODE (the host split, P10.1b): `node dist/main/host.js`, with no Electron anywhere, boots and serves.
//
// genie-cloud runs genie-host in a container that has Node 22 and no Electron (P10.3). This is that boot, in CI: a temp
// GENIE_HOME, idle exit off, and an install resources folder with no Caddy in it. It proves, against the real bundle:
//   1. host.json is written, naming this process, the engine protocol and the build it was given;
//   2. a hello with the WRONG token is refused (the control: the gauge can say no), and one with the token is welcomed;
//   3. what needs Electron says so: the Genie browser answers "not available on this host" and starts nothing (P10.1d),
//      the updater answers "Updates aren't available on this host" and launches no helper,
//      and Hosting says why the front door is off — there is no Caddy at <resources>/runtime/caddy;
//   4. GENIE_HOST_IDLE_MS=0 is never idle-exit: with nothing held and no window, the host is still there later (P10.1c);
//   5. SIGTERM is a clean shutdown: exit code 0, and the host's record removed.
// Run from the repo root after `npm run build:main`. Exits non-zero, saying which step, on the first failure.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUILD = 'ci-plain-node';
const home = mkdtempSync(join(tmpdir(), 'genie-plain-node-'));
const resources = join(home, 'resources-without-caddy');
mkdirSync(resources, { recursive: true });
const runtime = join(home, 'runtime');
const recordFile = join(runtime, 'host.json');
const tokenFile = join(runtime, 'host.token');

let output = '';
const fail = (step, why) => {
    console.error(`FAIL [${step}]: ${why}`);
    console.error('--- genie-host output ---');
    console.error(output);
    const log = join(runtime, 'lifecycle.log');
    if (existsSync(log)) { console.error('--- lifecycle.log ---'); console.error(readFileSync(log, 'utf8')); }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    process.exit(1);
};
const ok = (step, what) => console.log(`ok [${step}]: ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.versions.electron !== undefined) { console.error('this check must run on plain Node, not Electron'); process.exit(2); }
console.log(`node ${process.version}, GENIE_HOME=${home}`);

const env = { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: BUILD, GENIE_HOST_IDLE_MS: '0', GENIE_RESOURCES: resources };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, ['dist/main/host.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let exited = null;
const exit = new Promise((resolve) => child.on('exit', (code, signal) => { exited = { code, signal }; resolve(exited); }));
child.stdout.on('data', (d) => { output += d; process.stdout.write(`[host] ${d}`); });
child.stderr.on('data', (d) => { output += d; process.stdout.write(`[host:err] ${d}`); });

// 1. host.json
let record = null;
for (let waited = 0; waited < 90_000 && record === null; waited += 250) {
    if (exited) fail('boot', `genie-host exited before it wrote host.json (code ${exited.code}, signal ${exited.signal})`);
    try { record = JSON.parse(readFileSync(recordFile, 'utf8')); } catch { await sleep(250); }
}
if (record === null) fail('boot', 'no host.json after 90 s');
if (record.pid !== child.pid) fail('record', `host.json names pid ${record.pid}, the host is ${child.pid}`);
if (record.build !== BUILD) fail('record', `host.json says build ${JSON.stringify(record.build)}, not ${BUILD}`);
if (!Number.isInteger(record.protocol)) fail('record', `host.json has no protocol: ${JSON.stringify(record)}`);
ok('record', `host.json ${JSON.stringify(record)}`);
const token = readFileSync(tokenFile, 'utf8').trim();

/** One connection to the host's endpoint: send frames, wait for the frame that matches. */
function link() {
    const socket = connect(record.endpoint);
    socket.setEncoding('utf8');
    const frames = [];
    const waiters = [];
    let buffer = '';
    let closed = false;
    socket.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.length === 0) continue;
            frames.push(JSON.parse(line));
            for (const w of [...waiters]) w();
        }
    });
    socket.on('close', () => { closed = true; for (const w of [...waiters]) w(); });
    socket.on('error', () => {});
    const until = (match, what, ms = 30_000) => new Promise((resolve, reject) => {
        const check = () => {
            const found = frames.find(match);
            if (found) { waiters.splice(waiters.indexOf(check), 1); clearTimeout(timer); resolve(found); return; }
            if (closed) { waiters.splice(waiters.indexOf(check), 1); clearTimeout(timer); reject(new Error(`the connection closed before ${what}`)); }
        };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error(`no ${what} in ${ms} ms; frames: ${frames.map((f) => f.kind + (f.channel ? ':' + f.channel : '')).join(', ')}`)); }, ms);
        waiters.push(check);
        check();
    });
    return { send: (frame) => socket.write(`${JSON.stringify(frame)}\n`), until, frames, end: () => socket.end() };
}

// 2. the token: refused without it (control), welcomed with it
const stranger = link();
stranger.send({ kind: 'hello', auth: { kind: 'token', token: 'not-the-token' } });
const refused = await stranger.until((f) => f.kind === 'refused' || f.kind === 'welcome', 'an answer to a wrong token').catch((e) => fail('wrong token', e.message));
if (refused.kind !== 'refused') fail('wrong token', `a wrong token was answered ${JSON.stringify(refused)}`);
ok('wrong token', `refused: ${refused.reason}`);

const win = link();
win.send({ kind: 'hello', auth: { kind: 'token', token } });
const welcome = await win.until((f) => f.kind === 'welcome' || f.kind === 'refused', 'a welcome').catch((e) => fail('hello', e.message));
if (welcome.kind !== 'welcome') fail('hello', `the token was answered ${JSON.stringify(welcome)}`);
if (welcome.protocol !== record.protocol || welcome.build !== BUILD || welcome.pid !== child.pid) fail('hello', `the welcome does not match host.json: ${JSON.stringify(welcome)}`);
ok('hello', `welcome ${JSON.stringify(welcome)}`);

// 3a. the Genie browser: not on this host, and nothing started
win.send({ kind: 'call', id: 1, method: 'engine.browser', args: ['open', ['https://moic.gen/', 'background']] });
const opened = await win.until((f) => f.kind === 'result' && f.id === 1, 'an answer to engine.browser open').catch((e) => fail('browser', e.message));
if (opened.ok !== false || !/not available on this host/.test(String(opened.reason))) fail('browser', `engine.browser open answered ${JSON.stringify(opened)}; expected a refusal saying it is not available on this host`);
ok('browser', `refused: ${opened.reason}`);

// 3b. the updater: not on this host, and no `--updater` helper launched (a launched one would log "updater: starting")
win.send({ kind: 'call', id: 2, method: 'engine.updates', args: ['check', []] });
const checked = await win.until((f) => f.kind === 'result' && f.id === 2, 'an answer to engine.updates check').catch((e) => fail('updates', e.message));
if (checked.ok !== false || !/Updates aren't available on this host/.test(String(checked.reason))) fail('updates', `engine.updates check answered ${JSON.stringify(checked)}; expected "Updates aren't available on this host"`);
if (/updater: starting/.test(output)) fail('updates', 'a --updater helper was launched');
ok('updates', `refused: ${checked.reason}`);

// 3c. Hosting says why there is no front door
const hosting = await win.until((f) => f.kind === 'event' && f.channel === 'hosting.dump', 'the hosting dump').catch((e) => fail('caddy', e.message));
const door = hosting.payload?.externalFrontDoor;
if (!door || door.running !== false || !String(door.reason).includes(join(resources, 'runtime', 'caddy'))) fail('caddy', `Hosting's front door says ${JSON.stringify(door)}; expected off, naming ${join(resources, 'runtime', 'caddy')}`);
ok('caddy', `front door off: ${door.reason}`);

// 4. idle exit off: the window goes, nothing is held, and the host stays
win.end();
stranger.end();
await sleep(8_000);
if (exited) fail('idle', `with GENIE_HOST_IDLE_MS=0 the host exited by itself (code ${exited.code}, signal ${exited.signal})`);
ok('idle', 'still running 8 s after the last window left, with nothing held');

// 5. a clean shutdown
child.kill('SIGTERM');
const result = await Promise.race([exit, sleep(30_000).then(() => null)]);
if (result === null) fail('shutdown', 'SIGTERM: still running after 30 s');
if (result.code !== 0) fail('shutdown', `SIGTERM: exit code ${result.code}, signal ${result.signal}`);
if (existsSync(recordFile)) fail('shutdown', 'host.json is still there after a clean shutdown');
ok('shutdown', 'SIGTERM: exit code 0, host.json removed');
console.log('genie-host serves on plain Node');
