/**
 * A PHP SITE'S APP CREDENTIAL, READ BY A SERVED REQUEST — for real, in omarchy-test (genie#1376).
 *
 * fancy reported (2026-10-31) that on flabs.gen — `php artisan serve` — `GENIE_INBOX_URL` / `GENIE_INBOX_TOKEN` were
 * absent from every served request. test/live/app-inbox.live.ts proved the token reaches a site's PROCESS, with a node
 * server. This asks the question that one did not: does the PHP that ANSWERS A REQUEST see it, in every way Genie serves
 * PHP? Each site below is started by Genie's real composition (real pty engine, real bundled Caddy, real php-cgi, a real
 * Laravel app), and each answers a probe request with what `getenv()`, `$_SERVER`, `$_ENV` and Laravel's `env()` say.
 *
 *   A. php mode (Genie's Caddy + php-cgi workers)  — two sites: each reads ITS OWN token, never the other's;
 *   B. `php artisan serve` (Genie's Laravel default; flabs) under Genie's own ini (`variables_order = "EGPCS"`);
 *   C. `php artisan serve` under PHP's stock ini (`GPCS`) — the control that names the cause;
 *   D. a plain CLI server (`php -S`), and FrankenPHP / Octane when their binaries could be fetched;
 *   E. a served request POSTS to Genie's door with the token it read — and lands marked `site:<name>`;
 *   F. a kept process and a scheduled task (`php -r`, a CLI) read their OWN `proc:` credential and post with it.
 *
 * Every absence sits beside a presence measured the same way. Run in the VM only, after test/live/app-inbox-php.setup.sh:
 *   scripts/vm-fifo.sh omarchy ../_wt/<tree> 'bash test/live/app-inbox-php.setup.sh && npx tsx test/live/app-inbox-php.live.ts'
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRecord, mintAgentId } from '../../src/core/identity.js';
import { AppInboxKeys } from '../../src/main/app-inbox-keys.js';
import { AppInboxService, appInboxEnvFor, startAppInboxServer } from '../../src/main/app-inbox-service.js';
import { composeServices } from '../../src/main/compose.js';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { ProcessBook } from '../../src/main/process-book.js';
import { ProcessScheduler } from '../../src/main/process-scheduler.js';

const failures: string[] = [];
const notes: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
async function until<T>(probe: () => Promise<T | null> | T | null, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v !== null) return v;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 500));
    }
}
const get = (port: number, path: string, host: string) => new Promise<{ status: number; body: string }>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: host }, timeout: 20_000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
});

interface Probe { getenv: string | null; server: string | null; env: string | null; laravel?: string | null; url: string | null; post?: { status: number; body: string } | null }

/** The probe a served request runs: what each PHP reader says, and (`?post=1`) a POST to Genie's door with that token. */
const PROBE_PHP = `<?php
$t = getenv('GENIE_INBOX_TOKEN');
$u = getenv('GENIE_INBOX_URL');
$out = [
  'getenv' => $t === false ? null : $t,
  'server' => $_SERVER['GENIE_INBOX_TOKEN'] ?? null,
  'env' => $_ENV['GENIE_INBOX_TOKEN'] ?? null,
  'url' => $u === false ? null : $u,
];
if (isset($_GET['post']) && $t && $u) {
  $ctx = stream_context_create(['http' => ['method' => 'POST', 'ignore_errors' => true,
    'header' => "Authorization: Bearer $t\\r\\nContent-Type: application/json\\r\\n",
    'content' => json_encode(['subject' => 'served request on ' . ($_SERVER['HTTP_HOST'] ?? '?'), 'body' => 'from a served PHP request'])]]);
  $body = @file_get_contents($u . '/v1/inbox', false, $ctx);
  $status = 0; foreach (($http_response_header ?? []) as $h) if (preg_match('#^HTTP/\\S+ (\\d+)#', $h, $m)) $status = (int) $m[1];
  $out['post'] = ['status' => $status, 'body' => (string) $body];
}
header('Content-Type: application/json');
echo json_encode($out);
`;

/** The Laravel route: the same, plus what `env()` answers inside the framework. */
const LARAVEL_ROUTE = `
Route::get('/genie-probe', function () {
    $t = getenv('GENIE_INBOX_TOKEN');
    return response()->json([
        'getenv' => $t === false ? null : $t,
        'server' => $_SERVER['GENIE_INBOX_TOKEN'] ?? null,
        'env' => $_ENV['GENIE_INBOX_TOKEN'] ?? null,
        'laravel' => env('GENIE_INBOX_TOKEN'),
        'url' => env('GENIE_INBOX_URL'),
    ]);
});
`;

