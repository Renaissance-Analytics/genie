/**
 * A WINDOW-LIKE PARENT for host-pty-fds.test.ts, run on ELECTRON'S binary as Node (the product's runtime: the window is
 * Electron, genie-host runs on Electron's binary). It is started with a LISTENING socket on fd 3 that has no close-on-exec
 * flag — what Chromium's `--remote-debugging-port` socket is in Electron's main process. It starts the REAL genie-host the
 * product's way (engine-launch.ts `spawnHostProcess`, its real options), waits for the host's `runtime/host.json`, prints
 * `{hostPid}`, then stays alive until the test writes `<home>/go`, and exits.
 *
 *   ELECTRON_RUN_AS_NODE=1 electron --import tsx test/fixtures/pty-window.ts <home>
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnHostProcess } from '../../src/main/engine-launch.js';

const [home] = process.argv.slice(2);
if (!home) throw new Error('usage: pty-window.ts <home>');
const hostPid = spawnHostProcess({
    execPath: process.execPath,
    hostScript: resolve('src/main/genie-host.ts'),
    logsDir: join(home, 'logs'),
    // genie-host is TypeScript here: tsx through NODE_OPTIONS, since the product's spawn passes no execArgv.
    env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    genieHome: home,
    build: 'pty-fds-test',
});
const wait = async (ready: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ready() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); };
const record = join(home, 'runtime', 'host.json');
await wait(() => existsSync(record) && readFileSync(record, 'utf8').includes(`"pid":${hostPid}`), 120_000);
console.log(JSON.stringify({ hostPid, hostRecord: existsSync(record) ? readFileSync(record, 'utf8') : null }));
await wait(() => existsSync(join(home, 'go')), 170_000);
process.exit(0);
