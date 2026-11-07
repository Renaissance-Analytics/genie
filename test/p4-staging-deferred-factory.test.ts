import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalStagingArea } from '../src/main/local-staging-area.js';
import type { LocalUploads } from '../src/main/local-uploads.js';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function factoryContract() {
    // Fail immediately on the missing awaitable port; do not put a Promise into the old synchronous registry slot.
    expect(readFileSync('src/main/remote-host.ts', 'utf8')).toMatch(/createLocalUploads\?:\s*\(\)\s*=>\s*LocalUploads\s*\|\s*Promise<LocalUploads>/);
}
async function registryFixture(): Promise<LocalUploads> {
    const home = await mkdtemp(join(tmpdir(), 'genie-lazy-upload-')), area = await LocalStagingArea.open(home), registry = area.createConnection();
    cleanups.push(async () => { await registry.dispose(); await rm(home, { recursive: true, force: true }); }); return registry;
}
it('two first-use calls await one connection-owned factory and then create distinct verified stages', async () => {
    factoryContract(); const registry = await registryFixture(); let release!: (uploads: LocalUploads) => void, entered!: () => void;
    const gate = new Promise<LocalUploads>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const factory = vi.fn(() => { entered(); return gate; }), door = await resourceDoor(cleanups, { createLocalUploads: factory }), c = await door.client();
    const opening = Promise.all([c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 }), c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 })])
        .then(values => ({ ok: true as const, values }), error => ({ ok: false as const, error }));
    await started; expect(factory).toHaveBeenCalledOnce(); release(registry);
    const outcome = await opening; expect(outcome.ok).toBe(true); if (!outcome.ok) throw outcome.error;
    expect(outcome.values[0]!.id).not.toBe(outcome.values[1]!.id); expect(factory).toHaveBeenCalledOnce();
    for (const stage of outcome.values) expect(await c.uploads!.abort(stage.id)).toEqual({ aborted: true });
});
it('disconnect during first-use preparation disposes a late registry before it creates any stage files', async () => {
    factoryContract(); const registry = await registryFixture(), dispose = vi.spyOn(registry, 'dispose');
    let release!: (uploads: LocalUploads) => void, entered!: () => void;
    const gate = new Promise<LocalUploads>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const door = await resourceDoor(cleanups, { createLocalUploads: () => { entered(); return gate; } }), c = await door.client();
    const opening = c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await started; c.close(); await tick(); release(registry); await tick(); await tick();
    const outcome = await opening; expect(outcome.ok).toBe(false); if (outcome.ok) throw new Error('closed client unexpectedly staged bytes');
    expect(String(outcome.error)).toMatch(/connection|closed/i); expect(dispose).toHaveBeenCalledOnce();
    await expect(stat(registry.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
