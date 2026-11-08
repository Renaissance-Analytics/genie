/**
 * A SPAWN HOST THAT RUNS GIT (test/git-through-spawn-host.test.ts, Tynn #532): the real protocol server
 * (main/spawn-host-server.ts) over the real `execFile`, as main/spawn-host.ts serves genie-host's git; and its detached
 * starts (the Genie browser, test/browser-through-spawn-host.test.ts, Tynn #535).
 */
import { execFile } from 'node:child_process';
import { processChannel } from '../../src/main/spawn-host-protocol.js';
import { serveSpawnHost } from '../../src/main/spawn-host-server.js';
import { execInProcess, spawnDetachedProcess, streamInProcess } from '../../src/main/spawn-exec.js';

const channel = processChannel(process);
const served = serveSpawnHost(channel, {
    exec: execInProcess,
    stream: streamInProcess,
    pty: null,
    gitExec: (file, args, options, callback) => execFile(file, [...args], options, callback),
    spawnDetached: spawnDetachedProcess,
});
channel.onClose(() => { served.killAll(); process.exit(0); });
channel.onFrame((f) => { if (f.kind === 'call' && f.method === 'host.shutdown') setTimeout(() => process.exit(0), 50); });
