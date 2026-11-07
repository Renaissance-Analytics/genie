import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { SafeMode } from '../src/main/safe-mode-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * SAFE MODE IS GENIE-HOST'S, AND EVERY WINDOW READS IT (spec §2; Tynn #386). The state is opened once by the host at its
 * boot; each window that connects is told it BEFORE ready (so its own boot restore can hold), told again when it changes,
 * and "Leave safe mode" from any window is the host's leave.
 */

const TOKEN = 'safe-mode-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tick = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function rig(unclean: boolean) {
    const runtime = mkdtempSync(join(tmpdir(), 'safe-engine-'));
    dirs.push(runtime);
    const before = SafeMode.open(runtime, { now: () => 1_000, pid: 1 });
    before.beat(['agent_a']);
    if (!unclean) before.writeCleanExit('a window asked');
    const mode = SafeMode.open(runtime, { now: () => 2_000, pid: 2 });
    const server = new SessionEngineServer({ token: TOKEN, build: 't', safeMode: mode });
    server.attach(new SessionHost({ userData: runtime, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const window = async (local = true) => {
        const [h, raw] = memoryPair();
        server.accept(h, { local });
        const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
        const client = new SessionEngineClient({});
        expect(await client.connect(t, TOKEN)).toMatchObject({ ok: true });
        return client;
    };
    return { mode, window };
}

describe('safe mode over the engine link', () => {
    it('every window — local or not — knows it at connect, and Leave from one is the host’s, told to all', async () => {
        const r = rig(true);
        const local = await r.window(true);
        const remote = await r.window(false);
        expect(local.safeModeView()).toMatchObject({ active: true, at: 1_000, agents: ['agent_a'] });
        expect(remote.safeModeView()).toMatchObject({ active: true });
        const changes: boolean[] = [];
        remote.onSafeMode((v) => changes.push(v.active));
        expect(await local.leaveSafeMode()).toEqual({ ok: true });
        await tick();
        expect(r.mode.active()).toBe(false);
        expect(local.safeModeView()?.active).toBe(false);
        expect(changes).toEqual([false]);
    });

    it('CONTROL: after a clean end every window reads it off', async () => {
        const r = rig(false);
        const local = await r.window(true);
        expect(local.safeModeView()).toMatchObject({ active: false });
    });
});
