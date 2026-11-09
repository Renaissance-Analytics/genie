/**
 * THE SPAWN HOST, FOR REAL, ON A TEST VM (genie#1397). Never on the owner's desktop.
 *
 *   Windows (genie-test-windows):  npx tsx scripts/fetch-caddy.ts; npx tsx test/live/spawn-host.live.ts
 *
 * Genie's real composition with main.ts's wiring: execFileRunner and `docker events` routed through the REAL spawn host
 * entry (src/main/spawn-host.ts, forked as main forks it), and the supervisor's ptys made there. Checks:
 *
 *   S1. Docker through the spawn host: `docker version` answers (or is not installed) and the events watch starts.
 *   S2. Three PHP sites start through it: each running, routed and answering on its port; each process has a real pid,
 *       alive, whose parent is not this process (the spawn host made it).
 *   S3. Restart a site: running again, answering.
 *   S4. The spawn host is killed hard: every process it made is ended (no orphan keeps a port), and the supervisor
 *       starts them again in a new spawn host: all three sites running and answering again.
 *   S5. Quit: shutdown + stop leaves none of the sites' processes alive.
 *
 * Exits 1 on any FAIL.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { availableParallelism, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHP_RECIPES, type PhpPlatform } from '../../src/core/php-versions.js';
import { httpFetchOver, installPhpVersion, nodePhpVersionsFs, phpVersionsRoot } from '../../src/main/php-versions.js';
const liveFetch = httpFetchOver(fetch);
import { execFileRunner, lineStreamRunner } from '../../src/main/toolchain-runner.js';
import { composeServices } from '../helpers/compose-alone.js';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { siteAnswers } from '../../src/main/port-probe.js';
import { routeExecThroughSpawnHost, startSpawnHost } from '../../src/main/spawn-host-client.js';

const platform = process.platform as PhpPlatform;
const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const get = (port: number) => new Promise<number>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: 20_000, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
});
const until = async (ok: () => boolean | Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return true; await sleep(250); } return ok(); };

async function main(): Promise<void> {
    const t00 = Date.now();
    const caddyBin = join(process.cwd(), 'build', 'runtime', platform === 'win32' ? 'caddy.exe' : 'caddy');
    check(existsSync(caddyBin), '0. CONTROL: Genie’s pinned Caddy is here', caddyBin);
    const base = mkdtempSync(join(tmpdir(), 'genie-spawnhost-'));
    const version = PHP_RECIPES.find((r) => r.version === '8.4.27')?.version ?? PHP_RECIPES[0]!.version;
    const outcome = await installPhpVersion(version, true, {
        platform, root: phpVersionsRoot(join(base, 'toolchain')), fs: nodePhpVersionsFs(), run: (b, a, o) => execFileRunner(b, a, { timeoutMs: 45 * 60_000, ...(o?.env ? { env: o.env } : {}) }), fetchBytes: liveFetch.bytes, fetchText: liveFetch.text, cpus: availableParallelism(), progress: () => {},
    } as Parameters<typeof installPhpVersion>[2]);
    check(outcome.kind === 'installed', `0b. CONTROL: PHP ${version} installs`, outcome.kind === 'installed' ? outcome.dir : JSON.stringify(outcome).slice(0, 300));
    if (outcome.kind !== 'installed') return;
    process.env['PATH'] = `${outcome.dir}${delimiter}${process.env['PATH'] ?? ''}`;

    // MAIN'S WIRING: the real spawn host entry, forked; execFileRunner and the supervisor's ptys through it.
    const lines: string[] = [];
    const host = startSpawnHost({ entry: fileURLToPath(new URL('../../src/main/spawn-host.ts', import.meta.url)), execArgv: ['--import', 'tsx'], log: (l) => { lines.push(l); console.log(`    [lifecycle] ${l}`); } });
    routeExecThroughSpawnHost(host);
    const userData = join(base, 'home');
    const ws = join(base, 'acme');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'acme', repos: [] }, null, 2)}\n`);
    const mainPty = realFancyTermPort();
    const composed = await composeServices({
        userData, pty: mainPty, processPty: host.ptyPort(mainPty), v1Settings: () => null, caddyBin, frontDoorPort: 0,
        portFree: async () => true, workspaces: () => [{ id: 'acme', path: ws }],
        siteProbe: (port, options) => siteAnswers(port, options),
    });

    try {
        console.log(`\ngenie#1397 spawn host live — ${platform}, ${availableParallelism()} CPUs, spawn host pid ${host.pid}\n`);
        check(await until(() => lines.some((l) => l.startsWith('spawn host ready')), 30_000), 'S0. the spawn host starts and says it is ready', lines.join(' | ').slice(0, 200));

        const docker = await execFileRunner('docker', ['version', '--format', '{{.Server.Version}}']).then((r) => `exit ${r.exitCode}: ${r.stdout.trim().slice(0, 80)}`, (e: { code?: string; message?: string }) => `${e.code ?? 'error'}: ${e.message ?? ''}`);
        console.log(`    docker version through the spawn host: ${docker}`);
        check(/^exit \d+|^ENOENT/.test(docker), 'S1. Docker is asked through the spawn host (an answer, or not installed)', docker);
        let streamEnd = '';
        const s = lineStreamRunner('docker', ['events', '--format', '{{json .}}', '--filter', 'type=container'], () => {}, (reason) => { streamEnd = reason; });
        await sleep(3_000);
        console.log(`    docker events through the spawn host: ${streamEnd === '' ? 'streaming' : `ended: ${streamEnd.slice(0, 160)}`}`);
        s.stop();
        check(true, 'S1b. docker events runs through the spawn host', streamEnd === '' ? 'streaming' : streamEnd.slice(0, 120));

        const names = ['one', 'two', 'three'];
        const ids = names.map((n) => {
            const dir = join(ws, n);
            mkdirSync(join(dir, 'public'), { recursive: true });
            writeFileSync(join(dir, 'public', 'index.php'), `<?php echo 'ok ', getmypid();\n`);
            return composed.sites.create({ name: n, workspaceId: 'acme', repoPath: dir, serve: { mode: 'php', root: 'public' } }).id;
        });
        const running = () => ids.every((id) => composed.sites.get(id)?.state === 'running');
        const answering = async () => (await Promise.all(ids.map((id) => get(composed.sites.get(id)!.port!)))).every((c) => c === 200);
        check(await until(running, 90_000), 'S2. three PHP sites started through the spawn host read running', ids.map((id) => composed.sites.get(id)?.state).join(' '));
        check(await answering(), 'S2b. …and answer on their ports');
        check(composed.sites.routes().length >= 3, 'S2c. …and are routed', `${composed.sites.routes().length} routes`);
        const procs = () => composed.supervisor.list().filter((p) => p.workspaceId === 'acme');
        const pids = procs().map((p) => p.pid);
        check(pids.length === 15 && pids.every((p) => p !== null && p > 0 && alive(p)), 'S2d. each of the 15 processes (3 × Caddy + 4 php-cgi) has a real pid, alive', pids.join(','));

        composed.sites.restart(ids[0]!);
        check(await until(async () => composed.sites.get(ids[0]!)?.state === 'running' && (await get(composed.sites.get(ids[0]!)!.port!)) === 200, 60_000), 'S3. a restarted site runs and answers again');

        // php-cgi processes on the machine, counted by the OS (tasklist / pgrep), through the spawn host.
        const phpCount = async () => platform === 'win32'
            ? (await execFileRunner('tasklist', ['/FI', 'IMAGENAME eq php-cgi.exe', '/NH'])).stdout.split(/\r?\n/).filter((l) => /php-cgi\.exe/i.test(l)).length
            : Number((await execFileRunner('pgrep', ['-c', 'php-cgi'])).stdout.trim() || '0');
        const phpBefore = await phpCount();
        check(phpBefore === 12, 'S4-0. CONTROL: the OS counts the 12 php-cgi workers the sites run', `${phpBefore}`);
        // THREE TIMES (a recovery that missed once on genie-test-windows, 2026-11-01, and passed the next run: forced here).
        for (let round = 1; round <= 3; round += 1) {
            const before = procs().map((p) => p.pid!).filter((p) => p > 0);
            const first = host.pid!;
            const killedAt = Date.now();
            process.kill(first);
            check(await until(() => before.every((p) => !alive(p)), 30_000), `S4.${round} the spawn host killed hard: every pty helper it made is ended`, before.filter(alive).join(',') || 'none left');
            const back = await until(async () => running() && (await answering()), 120_000);
            if (!back) {
                // WHAT EACH SITE SAYS, and each process: the evidence for why one did not come back.
                for (const id of ids) {
                    const site = composed.sites.get(id)!;
                    console.log(`    ${site.host} state=${site.state} port=${site.port} answers=${await get(site.port!)} problem=${site.problem ?? '-'}`);
                    for (const pid of site.processIds) {
                        const p = composed.supervisor.status(pid);
                        const tail = (composed.supervisor.log(pid) ?? '').split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
                        console.log(`      ${pid} ${p?.state} pid=${p?.pid} restarts=${p?.restarts} exit=${p?.exitCode} :: ${tail.slice(0, 600)}`);
                    }
                }
                const caddies = platform === 'win32' ? (await execFileRunner('tasklist', ['/FI', 'IMAGENAME eq caddy.exe', '/NH'])).stdout.split(/\r?\n/).filter((l) => /caddy\.exe/i.test(l)).length : -1;
                console.log(`    caddy.exe on the machine: ${caddies}`);
            }
            check(back, `S4b.${round} …and the supervisor starts every site again in a new spawn host, answering`, `${Math.round((Date.now() - killedAt) / 1000)} s; ${ids.map((id) => composed.sites.get(id)?.state).join(' ')}; spawn host ${first} → ${host.pid}`);
            const phpAfter = await phpCount();
            check(phpAfter === 12, `S4c.${round} …with no orphan left: still 12 php-cgi on the machine`, `${phpAfter}`);
        }

        const last = procs().map((p) => p.pid!).filter((p) => p > 0);
        await composed.shutdown();
        await host.stop();
        check(await until(() => last.every((p) => !alive(p)), 20_000), 'S5. quit: none of the sites\' processes is left', last.filter(alive).join(',') || 'none left');
    } finally {
        routeExecThroughSpawnHost(null);
        console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAIL: ${failures.join('; ')}`} (${Math.round((Date.now() - t00) / 1000)} s)`);
    }
}

main().then(() => process.exit(failures.length === 0 ? 0 : 1), (error: unknown) => { console.error(error); process.exit(1); });
