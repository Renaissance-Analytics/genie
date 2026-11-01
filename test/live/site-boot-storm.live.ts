/**
 * TEN PHP SITES STARTED AT ONCE, FOR REAL, ON A TEST VM (genie#1393). Never on the owner's desktop.
 *
 *   Windows (genie-test-windows):  npx tsx scripts/fetch-caddy.ts; npx tsx test/live/site-boot-storm.live.ts
 *
 * After a Genie restart on the owner's machine every hosted site read red "failed" and was unrouted, while each answered
 * on its port in under a second: about ten PHP sites (Caddy + 4 php-cgi workers each) started in the same instant, missed
 * the one 15 s readiness probe, and nothing asked again. This drives Genie's REAL composition (real pty engine, the
 * pinned Caddy, PHP installed through Genie's own installer, the real readiness probe `siteAnswers`) through that boot:
 *
 *   A. MEASUREMENT (does starting everything at once matter?): one site alone, then ten at once. Each site's first answer
 *      is timed by this harness directly on its port, independent of Genie's own view.
 *   B. THE BUG: ten sites at once whose app is still warming up for 25 s (each request waits until the app is 25 s old,
 *      the way a cold framework boot under load does). Past 60 s every port answers (positive control, measured here),
 *      and Genie must read each one running AND route it. On a tree without the fix they stay failed and unrouted.
 *
 * Exits 1 on any FAIL.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { availableParallelism, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PHP_RECIPES, type PhpPlatform } from '../../src/core/php-versions.js';
import { httpFetch, installPhpVersion, nodePhpVersionsFs, phpVersionsRoot } from '../../src/main/php-versions.js';
import { execFileRunner } from '../../src/main/toolchain-runner.js';
import type { CommandRunner } from '../../src/main/toolchain-prober.js';
import { composeServices } from '../../src/main/compose.js';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { siteAnswers } from '../../src/main/port-probe.js';

const platform = process.platform as PhpPlatform;
const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One GET straight at the site's own port (Caddy), as the harness sees it: the status, or 0. */
const get = (port: number) => new Promise<number>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: 60_000, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
});

/** The app: answers once it is `coldMs` old (its birth stamped by the harness just before Genie starts it). */
const appPhp = (coldMs: number) => `<?php
$born = (float) @file_get_contents(__DIR__ . '/../born.txt');
$left = $born + ${coldMs / 1000} - microtime(true);
if ($left > 0) usleep((int) ($left * 1e6));
echo 'ok ' . getmypid();
`;

