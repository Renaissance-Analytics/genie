import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import type { FilesWant } from '../src/main/files-watch-hub.js';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
it('the actual main adapter keeps offline views for engine replay, removes canceled views, and survives another engine reconnect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie-7d-engine-'));
    const registrations = new Map<string, { owner: string; workspace: { id: string; path: string }; want: unknown }>();
    const server = new SessionEngineServer({ token: 'synthetic-7d-engine', build: 'fixture', files: {
        subscribe: (owner, id, workspace, want) => { registrations.set(id, { owner, workspace, want }); },
        unsubscribe: (_owner, id) => { registrations.delete(id); },
        dropOwner: owner => { for (const [id, view] of registrations) if (view.owner === owner) registrations.delete(id); },
    } });
    const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: pids => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() }); server.attach(host);
    const engine = new SessionEngineClient();
    // Execute the real main.ts watch adapter, not a test copy of its offline policy.
    const main = readFileSync('src/main/main.ts', 'utf8').split('link.onFilesEvent(onFilesEvent);')[1]!;
    const expression = main.match(/watch:\s*([^\r\n]+),\r?\n\s*unwatch:/)?.[1]; expect(expression).toBeTruthy();
    const watch = new Function('link', `return (${expression});`)(engine) as (id: string, workspace: { id: string; path: string }, want: FilesWant) => boolean | Promise<boolean>;
    const f = await resourceDoor(cleanups, {}, { filesWatch: {
        exists: (id: string) => id === 'work', watch: (id: string, workspaceId: string, want: FilesWant) => watch(id, { id: workspaceId, path: dir }, want),
        unwatch: (id: string) => { void engine.filesUnwatch(id); }, subscribe: (listener: Parameters<SessionEngineClient['onFilesEvent']>[0]) => engine.onFilesEvent(listener),
    } });
    const wires: ReturnType<typeof memoryPair>[number][] = [];
    cleanups.push(async () => { for (const wire of wires) wire.close(); engine.disconnect(); await tick(); await rm(dir, { recursive: true, force: true }); });
    const client = await f.client(), seen = vi.fn();
    const off = client.bridge.files.subscribe!('work', { git: true }, seen), canceled = client.bridge.files.subscribe!('work', {}, () => {}); canceled(); await tick(); await tick();
    const connect = async () => { const [hostSide, windowSide] = memoryPair(); wires.push(windowSide); server.accept(hostSide); expect(await engine.connect(windowSide, 'synthetic-7d-engine')).toMatchObject({ ok: true }); await tick(); await tick(); return windowSide; };
    const first = await connect();
    expect(registrations.size).toBe(1); expect([...registrations.values()][0]).toMatchObject({ workspace: { id: 'work', path: dir }, want: { git: true } });
    const emit = async (path: string) => { const view = [...registrations.values()][0]!; server.filesEvent(view.owner, { kind: 'changed', workspaceId: 'work', changes: [{ path, at: 1 }] }); await tick(); await tick(); };
    await emit('first.txt'); expect(seen).toHaveBeenCalledExactlyOnceWith({ paths: ['first.txt'] }); expect(client.state().lastRefusal).toBeNull();
    first.close(); await tick(); expect(registrations.size).toBe(0); const second = await connect(); expect(registrations.size).toBe(1);
    await emit('reconnected.txt'); expect(seen).toHaveBeenLastCalledWith({ paths: ['reconnected.txt'] }); expect(seen).toHaveBeenCalledTimes(2);
    off(); await tick(); expect(registrations.size).toBe(0); second.close(); await connect(); expect(registrations.size).toBe(0);
});
