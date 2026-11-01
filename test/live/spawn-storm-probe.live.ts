/**
 * WHICH PART OF A SITE START HOLDS MAIN (genie#1397). On a TEST VM only, never the owner's desktop:
 *
 *   npx tsx test/live/spawn-storm-probe.live.ts
 *
 * Fifty php-cgi FastCGI workers (ten PHP sites' worth) started from this process three ways, each gauged on its own by
 * main-block-gauge.ts and torn down before the next:
 *
 *   P1. plain child_process.spawn — no pty, no Genie code;
 *   P2. @particle-academy/fancy-pty `open` — one pty helper per process, as fancy-term-host spawns it;
 *   P3. fancy-term-host's in-process backend `create` — Genie's terminal engine, as the supervisor's PtyPort calls it.
 *
 * A measurement, not a pass/fail: it prints each way's worst main block, the worker/separate-process heartbeats beside it,
 * and main's stack in each block.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP_RECIPES, type PhpPlatform } from '../../src/core/php-versions.js';
import { httpFetch, installPhpVersion, nodePhpVersionsFs, phpVersionsRoot } from '../../src/main/php-versions.js';
import { execFileRunner } from '../../src/main/toolchain-runner.js';
import type { CommandRunner } from '../../src/main/toolchain-prober.js';
import { describeGauge, startMainBlockGauge } from './main-block-gauge.js';

const platform = process.platform as PhpPlatform;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COUNT = 50;
const PORT0 = 4600;

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-1397-'));
    const run: CommandRunner = (binary, args, options) => execFileRunner(binary, args, { timeoutMs: 45 * 60_000, ...(options?.env ? { env: options.env } : {}) });
    const version = PHP_RECIPES.find((r) => r.version === '8.4.27')?.version ?? PHP_RECIPES[0]!.version;
    const outcome = await installPhpVersion(version, true, {
        platform, root: phpVersionsRoot(join(base, 'toolchain')), fs: nodePhpVersionsFs(), run, fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, cpus: availableParallelism(),
        progress: () => {},
    } as Parameters<typeof installPhpVersion>[2]);
    if (outcome.kind !== 'installed') { console.log(`PHP did not install: ${JSON.stringify(outcome).slice(0, 300)}`); process.exit(1); }
    const cgi = join(outcome.dir, platform === 'win32' ? 'php-cgi.exe' : 'php-cgi');
    const env = { ...process.env, PHP_FCGI_MAX_REQUESTS: '0' } as Record<string, string>;
    // One launch first, so no way pays the first-ever launch of this binary alone.
    await run(cgi, ['-v']);
    const gauge = startMainBlockGauge();
    console.log(`\ngenie#1397 spawn probe — ${platform}, ${availableParallelism()} CPUs, ${COUNT} x ${cgi}\n`);

    const phase = async (label: string, start: (i: number) => () => void) => {
        const t0 = Date.now();
        const stops: Array<() => void> = [];
        for (let i = 0; i < COUNT; i += 1) stops.push(start(i));
        const syncMs = Date.now() - t0;
        await sleep(30_000);
        const r = await gauge.report(t0);
        console.log(`${label}: ${COUNT} starts held main ${syncMs} ms synchronously`);
        for (const line of describeGauge(r)) console.log(`    ${line}`);
        for (const stop of stops) { try { stop(); } catch { /* gone */ } }
        await sleep(8_000);
    };

    await phase('P1. child_process.spawn (no pty)', (i) => {
        const c: ChildProcess = spawn(cgi, ['-b', `127.0.0.1:${PORT0 + i}`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        c.stdout?.resume(); c.stderr?.resume(); c.on('error', () => {});
        return () => c.kill();
    });

    const req = createRequire(import.meta.url);
    const fancyPty = req('@particle-academy/fancy-pty') as { open(o: { argv: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }): { onData(f: (d: Buffer) => void): void; onError(f: (e: Error) => void): void; kill(): boolean } };
    await phase('P2. fancy-pty open (one helper each)', (i) => {
        const p = fancyPty.open({ argv: [cgi, '-b', `127.0.0.1:${PORT0 + 100 + i}`], cwd: base, env, cols: 80, rows: 24 });
        p.onData(() => {}); p.onError(() => {});
        return () => p.kill();
    });

    const { inProcessBackend } = await import('@particle-academy/fancy-term-host');
    const backend = inProcessBackend();
    backend.on('data', () => {});
    await phase("P3. fancy-term-host inProcessBackend.create (Genie's engine)", (i) => {
        const id = `probe-${i}`;
        backend.create({ id, cwd: base, shell: cgi, args: ['-b', `127.0.0.1:${PORT0 + 200 + i}`], env: { PHP_FCGI_MAX_REQUESTS: '0' } });
        return () => backend.kill(id);
    });
    gauge.stop();
}

main().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1); });
