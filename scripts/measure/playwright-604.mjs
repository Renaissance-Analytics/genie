// Tynn #604 MEASUREMENT (runs on an Azure test VM only, never the desktop): can a worktree run a Playwright test with no
// install, through the managed browsers path and through a `playwright run-server` endpoint? Records versions and timings.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, connect } from 'node:net';
import { networkInterfaces } from 'node:os';

const root = resolve(process.argv[2] ?? 'ci-out/pw604');
rmSync(root, { recursive: true, force: true });
const main = join(root, 'main'), wt = join(root, 'wt'), browsers = join(root, 'browsers'), old = join(root, 'old');
mkdirSync(main, { recursive: true });
const win = process.platform === 'win32';
const results = { platform: process.platform, node: process.version, steps: [] };
const rec = (name, data) => { results.steps.push({ name, ...data }); console.log('STEP', name, JSON.stringify(data)); };
const now = () => Date.now();
const sh = (cmd, args, opts = {}) => {
    const s = now();
    const r = spawnSync(win ? 'cmd.exe' : cmd, win ? ['/d', '/s', '/c', cmd, ...args] : args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env ?? {}) } });
    return { code: r.status, ms: now() - s, out: ((r.stdout ?? '') + (r.stderr ?? '')).slice(-1500) };
};
const dirSize = (d) => { let n = 0; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); n += e.isDirectory() ? dirSize(p) : statSync(p).size; } return n; };
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

const testSrc = "import { test, expect } from '@playwright/test';\ntest('trivial', async ({ page }) => { await page.setContent('<h1>hi</h1>'); await expect(page.locator('h1')).toHaveText('hi'); });\n";
const cfg = "export default { testDir: '.', testMatch: '*.spec.mjs', reporter: 'line', timeout: 60000 };\n";
const nowhere = join(root, 'nonexistent-browsers');

// 1. the one install
writeFileSync(join(main, 'package.json'), '{"name":"main","private":true,"type":"module"}');
let r = sh('npm', ['i', '--no-audit', '--no-fund', '@playwright/test@latest'], { cwd: main });
rec('npm-install-playwright-test', { code: r.code, ms: r.ms });
const verOf = (dir) => JSON.parse(spawnSync(process.execPath, ['-p', 'JSON.stringify(require("./node_modules/@playwright/test/package.json").version)'], { cwd: dir, encoding: 'utf8' }).stdout.trim());
results.playwrightVersion = verOf(main);

// 2. browsers once into the managed folder
mkdirSync(browsers, { recursive: true });
r = sh('npx', ['playwright', 'install', 'chromium'], { cwd: main, env: { PLAYWRIGHT_BROWSERS_PATH: browsers } });
rec('install-chromium', { code: r.code, ms: r.ms, bytes: dirSize(browsers), dirs: readdirSync(browsers), tail: r.code ? r.out : undefined });
// a second install must download nothing
r = sh('npx', ['playwright', 'install', 'chromium'], { cwd: main, env: { PLAYWRIGHT_BROWSERS_PATH: browsers } });
rec('install-chromium-again', { code: r.code, ms: r.ms, downloaded: /Downloading/i.test(r.out) });

// 3. a worktree: git worktree + node_modules linked to the main checkout, no install
sh('git', ['init', '-q'], { cwd: main });
writeFileSync(join(main, '.gitignore'), 'node_modules\n');
writeFileSync(join(main, 'playwright.config.mjs'), cfg);
writeFileSync(join(main, 'a.spec.mjs'), testSrc);
sh('git', ['add', '-A'], { cwd: main });
sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: main });
r = sh('git', ['worktree', 'add', '-q', wt, '-b', 'wt'], { cwd: main });
rec('git-worktree-add', { code: r.code, hasNodeModules: existsSync(join(wt, 'node_modules')) });
symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'), win ? 'junction' : 'dir');
rec('link-node_modules', { kind: win ? 'junction' : 'symlink', ok: existsSync(join(wt, 'node_modules', '@playwright', 'test')) });

