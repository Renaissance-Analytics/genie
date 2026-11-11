/**
 * A STAND-IN FOR genie-host (test/browser-through-spawn-host.test.ts, Tynn #535): it forks a real spawn host, asks it to
 * start a detached process, prints that process's pid, and waits to be killed. The test kills THIS process: its spawn host
 * goes with it (on Windows, libuv's kill-on-close job), and the detached process must not.
 */
import { fileURLToPath } from 'node:url';
import { startSpawnHost } from '../../src/main/spawn-host-client.js';

const fixture = fileURLToPath(new URL('./git-spawn-host.ts', import.meta.url));
const client = startSpawnHost({ entry: fixture, execArgv: ['--import', 'tsx'] });
const [log, script] = process.argv.slice(2) as [string, string];
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
const pid = await client.spawnDetached(process.execPath, ['-e', script], env, log, true);
process.stdout.write(`STARTED ${pid ?? 0} SPAWNHOST ${client.pid ?? 0}\n`);
setInterval(() => {}, 1000);