async function main(): Promise<void> {
    const t00 = Date.now();
    const caddyBin = join(process.cwd(), 'build', 'runtime', platform === 'win32' ? 'caddy.exe' : 'caddy');
    check(existsSync(caddyBin), '0. CONTROL: Genie’s pinned Caddy is here', caddyBin);

    // PHP through Genie's own installer (the binary every managed site runs), on PATH as `php-cgi` for this run.
    const base = mkdtempSync(join(tmpdir(), 'genie-1393-'));
    const run: CommandRunner = (binary, args, options) => execFileRunner(binary, args, { timeoutMs: 45 * 60_000, ...(options?.env ? { env: options.env } : {}) });
    // 8.4.27 (fancy's, and genie#1334's live test): 8.5.12 does not install on Windows yet (genie#1394).
    const version = PHP_RECIPES.find((r) => r.version === '8.4.27')?.version ?? PHP_RECIPES[0]!.version;
    const outcome = await installPhpVersion(version, true, {
        platform, root: phpVersionsRoot(join(base, 'toolchain')), fs: nodePhpVersionsFs(), run, fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, cpus: availableParallelism(),
        progress: () => {},
    } as Parameters<typeof installPhpVersion>[2]);
    check(outcome.kind === 'installed', `0b. CONTROL: PHP ${version} installs through Genie's installer`, outcome.kind === 'installed' ? outcome.dir : JSON.stringify(outcome).slice(0, 300));
    if (outcome.kind !== 'installed') return;
    process.env['PATH'] = `${outcome.dir}${delimiter}${process.env['PATH'] ?? ''}`;

    const userData = join(base, 'home');
    const ws = join(base, 'acme');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'acme', repos: [] }, null, 2)}\n`);
    const encryptor = { isAvailable: () => true, encrypt: (b: Buffer) => b, decrypt: (b: Buffer) => b };
    const composed = await composeServices({
        userData, pty: realFancyTermPort(userData, encryptor as never), v1Settings: () => null, caddyBin, frontDoorPort: 0,
        docker: async () => ({ stdout: '', exitCode: 0 }), portFree: async () => true,
        workspaces: () => [{ id: 'acme', path: ws }],
        // THE REAL PROBE, as main.ts wires it.
        siteProbe: (port, options) => siteAnswers(port, options),
    });

    const makeApp = (name: string, coldMs: number) => {
        const dir = join(ws, name);
        mkdirSync(join(dir, 'public'), { recursive: true });
        writeFileSync(join(dir, 'public', 'index.php'), appPhp(coldMs));
        return dir;
    };
    /** Start these sites at the same instant; time each one's first answer on its port, as the harness sees it. */
    const storm = async (names: string[], coldMs: number) => {
        const dirs = names.map((n) => makeApp(n, coldMs));
        const born = (Date.now() / 1000).toFixed(3);
        for (const d of dirs) writeFileSync(join(d, 'born.txt'), born);
        // WHERE THE TIME GOES: how long the starts hold Node's event loop (Genie's main thread, where the in-process pty
        // engine spawns each process), and the worst stall the loop saw while the sites came up.
        let worstLag = 0;
        let tick = Date.now();
        const lagTimer = setInterval(() => { const n = Date.now(); worstLag = Math.max(worstLag, n - tick - 100); tick = n; }, 100);
        const t0 = Date.now();
        const ids = names.map((n, i) => composed.sites.create({ name: n, workspaceId: 'acme', repoPath: dirs[i]!, serve: { mode: 'php', root: 'public' } }).id);
        // What Genie says just past its first 15 s window: slow is 'starting/slow', never 'failed' (with the fix).
        const createMs = Date.now() - t0;
        const at18 = sleep(18_000).then(() => states(ids));
        const firstAnswer = await Promise.all(ids.map(async (id) => {
            const port = composed.sites.get(id)!.port!;
            const deadline = t0 + 120_000;
            while (Date.now() < deadline) {
                const status = await get(port);
                if (status === 200) return Date.now() - t0;
                await sleep(250);
            }
            return null;
        }));
        clearInterval(lagTimer);
        console.log(`    starting ${names.length} site(s) held the event loop ${createMs} ms (synchronously, in create); worst event-loop stall while they came up: ${worstLag} ms`);
        return { ids, t0, firstAnswer, at18: await at18 };
    };
    const states = (ids: string[]) => ids.map((id) => { const s = composed.sites.get(id)!; return `${s.host.replace(/\.gen$/, '')}=${s.state}${s.step ? `/${s.step}` : ''}`; }).join(' ');
    const routed = (ids: string[]) => { const hosts = new Set(composed.sites.routes().map((r) => r.host)); return ids.filter((id) => hosts.has(composed.sites.get(id)!.host)).length; };
    const removeAll = async (ids: string[]) => { for (const id of ids) composed.sites.remove(id); await sleep(3_000); };

    try {
        console.log(`\ngenie#1393 live — ${platform}, ${availableParallelism()} CPUs, PHP ${version}, Caddy ${caddyBin}\n`);

        console.log('A. MEASUREMENT: one site alone, then ten at once (no artificial delay)');
        const alone = await storm(['solo'], 0);
        await sleep(20_000);
        console.log(`    alone: first answer after ${alone.firstAnswer[0]} ms; Genie: ${states(alone.ids)}`);
        check(alone.firstAnswer[0] !== null, 'A1. CONTROL: one PHP site alone answers');
        await removeAll(alone.ids);
        const ten = await storm(Array.from({ length: 10 }, (_, i) => `real${i + 1}`), 0);
        const answered = ten.firstAnswer.filter((t): t is number => t !== null);
        console.log(`    ten at once: first answers (ms) ${ten.firstAnswer.join(', ')}; slowest ${Math.max(...answered)} ms`);
        await sleep(Math.max(0, 25_000 - (Date.now() - ten.t0)));
        console.log(`    Genie at ${Math.round((Date.now() - ten.t0) / 1000)} s: ${states(ten.ids)}; routed ${routed(ten.ids)}/10`);
        check(answered.length === 10, 'A2. all ten real sites answer on their ports when started at once', `${answered.length}/10`);
        check(routed(ten.ids) === 10, 'A3. …and Genie routes all ten', `${routed(ten.ids)}/10`);
        await removeAll(ten.ids);

        console.log('B. THE BUG: ten sites at once, each app warming up for 25 s (past the 15 s first probe)');
        const cold = await storm(Array.from({ length: 10 }, (_, i) => `cold${i + 1}`), 25_000);
        console.log(`    first answers (ms) ${cold.firstAnswer.join(', ')}`);
        console.log(`    Genie at 18 s: ${cold.at18}`);
        check(cold.ids.every((_id, i) => !/=failed/.test(cold.at18.split(' ')[i] ?? '')), 'B-1. at 18 s (past the first window) no cold site reads failed: it is still starting', cold.at18);
        await sleep(Math.max(0, 60_000 - (Date.now() - cold.t0)));
        const allAnswer = cold.firstAnswer.every((t) => t !== null);
        check(allAnswer, 'B0. CONTROL: every cold site answers on its port (measured by this harness, not by Genie)', cold.firstAnswer.join(', '));
        const after = cold.ids.map((id) => composed.sites.get(id)!);
        console.log(`    Genie at ${Math.round((Date.now() - cold.t0) / 1000)} s: ${states(cold.ids)}`);
        check(after.every((s) => s.state === 'running'), 'B1. every cold site reads RUNNING once it answers, with no click', states(cold.ids));
        check(routed(cold.ids) === 10, 'B2. …and is ROUTED by the front door', `${routed(cold.ids)}/10`);
        check(after.every((s) => s.problem === null), 'B3. …with no failure reason left on it', after.map((s) => s.problem).filter(Boolean).join(' | ').slice(0, 300));
        await removeAll(cold.ids);
    } finally {
        await composed.shutdown();
        console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAIL: ${failures.join('; ')}`} (${Math.round((Date.now() - t00) / 1000)} s)`);
    }
}

main().then(() => process.exit(failures.length === 0 ? 0 : 1), (error: unknown) => { console.error(error); process.exit(1); });