// 4. run in the worktree via the managed browsers path
r = sh('npx', ['playwright', 'test'], { cwd: wt, env: { PLAYWRIGHT_BROWSERS_PATH: browsers } });
rec('worktree-test-managed-browsers', { code: r.code, ms: r.ms, out: r.out });

// 5. the browser server
const port = await freePort();
const token = 'tok' + Math.random().toString(36).slice(2);
const srvArgs = ['playwright', 'run-server', '--host', '127.0.0.1', '--port', String(port), '--path', '/' + token];
const srv = spawn(win ? 'cmd.exe' : 'npx', win ? ['/d', '/s', '/c', 'npx', ...srvArgs] : srvArgs, { cwd: main, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = '';
srv.stdout.on('data', (d) => (srvOut += d));
srv.stderr.on('data', (d) => (srvOut += d));
const upAt = now();
await new Promise((ok) => { const i = setInterval(() => { if (/Listening on/.test(srvOut) || now() - upAt > 60000) { clearInterval(i); ok(); } }, 100); });
rec('server-start', { ms: now() - upAt, banner: srvOut.slice(0, 300) });
const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const reach = (host) => new Promise((ok) => { const s = connect({ host, port }, () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); setTimeout(() => { s.destroy(); ok(false); }, 3000); });
rec('server-bind', { loopback: await reach('127.0.0.1'), lanAddress: lan ?? null, lanReachable: lan ? await reach(lan) : null });
r = sh('npx', ['playwright', 'test'], { cwd: wt, env: { PW_TEST_CONNECT_WS_ENDPOINT: 'ws://127.0.0.1:' + port + '/' + token, PLAYWRIGHT_BROWSERS_PATH: nowhere } });
rec('worktree-test-via-server', { code: r.code, ms: r.ms, out: r.out });
r = sh('npx', ['playwright', 'test'], { cwd: wt, env: { PW_TEST_CONNECT_WS_ENDPOINT: 'ws://127.0.0.1:' + port + '/wrong', PLAYWRIGHT_BROWSERS_PATH: nowhere } });
rec('worktree-test-wrong-token', { code: r.code, ms: r.ms, out: r.out });

// 6. a client at a different version against this server
mkdirSync(old, { recursive: true });
writeFileSync(join(old, 'package.json'), '{"name":"old","private":true,"type":"module"}');
const oldVer = process.env.PW_OLD ?? '1.49.1';
r = sh('npm', ['i', '--no-audit', '--no-fund', '@playwright/test@' + oldVer], { cwd: old });
rec('npm-install-old-client', { code: r.code, ms: r.ms, version: oldVer, installed: verOf(old) });
writeFileSync(join(old, 'playwright.config.mjs'), cfg);
writeFileSync(join(old, 'a.spec.mjs'), testSrc);
r = sh('npx', ['playwright', 'test'], { cwd: old, env: { PW_TEST_CONNECT_WS_ENDPOINT: 'ws://127.0.0.1:' + port + '/' + token, PLAYWRIGHT_BROWSERS_PATH: nowhere } });
rec('old-client-via-server-mismatch', { code: r.code, ms: r.ms, out: r.out });
// shared folder: the old version's browsers into the SAME path; what does it hold, and does a second version download a second set?
const before = readdirSync(browsers);
r = sh('npx', ['playwright', 'install', 'chromium'], { cwd: old, env: { PLAYWRIGHT_BROWSERS_PATH: browsers } });
rec('install-old-into-shared-path', { code: r.code, ms: r.ms, bytes: dirSize(browsers), dirsBefore: before, dirsAfter: readdirSync(browsers), downloaded: /Downloading/i.test(r.out) });

srv.kill();
if (win) spawnSync('taskkill', ['/F', '/T', '/PID', String(srv.pid)]);
mkdirSync('ci-out', { recursive: true });
writeFileSync(join('ci-out', 'playwright-604.json'), JSON.stringify(results, null, 2));
console.log('DONE');
