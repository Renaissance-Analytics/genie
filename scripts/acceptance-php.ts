/**
 * ACCEPTANCE — PHP SITES ARE FAST AND CONCURRENT ON WINDOWS (genie#1043; moic, 2026-10-21, on moic.gen: Laravel /up
 * 2,606 ms, 4 parallel fetches 3,267 ms one after another — "the feature doesn't work at all").
 *
 * Runs in the Windows test VM (no PHP there): downloads the official PHP 8.4 NTS build from windows.php.net (its sha256
 * checked against releases.json), writes GENIE'S OWN php.ini (core/php-versions.ts phpIniContents — the product's, not a
 * copy), makes the opcache directory as Genie's install does, starts GENIE'S number of `php-cgi -b` workers
 * (site-manager PHP_WORKERS; 1 where a build has none) and measures through FastCGI, as the site's Caddy talks to them:
 *
 *   1. every worker is still alive 3 s after it started (Genie 1 left opcache out because it "makes php-cgi.exe die at
 *      startup on Windows" — this is the check that settles it);
 *   2. a compile-heavy script (a generated 20,000-function file) answered again is at least 2x faster than its first,
 *      cold answer — opcache keeping the compiled file (without it every request recompiles, as moic measured);
 *   3. four requests of a script that takes 1 s, sent together, are all answered within 2 s — served side by side, not
 *      one after another.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-php.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phpIniContents } from '../src/core/php-versions.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function workerCount(): Promise<number> {
    try {
        const m = (await import('../src/main/site-manager.js')) as { PHP_WORKERS?: number };
        return typeof m.PHP_WORKERS === 'number' ? m.PHP_WORKERS : 1;
    } catch {
        return 1;
    }
}

// ---- PHP 8.4 NTS x64 from windows.php.net, verified ---------------------------------------------------------------
async function installPhp(root: string): Promise<string> {
    const releases = (await (await fetch('https://windows.php.net/downloads/releases/releases.json')).json()) as Record<string, Record<string, unknown>>;
    const v84 = releases['8.4'];
    if (!v84) throw new Error('releases.json has no 8.4');
    // ACCEPT_PHP_BUILD=ts: the thread-safe (ZTS) build — what a machine set up for FrankenPHP has on PATH (genie#669).
    const flavour = process.env['ACCEPT_PHP_BUILD'] === 'ts' ? 'ts' : 'nts';
    const build = Object.entries(v84).find(([k]) => new RegExp(`^${flavour}-vs\\d+-x64$`).test(k))?.[1] as { zip?: { path: string; sha256: string } } | undefined;
    if (!build?.zip) throw new Error(`releases.json has no 8.4 ${flavour} x64 zip`);
    const dir = join(root, build.zip.path.replace(/\.zip$/, ''));
    if (existsSync(join(dir, 'php-cgi.exe'))) return dir;
    const bytes = Buffer.from(await (await fetch(`https://windows.php.net/downloads/releases/${build.zip.path}`)).arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== build.zip.sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${build.zip.path}`);
    const zip = join(root, build.zip.path);
    writeFileSync(zip, bytes);
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
    return dir;
}

// ---- a minimal FastCGI client: one request, the response's STDOUT --------------------------------------------------
function record(type: number, id: number, content: Buffer): Buffer {
    const pad = (8 - (content.length % 8)) % 8;
    const h = Buffer.alloc(8);
    h.writeUInt8(1, 0); h.writeUInt8(type, 1); h.writeUInt16BE(id, 2); h.writeUInt16BE(content.length, 4); h.writeUInt8(pad, 6);
    return Buffer.concat([h, content, Buffer.alloc(pad)]);
}
function nameValue(name: string, value: string): Buffer {
    const len = (n: number) => (n < 128 ? Buffer.from([n]) : (() => { const b = Buffer.alloc(4); b.writeUInt32BE(n | 0x80000000); return b; })());
    return Buffer.concat([len(Buffer.byteLength(name)), len(Buffer.byteLength(value)), Buffer.from(name), Buffer.from(value)]);
}
function fcgi(port: number, script: string): Promise<{ ms: number; body: string }> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const sock = connect(port, '127.0.0.1');
        const chunks: Buffer[] = [];
        sock.on('data', (d) => chunks.push(d));
        sock.on('error', reject);
        sock.on('close', () => {
            const all = Buffer.concat(chunks);
            let out = '';
            for (let i = 0; i + 8 <= all.length;) {
                const type = all.readUInt8(i + 1), len = all.readUInt16BE(i + 4), pad = all.readUInt8(i + 6);
                if (type === 6) out += all.subarray(i + 8, i + 8 + len).toString();
                i += 8 + len + pad;
            }
            resolve({ ms: Date.now() - started, body: out.split('\r\n\r\n').slice(1).join('\r\n\r\n') });
        });
        const params = Buffer.concat([
            nameValue('SCRIPT_FILENAME', script), nameValue('REQUEST_METHOD', 'GET'), nameValue('SERVER_PROTOCOL', 'HTTP/1.1'),
            nameValue('GATEWAY_INTERFACE', 'CGI/1.1'), nameValue('REDIRECT_STATUS', '200'),
        ]);
        const begin = Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]); // role RESPONDER, flags 0 (close when done)
        sock.end(Buffer.concat([record(1, 1, begin), record(4, 1, params), record(4, 1, Buffer.alloc(0)), record(5, 1, Buffer.alloc(0))]));
    });
}

// ---- run ----------------------------------------------------------------------------------------------------------
const root = join(tmpdir(), 'genie-php-accept');
mkdirSync(root, { recursive: true });
const phpDir = await installPhp(root);
// ACCEPT_PHP_OPCACHE=off: Genie's ini with its opcache lines left out — to tell opcache from the worker count.
const ini = process.env['ACCEPT_PHP_OPCACHE'] === 'off'
    ? phpIniContents(phpDir).split('\r\n').filter((l) => !/^(zend_extension=opcache|opcache\.)/.test(l)).join('\r\n')
    : phpIniContents(phpDir);
writeFileSync(join(phpDir, 'php.ini'), ini);
// As Genie's install does: the opcache file cache's directory exists before php-cgi starts (when the ini names one).
const cacheDir = /^opcache\.file_cache="([^"]+)"/m.exec(ini)?.[1];
if (cacheDir) mkdirSync(cacheDir, { recursive: true });
console.log(`\nPHP ACCEPTANCE — ${phpDir}; opcache in Genie's ini: ${/^zend_extension=opcache$/m.test(ini) ? 'on' : 'off'}\n`);

const app = join(root, 'app');
mkdirSync(app, { recursive: true });
writeFileSync(join(app, 'slow.php'), '<?php usleep(1000000); echo "slow-ok";');
const fns = Array.from({ length: 20000 }, (_, i) => `function f${i}($a) { $b = $a * ${i}; if ($b > ${i}) { return $b - ${i}; } return $b + ${i}; }`).join('\n');
writeFileSync(join(app, 'big.php'), `<?php\n${fns}\n`);
writeFileSync(join(app, 'heavy.php'), `<?php require __DIR__ . '/big.php'; echo "heavy-" . f19999(3);`);

const n = Number(process.env['ACCEPT_PHP_WORKERS'] ?? '') || (await workerCount());
const ports = Array.from({ length: n }, (_, i) => 39100 + i);
const said: string[] = ports.map(() => '');
const workers: ChildProcess[] = ports.map((p, i) => {
    const w = spawn(join(phpDir, 'php-cgi.exe'), ['-c', join(phpDir, 'php.ini'), '-b', `127.0.0.1:${p}`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_FCGI_MAX_REQUESTS: '0' } });
    w.stdout?.on('data', (d: Buffer) => { said[i] += d.toString(); });
    w.stderr?.on('data', (d: Buffer) => { said[i] += d.toString(); });
    return w;
});
const exited = new Set<number>();
workers.forEach((w, i) => w.on('exit', () => exited.add(i)));
/** Whether something accepts a connection on the port within `ms`. */
async function listening(port: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const ok = await new Promise<boolean>((r) => { const s = connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
        if (ok) return true;
        await sleep(250);
    }
    return false;
}
try {
    await sleep(3000);
    check(exited.size === 0, `1. all ${n} php-cgi worker(s) are alive 3 s after starting`, `${n - exited.size}/${n} alive`);
    const up = await Promise.all(ports.map((p) => listening(p, 10_000)));
    check(up.every(Boolean), `1b. all ${n} worker(s) LISTEN on their port within 10 s`, `${up.filter(Boolean).length}/${n} listening`);
    if (!up.every(Boolean)) {
        said.forEach((s, i) => console.log(`  worker ${i + 1} (port ${ports[i]}) said: ${s.trim().slice(0, 600) || '(nothing)'}`));
        throw new Error('workers not listening; nothing more to measure');
    }

    const first = await fcgi(ports[0]!, join(app, 'heavy.php'));
    const again: number[] = [];
    for (let i = 0; i < 5; i++) again.push((await fcgi(ports[0]!, join(app, 'heavy.php'))).ms);
    const median = [...again].sort((a, b) => a - b)[2]!;
    check(first.body.includes('heavy-') && median * 2 <= first.ms, '2. a compile-heavy script answered again is at least 2x faster than cold', `cold ${first.ms} ms, again median ${median} ms (${again.join(', ')})`);

    const t0 = Date.now();
    const four = await Promise.all([0, 1, 2, 3].map((i) => fcgi(ports[i % n]!, join(app, 'slow.php'))));
    const total = Date.now() - t0;
    check(four.every((r) => r.body.includes('slow-ok')) && total < 2000, '3. four 1-second requests sent together are all answered within 2 s', `${total} ms with ${n} worker(s)`);
} catch (error) {
    results.push(false);
    console.log(`  STOPPED  ${error instanceof Error ? error.message : String(error)}`);
} finally {
    for (const w of workers) w.kill();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${failed === 0 ? 'PHP ACCEPTANCE PASSED' : `PHP ACCEPTANCE FAILED — ${failed}`}`);
process.exit(failed === 0 ? 0 : 1);
