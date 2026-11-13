import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    WINDOW_HOST,
    WINDOW_PAGES,
    WINDOW_PORT_RANGE,
    configureWindowPages,
    loadWindowPage,
    resetWindowPagesForTests,
    startWindowServer,
    windowFile,
    windowPageUrl,
    type WindowServer,
} from '../src/main/window-pages.js';

/**
 * GENIE'S WINDOWS LOAD FROM http://genie.localhost:<port> (Tynn #683), not file://. WebAuthn refuses every origin that is
 * not https or http on a `localhost` name (measured in Genie's Electron, queue item 1113-172626-919eb1: file://, a secure
 * custom scheme and http://127.0.0.1 all refused; http://genie.localhost worked), and the passkey lock (#677) needs the
 * window to be able to ask for one. The server is main's: loopback only, its own Host name only, the built renderer's
 * pages and assets only, by an allow-list. Data never moves to HTTP; it stays on the IPC door.
 */

const temps: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const plain: Server[] = [];
afterEach(async () => {
    for (const s of servers.splice(0)) await s.close().catch(() => {});
    for (const s of plain.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    await resetWindowPagesForTests();
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function temp(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie-window-pages-'));
    temps.push(d);
    return d;
}

/** A built renderer: the five pages, two assets, and things beside and below it that must never be served. */
function renderer(): { root: string; portFile: string } {
    const base = temp();
    const root = join(base, 'renderer');
    mkdirSync(join(root, 'assets', 'sub'), { recursive: true });
    for (const page of WINDOW_PAGES) writeFileSync(join(root, `${page}.html`), `<!doctype html><title>${page}</title>`);
    writeFileSync(join(root, 'assets', 'index-AbC123.js'), 'console.log("genie")');
    writeFileSync(join(root, 'assets', 'Geist-Variable-x1.woff2'), 'font');
    writeFileSync(join(root, 'assets', '.hidden.js'), 'hidden');
    writeFileSync(join(root, 'assets', 'sub', 'nested.js'), 'nested');
    writeFileSync(join(root, 'assets', 'notes.txt'), 'unknown type');
    writeFileSync(join(base, 'secret.js'), 'SECRET');
    writeFileSync(join(base, 'package.json'), '{"secret":true}');
    return { root, portFile: join(base, 'userData', 'window-origin.json') };
}

async function start(opts: Parameters<typeof startWindowServer>[0]): Promise<WindowServer> {
    const s = await startWindowServer({ retryDelayMs: 0, ...opts });
    servers.push(s);
    return s;
}

/** One raw request: the path and Host exactly as given (no normalisation), to 127.0.0.1. */
function get(port: number, path: string, host: string | null, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, setHost: false, headers: host === null ? {} : { Host: host } }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('the window URL', () => {
    it('is http://genie.localhost:<port>/<page>.html, with search and hash as Electron loadFile wrote them', () => {
        expect(WINDOW_HOST).toBe('genie.localhost');
        expect(windowPageUrl(24567, 'index')).toBe('http://genie.localhost:24567/index.html');
        expect(windowPageUrl(24567, 'index', { hash: 'genie://dashboard' })).toBe('http://genie.localhost:24567/index.html#genie://dashboard');
        expect(windowPageUrl(24567, 'index', { search: 'remote=wss%3A%2F%2Fx' })).toBe('http://genie.localhost:24567/index.html?remote=wss%3A%2F%2Fx');
        expect(windowPageUrl(24567, 'index', { search: '?a=1', hash: '#genie://takeover/t1' })).toBe('http://genie.localhost:24567/index.html?a=1#genie://takeover/t1');
        expect(windowPageUrl(24567, 'browser', { search: 'single=1' })).toBe('http://genie.localhost:24567/browser.html?single=1');
        for (const page of ['doctor', 'question', 'host-wait'] as const) expect(windowPageUrl(1, page)).toBe(`http://genie.localhost:1/${page}.html`);
    });
});

describe('what the server may hand out (an allow-list, never a filesystem walk)', () => {
    it('the five pages, never cached', () => {
        for (const page of WINDOW_PAGES) expect(windowFile(`/${page}.html`)).toEqual({ relative: `${page}.html`, contentType: 'text/html; charset=utf-8', cache: 'no-store' });
        expect(windowFile('/index.html?remote=x')).toMatchObject({ relative: 'index.html' });
    });
    it('a flat asset of a known type, with its MIME type', () => {
        expect(windowFile('/assets/index-AbC123.js')).toEqual({ relative: 'assets/index-AbC123.js', contentType: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' });
        expect(windowFile('/assets/a.css')?.contentType).toBe('text/css; charset=utf-8');
        expect(windowFile('/assets/a.woff2')?.contentType).toBe('font/woff2');
        expect(windowFile('/assets/a.wav')?.contentType).toBe('audio/wav');
        expect(windowFile('/assets/a.svg')?.contentType).toBe('image/svg+xml');
        expect(windowFile('/assets/a.png')?.contentType).toBe('image/png');
        expect(windowFile('/assets/a.wasm')?.contentType).toBe('application/wasm');
        expect(windowFile('/assets/a.js.map')?.contentType).toBe('application/json; charset=utf-8');
    });
    it('nothing else: no root, no listing, no other page, no traversal, no dotfile, no nesting, no unknown type', () => {
        for (const p of ['/', '', '/assets', '/assets/', '/mobile', '/mobile/icon-192.png', '/other.html', '/index.htm', '/INDEX.html', '/package.json',
            '/../secret.js', '/assets/../index.html', '/assets/..%2findex.html', '/assets/%2e%2e%2fsecret.js', '/assets/..\\secret.js', '/assets\\index-AbC123.js',
            '//etc/passwd', '/assets/sub/nested.js', '/assets/.hidden.js', '/assets/notes.txt', '/assets/noext', '/assets/a.exe', '/assets/%41.js', '/assets/a.js%00.png'])
            expect(windowFile(p), p).toBeNull();
    });
});

describe('the server', () => {
    it('listens on 127.0.0.1 only, and serves a page with its Host, CSP and nosniff', async () => {
        const { root, portFile } = renderer();
        const s = await start({ root, portFile });
        expect(s.address).toBe('127.0.0.1');
        expect(s.url('index', { hash: 'genie://dashboard' })).toBe(`http://genie.localhost:${s.port}/index.html#genie://dashboard`);
        const r = await get(s.port, '/index.html', `genie.localhost:${s.port}`);
        expect(r.status).toBe(200);
        expect(r.body).toBe('<!doctype html><title>index</title>');
        expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.headers['x-content-type-options']).toBe('nosniff');
        const csp = String(r.headers['content-security-policy']);
        for (const d of ["default-src 'none'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) expect(csp).toContain(d);
        expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|\*/);
        expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(r.headers['referrer-policy']).toBe('no-referrer');
        // No COOP: it swapped a window's first load into a new renderer mid-navigation (gate 1113-181034-c9ede2).
        expect(r.headers['cross-origin-opener-policy']).toBeUndefined();
        const js = await get(s.port, '/assets/index-AbC123.js', `genie.localhost:${s.port}`);
        expect(js.status).toBe(200);
        expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
        expect(js.body).toBe('console.log("genie")');
    });

    it('refuses every Host but its own (a DNS-rebinding guard); the same request with its own Host is served', async () => {
        const { root, portFile } = renderer();
        const s = await start({ root, portFile });
        expect((await get(s.port, '/index.html', `genie.localhost:${s.port}`)).status).toBe(200);
        expect((await get(s.port, '/index.html', `GENIE.LocalHost:${s.port}`)).status).toBe(200);
        for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `genie.localhost:${s.port + 1}`, 'genie.localhost', `evil.example:${s.port}`, `genie.localhost.evil.example:${s.port}`, `x.genie.localhost:${s.port}`]) {
            const r = await get(s.port, '/index.html', host);
            expect(r.status, host).toBe(403);
            expect(r.body, host).toBe('');
        }
        // No Host at all, or an empty one: Node's own HTTP/1.1 check (400) or ours (403) — never the page.
        for (const host of ['', null]) {
            const r = await get(s.port, '/index.html', host);
            expect([400, 403], String(host)).toContain(r.status);
            expect(r.body, String(host)).toBe('');
        }
    });

    it('refuses traversal, listings, dotfiles, nesting and unknown types against real files that exist; a real asset is served', async () => {
        const { root, portFile } = renderer();
        const s = await start({ root, portFile });
        const host = `genie.localhost:${s.port}`;
        expect((await get(s.port, '/assets/Geist-Variable-x1.woff2', host)).status).toBe(200);
        for (const p of ['/../secret.js', '/../package.json', '/assets/../../secret.js', '/assets/..%2f..%2fsecret.js', '/assets/%2e%2e/%2e%2e/secret.js', '/assets/..\\..\\secret.js',
            '/assets/', '/assets', '/', '/assets/.hidden.js', '/assets/sub/nested.js', '/assets/notes.txt', '/mobile/icon-192.png', '/question.html/../../secret.js']) {
            const r = await get(s.port, p, host);
            expect(r.status, p).toBe(404);
            expect(r.body, p).not.toContain('SECRET');
        }
    });

    it('answers GET and HEAD only; a listed file the build did not make is a 404', async () => {
        const { root, portFile } = renderer();
        rmSync(join(root, 'doctor.html'));
        const s = await start({ root, portFile });
        const host = `genie.localhost:${s.port}`;
        const head = await get(s.port, '/question.html', host, 'HEAD');
        expect(head.status).toBe(200);
        expect(head.body).toBe('');
        for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
            const r = await get(s.port, '/index.html', host, m);
            expect(r.status, m).toBe(405);
            expect(r.headers['allow']).toBe('GET, HEAD');
        }
        expect((await get(s.port, '/doctor.html', host)).status).toBe(404);
    });
});

describe('the port: stable per install, moved only when it is taken', () => {
    it('the first start picks a port in the range and writes it under userData; the next start uses it again', async () => {
        const { root, portFile } = renderer();
        const first = await start({ root, portFile });
        expect(first.port).toBeGreaterThanOrEqual(WINDOW_PORT_RANGE[0]);
        expect(first.port).toBeLessThan(WINDOW_PORT_RANGE[1]);
        expect(JSON.parse(readFileSync(portFile, 'utf8'))).toEqual({ port: first.port });
        const port = first.port;
        await first.close();
        const again = await start({ root, portFile });
        expect(again.port).toBe(port);
    });

    it('a port something else holds is not used: Genie moves to another, says so, and keeps the new one', async () => {
        const { root, portFile } = renderer();
        const first = await start({ root, portFile });
        const taken = first.port;
        await first.close();
        const squatter = createServer((_q, res) => { res.end('NOT GENIE'); });
        plain.push(squatter);
        await new Promise<void>((r) => squatter.listen(taken, '127.0.0.1', () => r()));
        const lines: string[] = [];
        const moved = await start({ root, portFile, log: (l) => lines.push(l) });
        expect(moved.port).not.toBe(taken);
        expect(JSON.parse(readFileSync(portFile, 'utf8'))).toEqual({ port: moved.port });
        expect(lines.join('\n')).toContain(String(taken));
        // Genie's windows load from the port it bound, never from the squatter's.
        expect(moved.url('index')).toBe(`http://genie.localhost:${moved.port}/index.html`);
        expect((await get(moved.port, '/index.html', `genie.localhost:${moved.port}`)).body).toBe('<!doctype html><title>index</title>');
    });

    it('a port file that is not a port is ignored and rewritten', async () => {
        const { root, portFile } = renderer();
        for (const bad of ['not json', '{"port":"24000"}', '{"port":80}', '{"port":70000}', '{"port":24000.5}', '[]']) {
            mkdirSync(join(portFile, '..'), { recursive: true });
            writeFileSync(portFile, bad);
            const s = await start({ root, portFile });
            expect(s.port, bad).toBeGreaterThanOrEqual(WINDOW_PORT_RANGE[0]);
            expect(JSON.parse(readFileSync(portFile, 'utf8')), bad).toEqual({ port: s.port });
            await s.close();
        }
    });

    it('two Genies (two userData folders, as GENIE_E2E runs them) each get their own port and serve their own build', async () => {
        const a = renderer();
        const b = renderer();
        writeFileSync(join(b.root, 'index.html'), 'B');
        const sa = await start(a);
        const sb = await start(b);
        expect(sa.port).not.toBe(sb.port);
        expect((await get(sb.port, '/index.html', `genie.localhost:${sb.port}`)).body).toBe('B');
        // Each refuses the other's Host.
        expect((await get(sb.port, '/index.html', `genie.localhost:${sa.port}`)).status).toBe(403);
    });
});

describe('loading a window', () => {
    it('loads the page URL of the configured server into the window', async () => {
        const { root, portFile } = renderer();
        configureWindowPages({ root, portFile, retryDelayMs: 0 });
        const loaded: string[] = [];
        await loadWindowPage({ loadURL: async (url: string) => { loaded.push(url); } }, 'index', { hash: 'genie://flow/f1' });
        await loadWindowPage({ loadURL: async (url: string) => { loaded.push(url); } }, 'host-wait');
        const port = (JSON.parse(readFileSync(portFile, 'utf8')) as { port: number }).port;
        expect(loaded).toEqual([`http://genie.localhost:${port}/index.html#genie://flow/f1`, `http://genie.localhost:${port}/host-wait.html`]);
    });

    it('refuses to load anything before the server is configured', async () => {
        await expect(loadWindowPage({ loadURL: async () => {} }, 'index')).rejects.toThrow(/not configured/);
    });
});

describe('every window that loaded from disk now loads through loadWindowPage', () => {
    const src = (p: string) => readFileSync(new URL(`../src/main/${p}`, import.meta.url), 'utf8');
    it('no renderer page is loaded with loadFile anywhere in main', () => {
        const dir = new URL('../src/main/', import.meta.url);
        const offenders = readdirSync(dir).filter((f) => f.endsWith('.ts') && /\.loadFile\(/.test(readFileSync(new URL(f, dir), 'utf8')));
        expect(offenders).toEqual([]);
    });
    it('each page is loaded by the process that owns its window', () => {
        expect(src('main.ts').match(/loadWindowPage\(win\.webContents, 'index'/g)?.length).toBe(4);
        expect(src('main.ts')).toMatch(/loadWindowPage\(win\.webContents, 'host-wait'\)/);
        expect(src('doctor.ts')).toMatch(/loadWindowPage\(win\.webContents, 'doctor'\)/);
        expect(src('question-window-electron.ts')).toMatch(/loadWindowPage\(win\.webContents, 'question'\)/);
        expect(src('genie-browser-electron.ts')).toMatch(/loadWindowPage\(window\.webContents, 'browser', key\.startsWith\(SINGLE\) \? \{ search: 'single=1' \} : undefined\)/);
    });
    it('each of those processes configures the server with its own userData, before it opens a window', () => {
        for (const f of ['main.ts', 'doctor.ts', 'browser-process.ts']) expect(src(f), f).toMatch(/configureWindowPages\(\{ root: join\(here, '\.\.\/renderer'\), portFile: join\(app\.getPath\('userData'\), 'window-origin\.json'\)/);
    });
});

describe('the CI rows map a window frame to its built file', () => {
    it('file:// frames and http://genie.localhost asset frames inside dist; nothing else', async () => {
        const { builtFramePath } = await import('../scripts/built-frame-path.mjs');
        const root = temp();
        expect(builtFramePath('http://genie.localhost:24567/assets/index-AbC.js', root)).toBe(join(root, 'dist', 'renderer', 'assets', 'index-AbC.js'));
        expect(builtFramePath('http://genie.localhost:24567/assets/index-AbC.js?x#y', root)).toBe(join(root, 'dist', 'renderer', 'assets', 'index-AbC.js'));
        expect(builtFramePath(pathToFileURL(join(root, 'dist', 'main', 'main.js')).href, root)).toBe(join(root, 'dist', 'main', 'main.js'));
        for (const u of ['http://genie.localhost:24567/assets/../../x.js', 'http://genie.localhost:24567/index.html', 'http://evil.example/assets/a.js', pathToFileURL(join(root, 'elsewhere.js')).href, 'node:internal/x', undefined])
            expect(builtFramePath(u, root), String(u)).toBeNull();
    });
});

/** The real build, where the job built it first: every file the windows' pages can ask for is one the server hands out. */
const BUILT = new URL('../dist/renderer/', import.meta.url);
describe.runIf(existsSync(new URL('index.html', BUILT)))('the built renderer (dist/renderer)', () => {
    it('every page exists and every asset is served, but for the documents the sounds folder brings along', () => {
        const root = BUILT.pathname.replace(/^\/([A-Za-z]:)/, '$1');
        for (const page of WINDOW_PAGES) expect(existsSync(join(root, `${page}.html`)), page).toBe(true);
        const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
        const assets = walk(join(root, 'assets')).map((f) => `/${relative(root, f).split('\\').join('/')}`);
        expect(assets.filter((p) => p.endsWith('.js')).length).toBeGreaterThan(0);
        // `new URL(`./sounds/${file}`, import.meta.url)` (renderer/alert-sound.ts) makes Vite emit the whole sounds folder,
        // its CREDITS.md / README / licence too (measured: /assets/CREDITS-*.md, queue item 1113-174841-ee5dae). A sound is
        // always a sound file, so no page asks for those, and they stay unserved; anything else unserved fails here.
        const unserved = assets.filter((p) => windowFile(p) === null);
        expect(unserved.filter((p) => !/^\/assets\/(?:CREDITS|README|LICENSE[A-Za-z0-9-]*)-[A-Za-z0-9_-]+\.(?:md|txt)$/.test(p))).toEqual([]);
    });
});
