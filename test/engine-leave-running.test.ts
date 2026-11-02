import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * "JUST CLOSE THE UI" REACHES THE HOST (the host split, P1b). The window says `engine.leaveRunning` before it lets go of
 * the link: the host marks itself left running (its idle exit gives way, core/host-idle.ts) and is NOT shut down. A host
 * that cannot be left running refuses in words, and the window shuts nothing down because of it.
 */

const TOKEN = 'leave-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

async function rig(withLeave: boolean) {
    const calls: string[] = [];
    const server = new SessionEngineServer({
        token: TOKEN,
        build: 't',
        onShutdown: () => { calls.push('shutdown'); },
        ...(withLeave ? { onLeftRunning: () => { calls.push('left running'); } } : {}),
    });
    const host = new SessionHost({ userData: await mkdtemp(join(tmpdir(), 'leave-running-')), driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() });
    server.attach(host);
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide);
    const client = new SessionEngineClient();
    expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
    return { calls, client };
}

describe('engine.leaveRunning', () => {
    it('marks the host left running, and never shuts it down', async () => {
        const r = await rig(true);
        expect(await r.client.leaveRunning()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(r.calls).toEqual(['left running']);
    });

    it('a host without the option answers false (refused), and nothing is shut down', async () => {
        const r = await rig(false);
        expect(await r.client.leaveRunning()).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(r.calls).toEqual([]);
    });
});
