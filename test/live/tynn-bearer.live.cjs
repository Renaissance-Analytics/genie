// VM-only Electron/HTTP proof. Bundle tynn-account.ts to GENIE_TYNN_ACCOUNT_BUNDLE before running.
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { app, session, safeStorage } = require('electron');
if (process.env.GENIE_TEST_VM !== '1') throw new Error('This probe runs only in the isolated test VM');
const { TynnAccount } = require(process.env.GENIE_TYNN_ACCOUNT_BUNDLE);

const CODE = 'x'.repeat(64);
const TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'3'.repeat(64)}`;
const SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];
const USER = { id: '42', name: 'VM fixture', email: 'fixture@example.invalid' };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const stop = (server) => new Promise((resolve) => server.close(resolve));

async function run() {
    await app.whenReady();
    const dir = await mkdtemp(join(tmpdir(), 'genie-tynn-http-'));
    let live = false;
    let exchanges = 0;
    let redirects = 0;
    let redirectTarget = '';
    const seen = [];
    const target = createServer((_req, res) => { redirects++; res.end('{}'); });
    const server = createServer((req, res) => {
        seen.push({ path: req.url, cookie: req.headers.cookie, bearer: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json');
        const reply = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
        const bearer = req.headers.authorization === `Bearer ${TOKEN}` && live;
        if (req.url === '/api/v1/me' && !req.headers.authorization && req.headers.cookie?.includes(`genie_token=${CODE}`)) {
            live = true; exchanges++;
            res.setHeader('Set-Cookie', 'legacy_session=exchange; Path=/; HttpOnly');
            return reply(200, { ...USER, pairing_token: TOKEN, pairing_scopes: SCOPES });
        }
        if (req.url === '/api/v1/me') return reply(bearer ? 200 : 404, bearer ? USER : {});
        if (!bearer) return reply(404, {});
        if (req.url === '/api/v1/redirect') { res.writeHead(307, { Location: redirectTarget }); return res.end(); }
        if (req.url === '/api/v1/pairing-token' && req.method === 'DELETE') { live = false; return reply(200, { revoked: true }); }
        return reply(200, { data: [] });
    });
    try {
        await listen(target); await listen(server);
        const host = `http://127.0.0.1:${server.address().port}`;
        redirectTarget = `http://127.0.0.1:${target.address().port}/target`;
        const ses = session.fromPartition(`tynn-live-${Date.now()}`);
        const secure = safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()));
        // Cookie/redirect semantics can be proved even on a VM without an unlocked Linux keychain. That branch uses
        // an explicit fake cipher, and reports it; the production main-process port refuses such a keychain.
        const cipher = secure ? {
            isAvailable: () => true, encrypt: (text) => safeStorage.encryptString(text), decrypt: (bytes) => safeStorage.decryptString(bytes),
        } : { isAvailable: () => true, encrypt: (text) => Buffer.from(`fixture:${text}`), decrypt: (bytes) => bytes.toString().slice(8) };
        const ports = {
            host: () => host, file: join(dir, 'tynn.json'), cipher,
            cookies: {
                set: (url, name, value) => ses.cookies.set({ url, name, value, path: '/' }),
                get: async (url, name) => (await ses.cookies.get({ url, name }))[0]?.value ?? null,
                clear: async (url) => { for (const cookie of await ses.cookies.get({ url })) await ses.cookies.remove(url, cookie.name); },
            },
            fetch: (url, init) => ses.fetch(url, process.env.GENIE_TEST_BYPASS_BEARER_OMIT === '1' && init.headers.Authorization ? { ...init, credentials: 'include' } : init),
        };
        const account = await TynnAccount.open(ports);
        assert.equal((await account.signIn(CODE)).ok, true, 'real session exchanges the handoff code');
        assert.equal(exchanges, 1);
        assert.equal((await ses.cookies.get({ url: host })).length, 0, 'exchange cookies cleared');
        assert.equal((await readFile(ports.file, 'utf8')).includes(TOKEN), false, 'credential is never plaintext on disk');
        await ses.cookies.set({ url: host, name: 'legacy_session', value: 'poison', path: '/' });
        await ses.fetch(`${host}/api/v1/projects`, { credentials: 'include' });
        assert.match(seen.at(-1).cookie ?? '', /legacy_session=poison/, 'positive control: Electron really sends this cookie');
        await account.request('/api/v1/projects', { method: 'POST', body: { name: 'VM fixture' } });
        assert.equal(seen.at(-1).bearer, `Bearer ${TOKEN}`);
        assert.equal(seen.at(-1).cookie, undefined, 'ordinary API request has no Cookie header');
        const restored = await TynnAccount.open(ports);
        assert.equal(restored.status().signedIn, true, 'encrypted credential restores without another code');
        assert.equal(exchanges, 1);
        await ses.fetch(redirectTarget);
        assert.equal(redirects, 1, 'positive control: redirect target is reachable'); redirects = 0;
        await assert.rejects(account.request('/api/v1/redirect', { method: 'POST' }), /could not be reached/);
        assert.equal(seen.at(-1).path, '/api/v1/redirect', 'the real API received the redirecting request');
        assert.equal(redirects, 0, 'scoped credential never follows a redirect');
        assert.deepEqual(await account.signOut(), { ok: true, revoked: true });
        assert.equal(live, false);
        assert.equal((await TynnAccount.open(ports)).status().signedIn, false);
        console.log(`PASS Electron HTTP bearer/cookie/redirect/restart/revoke proof; cipher=${secure ? 'OS safeStorage' : 'explicit VM fake (no OS-encryption claim)'}`);
    } finally { await Promise.all([stop(server), stop(target)]); await rm(dir, { recursive: true, force: true }); }
}
run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