const CLI_PROBE = (out: string, subject: string) => `
$t = getenv('GENIE_INBOX_TOKEN'); $u = getenv('GENIE_INBOX_URL'); $status = 0; $body = '';
if ($t && $u) {
  $ctx = stream_context_create(['http' => ['method' => 'POST', 'ignore_errors' => true, 'header' => "Authorization: Bearer $t\\r\\nContent-Type: application/json\\r\\n", 'content' => json_encode(['subject' => '${subject}', 'body' => 'from a php CLI'])]]);
  $body = (string) @file_get_contents($u . '/v1/inbox', false, $ctx);
  foreach (($http_response_header ?? []) as $h) if (preg_match('#^HTTP/\\S+ (\\d+)#', $h, $m)) $status = (int) $m[1];
}
file_put_contents('${out}', json_encode(['getenv' => $t === false ? null : $t, 'status' => $status, 'body' => $body]));
`;

async function main(): Promise<void> {
    const caddyBin = join(process.cwd(), 'build', 'runtime', 'caddy');
    const laravelSkeleton = process.env['GENIE_LIVE_LARAVEL'] ?? join(tmpdir(), 'genie-live-laravel');
    const frankenphp = process.env['GENIE_LIVE_FRANKENPHP'] ?? '';
    const octaneApp = process.env['GENIE_LIVE_OCTANE'] ?? '';
    check(existsSync(caddyBin), '0. CONTROL: Genie’s pinned Caddy is here', caddyBin);
    check(existsSync(join(laravelSkeleton, 'artisan')) && existsSync(join(laravelSkeleton, '.env')), '0b. CONTROL: a real Laravel app with a .env (flabs’ shape)', laravelSkeleton);

    const root = mkdtempSync(join(tmpdir(), 'genie2-app-inbox-php-'));
    const userData = join(root, 'home');
    const ws = join(root, 'fancy');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'fancy', repos: [] }, null, 2)}\n`);

    // Two plain PHP repos for php mode; one for `php -S` / FrankenPHP.
    for (const name of ['pcgi', 'pcgi2', 'plain']) {
        mkdirSync(join(ws, name, 'public'), { recursive: true });
        writeFileSync(join(ws, name, 'public', 'index.php'), PROBE_PHP);
    }
    // Two copies of the Laravel app: one under Genie's ini (EGPCS), one under PHP's stock ini (GPCS) — the control.
    for (const name of ['lara', 'laragpcs']) {
        cpSync(laravelSkeleton, join(ws, name), { recursive: true });
        writeFileSync(join(ws, name, 'routes', 'web.php'), `${readFileSync(join(ws, name, 'routes', 'web.php'), 'utf8')}\n${LARAVEL_ROUTE}`);
        writeFileSync(join(ws, name, 'public', 'genie-probe.php'), PROBE_PHP);
    }
    // The ini each PHP is given, through PHP_INI_SCAN_DIR (appended to whatever it already scans).
    const iniDir = (order: string) => { const d = join(root, `ini-${order}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'zz-genie-live.ini'), `variables_order = "${order}"\n`); return d; };
    const egpcs = iniDir('EGPCS');
    const gpcs = iniDir('GPCS');

    const clerk = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name: 'clerk', mode: 'manual' });
    const roster = [clerk];
    const slugs = new Map([['fancy', 'fancy']]);
    const MARK = Buffer.from('GT1');
    const encryptor = { isAvailable: () => true, encrypt: (b: Buffer) => Buffer.concat([MARK, Buffer.from(b.map((x) => x ^ 0x5a))]), decrypt: (b: Buffer) => Buffer.from(b.subarray(MARK.length).map((x) => x ^ 0x5a)) };

    const keys = await AppInboxKeys.open(userData);
    let services: Awaited<ReturnType<typeof composeServices>> | null = null;
    const service = new AppInboxService({
        keys,
        inbox: { send: (i) => services!.inbox.send(i), unread: (p) => services?.inbox.unread(p) ?? [], all: () => services?.inbox.all() ?? [] },
        roster: () => roster, slugs: () => slugs, defaultAgentOf: () => clerk.id,
        enabled: (w) => services?.settings.snapshotFor(w).app_inbox !== false,
        siteHosts: (w) => services?.sites.list().filter((s) => s.workspaceId === w).map((s) => s.host) ?? [],
    });
    const server = await startAppInboxServer({ service, port: 0 });
    console.log(`\ngenie2 live APP INBOX × PHP — door ${server.url}, root ${root}\n`);

    services = await composeServices({
        userData, pty: realFancyTermPort(userData, encryptor), v1Settings: () => null, caddyBin, frontDoorPort: 0, phpWorkers: 2,
        docker: async () => ({ stdout: '', exitCode: 0 }), portFree: async () => true,
        roster: () => roster, workspaceSlugs: () => slugs,
        workspaces: () => [{ id: 'fancy', path: ws }],
        appInboxEnv: (s) => appInboxEnvFor({ url: server.url, token: keys.tokenFor(s) }),
    });
    const composed = services;
    const tokenOfSite = (id: string) => keys.tokenFor({ kind: 'site', id, name: id.replace(/^site_/, ''), workspaceId: 'fancy' });

    const probe = async (siteId: string, path: string): Promise<Probe | null> => {
        const site = composed.sites.get(siteId);
        if (!site?.port) return null;
        const r = await get(site.port, path, site.host);
        if (r.status !== 200) return null;
        try { return JSON.parse(r.body) as Probe; } catch { return null; }
    };
    const logsOf = (siteId: string) => (composed.sites.get(siteId)?.processIds ?? []).map((p) => { return composed.supervisor.log(p) ?? ''; }).join('\n').slice(-1500);
    const say = (p: Probe | null) => p ? `getenv=${p.getenv ? 'token' : 'none'} $_SERVER=${p.server ? 'token' : 'none'} $_ENV=${p.env ? 'token' : 'none'}${'laravel' in p ? ` env()=${p.laravel ? 'token' : 'none'}` : ''}` : 'no answer';
    const results: Array<[string, string]> = [];

    const book = await ProcessBook.open(userData, { supervisor: composed.supervisor, envFor: (w) => composed.engines.envFor(w), asleep: () => false, appEnv: (p) => composed.appEnv(p) });
    try {
        // A. php mode: Caddy + php-cgi, two sites.
        console.log('A. php mode (Caddy + php-cgi)');
        composed.sites.create({ name: 'pcgi', workspaceId: 'fancy', repoPath: join(ws, 'pcgi'), serve: { mode: 'php', root: 'public' }, env: { PHP_INI_SCAN_DIR: `:${egpcs}` } });
        composed.sites.create({ name: 'pcgi2', workspaceId: 'fancy', repoPath: join(ws, 'pcgi2'), serve: { mode: 'php', root: 'public' }, env: { PHP_INI_SCAN_DIR: `:${egpcs}` } });
        const a = await until(() => probe('site_pcgi', '/index.php'), 60_000);
        const a2 = await until(() => probe('site_pcgi2', '/index.php'), 60_000);
        results.push(['php mode (Caddy + php-cgi)', say(a)]);
        check(a?.getenv === tokenOfSite('site_pcgi') && a.server === a.getenv && a.env === a.getenv, 'A1. pcgi’s served request reads ITS token in getenv(), $_SERVER and $_ENV', a ? say(a) : logsOf('site_pcgi'));
        check(a2?.getenv === tokenOfSite('site_pcgi2'), 'A2. CONTROL: pcgi2’s request reads its own token', say(a2));
        check(!!a && !!a2 && a.getenv !== a2.getenv && a2.server !== a?.getenv && a2.env !== a?.getenv, 'A3. …and never pcgi’s (nor pcgi pcgi2’s)');
        const caddyfile = readFileSync(join(userData, 'runtime', 'sites', 'site_pcgi', 'Caddyfile'), 'utf8');
        check(/php_fastcgi/.test(caddyfile) && !caddyfile.includes(tokenOfSite('site_pcgi') ?? '§') && !/GENIE_INBOX/.test(caddyfile), 'A4. the token is in no Caddyfile on disk (positive control: it is the php_fastcgi file)');

        // B / C. `php artisan serve` — Genie's ini (EGPCS), then the stock ini (GPCS).
        console.log('B/C. php artisan serve (Laravel, a .env present)');
        composed.sites.create({ name: 'lara', workspaceId: 'fancy', repoPath: join(ws, 'lara'), serve: { mode: 'proxy' }, devServer: { stack: 'laravel', command: 'php artisan serve --host=127.0.0.1 --port={port}' }, env: { PHP_INI_SCAN_DIR: `:${egpcs}` } });
        composed.sites.create({ name: 'laragpcs', workspaceId: 'fancy', repoPath: join(ws, 'laragpcs'), serve: { mode: 'proxy' }, devServer: { stack: 'laravel', command: 'php artisan serve --host=127.0.0.1 --port={port}' }, env: { PHP_INI_SCAN_DIR: `:${gpcs}` } });
        const b = await until(() => probe('site_lara', '/genie-probe'), 90_000);
        const bRaw = await until(() => probe('site_lara', '/genie-probe.php'), 30_000);
        const c = await until(() => probe('site_laragpcs', '/genie-probe'), 90_000);
        results.push(['artisan serve, Genie ini (EGPCS) — Laravel route', say(b)], ['artisan serve, Genie ini (EGPCS) — raw public/*.php', say(bRaw)], ['artisan serve, stock ini (GPCS) — Laravel route', say(c)]);
        // `artisan serve` answers through PHP's built-in server, whose cli-server SAPI never copies the process env into
        // $_SERVER — the plain `php -S` site (D1) shows the same, with no Laravel in the way. What carries it there is
        // getenv() and, with Genie's E, $_ENV; Laravel's env() reads both.
        check(b?.laravel === tokenOfSite('site_lara') && b.getenv === b.laravel && b.env === b.laravel, 'B1. lara (Genie’s ini): a Laravel route reads ITS token — env(), getenv(), $_ENV', b ? say(b) : logsOf('site_lara'));
        check(bRaw?.getenv === tokenOfSite('site_lara'), 'B2. …and a plain public/*.php under artisan serve reads it', say(bRaw));
        check(c?.laravel === tokenOfSite('site_laragpcs'), 'C1. laragpcs (stock ini): reads ITS token', c ? say(c) : logsOf('site_laragpcs'));
        check(!!b && !!c && b.laravel !== c.laravel, 'C2. …and lara’s and laragpcs’ tokens are different');
        // The process env of the artisan process DID hold the token: the absence (if any) is downstream of Genie.
        const laraPid = composed.supervisor.status('site_lara')?.pid;
        // The pty's pid may be a shell; read the tree's environs (the artisan php is in it).
        let environ = '';
        try { environ = execFileSync('sh', ['-c', `for p in ${laraPid} $(pgrep -P ${laraPid}); do cat /proc/$p/environ; done`], { encoding: 'utf8' }); } catch { environ = ''; }
        check(environ.includes(`GENIE_INBOX_TOKEN=${tokenOfSite('site_lara')}`), 'B3. CONTROL: the artisan process Genie started holds lara’s token in its own env', `pid ${laraPid}`);

        // D. a plain CLI server, FrankenPHP, Octane.
        console.log('D. other CLI servers');
        composed.sites.create({ name: 'plain', workspaceId: 'fancy', repoPath: join(ws, 'plain'), serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'php -S 127.0.0.1:{port} -t public' }, env: { PHP_INI_SCAN_DIR: `:${egpcs}` } });
        const d = await until(() => probe('site_plain', '/index.php'), 60_000);
        results.push(['php -S (dev server)', say(d)]);
        check(d?.getenv === tokenOfSite('site_plain'), 'D1. php -S: reads ITS token', d ? say(d) : logsOf('site_plain'));
        if (frankenphp && existsSync(frankenphp)) {
            mkdirSync(join(ws, 'franken', 'public'), { recursive: true });
            writeFileSync(join(ws, 'franken', 'public', 'index.php'), PROBE_PHP);
            composed.sites.create({ name: 'franken', workspaceId: 'fancy', repoPath: join(ws, 'franken'), serve: { mode: 'proxy' }, devServer: { stack: 'node', command: `${frankenphp} php-server --listen 127.0.0.1:{port} --root public` } });
            const f = await until(() => probe('site_franken', '/index.php'), 60_000);
            results.push(['FrankenPHP php-server', say(f)]);
            check(f?.getenv === tokenOfSite('site_franken'), 'D2. FrankenPHP php-server: reads ITS token', f ? say(f) : logsOf('site_franken'));
        } else notes.push('FrankenPHP: not measured (its binary could not be fetched in the VM)');
        if (octaneApp && existsSync(join(octaneApp, 'artisan'))) {
            const dir = join(ws, 'octane');
            cpSync(octaneApp, dir, { recursive: true });
            writeFileSync(join(dir, 'routes', 'web.php'), `${readFileSync(join(dir, 'routes', 'web.php'), 'utf8')}\n${LARAVEL_ROUTE}`);
            composed.sites.create({ name: 'octane', workspaceId: 'fancy', repoPath: dir, serve: { mode: 'proxy' }, devServer: { stack: 'laravel', command: 'php artisan octane:start --server=frankenphp --host=127.0.0.1 --port={port} --admin-port=2119' }, env: { PHP_INI_SCAN_DIR: `:${egpcs}` } });
            const o =await until(() => probe('site_octane', '/genie-probe'), 120_000);
            results.push(['Octane (FrankenPHP worker)', say(o)]);
            check(o?.laravel === tokenOfSite('site_octane'), 'D3. Octane: a Laravel route reads ITS token', o ? say(o) : logsOf('site_octane'));
        } else notes.push('Octane: not measured (laravel/octane could not be installed in the VM)');

        // E. A served request uses the token: the message lands marked as that site's.
        console.log('E. a served request posts with the token it read');
        const ePcgi = await probe('site_pcgi', '/index.php?post=1');
        const ePlain = await probe('site_lara', '/genie-probe.php?post=1');
        check(ePcgi?.post?.status === 201, 'E1. pcgi’s request POSTed to the door: 201', JSON.stringify(ePcgi?.post ?? null));
        check(ePlain?.post?.status === 201, 'E2. lara’s request POSTed to the door: 201', JSON.stringify(ePlain?.post ?? null));
        const labels = composed.inbox.all().filter((m) => m.app).map((m) => m.app!.label);
        check(labels.includes('site:pcgi@fancy') && labels.includes('site:lara@fancy'), 'E3. …and both landed, marked site:pcgi@fancy / site:lara@fancy', labels.join(', '));

        // F. A kept process and a scheduled task: their OWN proc: credential, read by a php CLI, used to post.
        console.log('F. a kept process and a scheduled task (php CLI)');
        // The probe is a FILE: an inline `php -r "…"` goes through the shell, which expanded `$t` to nothing (red run 1).
        const phpFile = (name: string, code: string) => { const f = join(root, name); writeFileSync(f, `<?php\n${code}`); return f; };
        const kOut = join(root, 'kept.json');
        const kept = await book.create({ workspaceId: 'fancy', workspacePath: ws, name: 'council tally', command: `php ${phpFile('kept.php', CLI_PROBE(kOut, 'tally done'))}`, restart: 'never' });
        const k = await until(() => (existsSync(kOut) ? JSON.parse(readFileSync(kOut, 'utf8')) as { getenv: string | null; status: number } : null), 30_000);
        const keptToken = keys.tokenFor({ kind: 'process', id: kept.id, name: 'council tally', workspaceId: 'fancy' });
        check(!!k?.getenv && k.getenv === keptToken, 'F1. the kept process’s getenv() is ITS OWN proc: token', `${k?.getenv ? 'token' : 'none'}`);
        check(k?.status === 201, 'F2. …and its post was accepted (201)', JSON.stringify(k));
        const sOut = join(root, 'sched.json');
        const task = await book.create({ workspaceId: 'fancy', workspacePath: ws, name: 'nightly tally', command: `php ${phpFile('sched.php', CLI_PROBE(sOut, 'nightly done'))}`, restart: 'never', schedule: { cron: '0 3 * * *', kind: 'command' } });
        const scheduler = new ProcessScheduler({ book, supervisor: composed.supervisor, envFor: (w) => composed.engines.envFor(w), appEnv: (p) => composed.appEnv(p), asleep: () => false, nudge: () => false, now: () => Date.now(), schedule: () => () => {} });
        await scheduler.runNow(task.id);
        const s = await until(() => (existsSync(sOut) ? JSON.parse(readFileSync(sOut, 'utf8')) as { getenv: string | null; status: number } : null), 30_000);
        const taskToken = keys.tokenFor({ kind: 'process', id: task.id, name: 'nightly tally', workspaceId: 'fancy' });
        check(!!s?.getenv && s.getenv === taskToken && s.getenv !== keptToken, 'F3. the scheduled run’s getenv() is ITS OWN token (not the kept process’s)', `${s?.getenv ? 'token' : 'none'}`);
        check(s?.status === 201, 'F4. …and its post was accepted (201)', JSON.stringify(s));
        const procLabels = composed.inbox.all().filter((m) => m.app).map((m) => m.app!.label);
        check(procLabels.includes('proc:council tally@fancy') && procLabels.includes('proc:nightly tally@fancy'), 'F5. both landed, marked proc:<name>@fancy', procLabels.join(', '));
    } finally {
        console.log('\nWHICH PHP SAW ITS TOKEN:');
        for (const [mode, seen] of results) console.log(`  ${mode.padEnd(52)} ${seen}`);
        for (const n of notes) console.log(`  NOTE ${n}`);
        for (const s of composed.supervisor.list()) composed.supervisor.stop(s.id);
        await composed.shutdown();
        await server.close();
        try { rmSync(root, { recursive: true, force: true }); } catch { /* the pty engine may still hold a file for a moment */ }
    }

    console.log(failures.length === 0 ? '\nALL PASS\n' : `\n${failures.length} FAILED: ${failures.join('; ')}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
