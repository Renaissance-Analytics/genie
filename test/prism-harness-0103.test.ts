import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as harness from '@particle-academy/prism-harness';

/*
 * prism-harness 0.10.3 (G-253, with 0.10.2's G-252). Genie was on 0.8.0:
 *  - a thread log over ~512 MB could not be counted or read at all (readFile cannot build the string: the owner's
 *    prism-slave thread is 1.03 GB);
 *  - 0.10.2 read its lock identity with a synchronous PowerShell on the caller's thread; 0.10.3 reads it asynchronously
 *    and offers warmLockIdentity() for a host to call at startup, off the hot path.
 */
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process') as typeof import('node:child_process');
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-harness-0103-')); });
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

describe('prism-harness locks without a synchronous spawn', () => {
    it('offers an async warm-up, and withLock spawns nothing synchronously on the calling thread', async () => {
        expect(typeof (harness as unknown as Record<string, unknown>)['warmLockIdentity']).toBe('function');
        expect(typeof (harness as unknown as Record<string, unknown>)['fileLockIdentityStatus']).toBe('function');
        const sync = [vi.spyOn(childProcess, 'spawnSync'), vi.spyOn(childProcess, 'execFileSync'), vi.spyOn(childProcess, 'execSync')];
        syncBuiltinESMExports();
        const store = new harness.FileSessionStore(dir);
        expect(await store.withLock('genie:agent:probe:thread', async () => 42)).toBe(42);
        expect(await store.withLock('genie:agent:probe:thread', async () => 43)).toBe(43);
        expect(sync.map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
    });
});

describe('a thread log over 512 MB, through the public SDK', () => {
    it('opens, counts and reads its whole history', async () => {
        const key = 'genie:agent:big:thread';
        const path = join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.jsonl`);
        const out = createWriteStream(path);
        const pad = 'z'.repeat(8 * 1024);
        let n = 0, bytes = 0;
        while (bytes < 540 * 1024 * 1024) {
            const line = `${JSON.stringify({ position: ++n, message: { kind: 'notice', level: 'info', message: pad }, run_id: null, recorded_at: '2026-11-08T00:00:00.000Z' })}\n`;
            bytes += line.length;
            if (!out.write(line)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
        await new Promise<void>((resolve) => out.end(() => resolve()));
        const store = new harness.FileSessionStore(dir);
        expect(await store.logLength(key)).toBe(n);
        expect(await new harness.Thread(store, key).count()).toBe(n);
        const log = await store.readLog(key);
        expect(log?.length).toBe(n);
        expect((log?.at(-1) as { position?: number } | undefined)?.position).toBe(n);
    }, 180_000);
});

describe('genie-host warms the lock identity at startup', () => {
    it('starts warmLockIdentity() early and awaits it before the session host takes any work', () => {
        // Comments stripped by line, so a mention in a comment proves nothing.
        const source = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(source).toMatch(/import \{[^}]*\bwarmLockIdentity\b[^}]*\} from '@particle-academy\/prism-harness'/);
        const started = source.indexOf('warmLockIdentity()');
        const host = source.indexOf('new SessionHost(');
        expect(started).toBeGreaterThan(-1);
        expect(host).toBeGreaterThan(started);
        // Awaited before the session host exists: the first thread write never pays for it.
        expect(source.slice(started, host)).toMatch(/await lockIdentity/);
    });
});
