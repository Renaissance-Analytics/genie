/**
 * A WINDOW-LIKE PARENT for host-spawn-fds.test.ts. It is started with a LISTENING socket on fd 3 that has no
 * close-on-exec flag — what Chromium's `--remote-debugging-port` socket is in Electron's main process. It spawns a host
 * exactly the way the product does (engine-launch.ts `spawnHostProcess`, its real options), waits until that host has run
 * its first module, prints `{hostPid, ready}`, then stays alive until the test writes `<dir>/go` (so the test can look at
 * BOTH processes while both live), and exits — the window gone, the host left running.
 *
 *   node --import tsx test/fixtures/fd-window.ts <hostScript> <dir>
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnHostProcess } from '../../src/main/engine-launch.js';

const [hostScript, dir] = process.argv.slice(2);
if (!hostScript || !dir) throw new Error('usage: fd-window.ts <hostScript> <dir>');
const ready = join(dir, 'host.ready');
const pid = await spawnHostProcess({
    execPath: process.execPath,
    hostScript,
    logsDir: join(dir, 'logs'),
    // The host fixtures are TypeScript: tsx through NODE_OPTIONS, since the product's spawn passes no execArgv.
    env: { ...process.env, NODE_OPTIONS: '--import tsx', FD_TEST_READY: ready },
    genieHome: dir,
    build: 'fd-test',
});
const wait = async (file: string) => { const end = Date.now() + 20_000; while (!existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); };
await wait(ready);
console.log(JSON.stringify({ hostPid: pid, ready: existsSync(ready) ? readFileSync(ready, 'utf8') : null }));
await wait(join(dir, 'go'));
process.exit(0);
