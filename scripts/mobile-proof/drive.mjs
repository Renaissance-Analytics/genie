#!/usr/bin/env node
/**
 * THE PHONE, DRIVEN (genie#1346) — run INSIDE the test VM by `scripts/mobile-proof/run.sh`, never on a desktop.
 *
 * Genie runs in the VM bound to a tailnet address (a CGNAT IPv4 on the VM's loopback, with a `tailscale` on PATH that
 * reports it — the host's own `tailscale status --json` path, nothing in `src/` knows). This script:
 *
 *  1. over CDP into Genie's window: turns Remote access on and issues a PIN, as the owner would in Settings;
 *  2. in a Chromium with a PHONE's viewport, touch and user agent, opens `http://<tailnet ip>:7421/mobile#pin=…` — the
 *     address a phone on the tailnet would open — and walks the five surfaces, a screenshot for each:
 *     pick a workspace, the dashboard, an agent's chat, a message and its reply streaming in, a photo from the camera
 *     input attached to the chat (and the agent receiving it as a file), the file browser and viewer, uploads;
 *  3. drops the connection (Settings → Restart) and shows the phone reconnecting on its own and resuming;
 *  4. removes the device in Settings and shows the phone sent back to pairing.
 *
 * Every check is written to `mobile-evidence/checks.json`; a failed one fails the run.
 */
import { X509Certificate, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright-core';

const OUT = join(process.cwd(), 'mobile-evidence');
const WS_DIR = process.env.MOBILE_WS ?? '';
const IP = process.env.TAILNET_IP ?? '100.100.7.7';
// A Tailscale cert names the MagicDNS name, never the raw 100.x address: the phone opens the name (genie#1346 PWA).
const DNS = 'omarchy-test.tailnet-proof.ts.net';
const PAGE = `https://${DNS}:7421/mobile`;
const CERT = join(homedir(), '.genie', 'runtime', 'mobile-tls', 'cert.pem');
const ATLAS = `agent_${'a1b2c3d4'.repeat(4)}`;
const RECEIVED = '/tmp/genie-stub-claude-received';
mkdirSync(OUT, { recursive: true });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A minimal CDP client into Genie's main window. */
async function genieWindow() {
    for (let i = 0; i < 120; i++) {
        try {
            const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
            const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url) && !/[?&](remote|view)=/.test(t.url));
            if (page) {
                const ws = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
                let id = 0;
                const waiting = new Map();
                ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); waiting.get(m.id)?.(m); waiting.delete(m.id); };
                const evaluate = (expression) => new Promise((resolve, reject) => {
                    const n = ++id;
                    waiting.set(n, (m) => (m.result?.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description ?? 'eval failed')) : resolve(m.result?.result?.value)));
                    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
                });
                // Wait until the preload bridge is there.
                for (let j = 0; j < 60; j++) { if (await evaluate('typeof window.genie?.features?.act === "function"')) return { evaluate, close: () => ws.close() }; await sleep(500); }
            }
        } catch { /* not up yet */ }
        await sleep(1000);
    }
    throw new Error('Genie’s window never answered on CDP 9222');
}

const act = (g, action) => g.evaluate(`window.genie.features.act(${JSON.stringify(action)}).then((d) => d.remote)`);

/** A photo-like JPEG made in a page: noisy gradients, so it does not compress to nothing. */
async function makeJpeg(page, width, height, quality) {
    const b64 = await page.evaluate(async ({ width, height, quality }) => {
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        const x = c.getContext('2d');
        const g = x.createLinearGradient(0, 0, width, height);
        g.addColorStop(0, '#2b5876'); g.addColorStop(1, '#f4a259');
        x.fillStyle = g; x.fillRect(0, 0, width, height);
        const img = x.getImageData(0, 0, width, height);
        for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 90; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
        x.putImageData(img, 0, 0);
        x.fillStyle = '#fff'; x.font = `${Math.round(height / 8)}px sans-serif`; x.fillText('Genie phone proof', width / 10, height / 2);
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
    }, { width, height, quality });
    return Buffer.from(b64, 'base64');
}

const shot = async (page, name) => { await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false }); console.log(`  screenshot ${name}.png`); };

async function main() {
    const g = await genieWindow();
    let remote = await act(g, { kind: 'settings.set', key: 'remote_access', value: true });
    for (let i = 0; i < 40 && !remote.url; i++) { await sleep(500); remote = await g.evaluate('window.genie.features.snapshot().then((d) => d.remote)'); }
    check('remote access listens on the tailnet name over HTTPS (wss), with the cert `tailscale cert` issued', remote.url === `wss://${DNS}:7421/genie`, `url=${remote.url} unavailable=${remote.unavailable}`);
    remote = await act(g, { kind: 'remote.issuePin' });
    const pin = remote.pin?.code;
    check('a PIN is issued on the host’s screen', /^\d{6}$/.test(pin ?? ''), `pin=${pin ? '******' : 'none'}`);

    // The phone's browser trusts the tailnet cert the way a real one trusts Let's Encrypt's: here, by its key (the VM's fake
    // `tailscale cert` is self-signed), and resolves the MagicDNS name to the tailnet address as MagicDNS would.
    const spki = createHash('sha256').update(new X509Certificate(readFileSync(CERT)).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', `--host-resolver-rules=MAP ${DNS} ${IP}`, `--ignore-certificate-errors-spki-list=${spki}`] });
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    await context.addInitScript(() => { window.addEventListener('beforeinstallprompt', () => { window.__installPrompt = true; }); });
    const page = await context.newPage();
    const frames = { sent: [], received: [] };
    page.on('websocket', (ws) => {
        ws.on('framesent', (f) => frames.sent.push(typeof f.payload === 'string' ? f.payload.length : 0));
        ws.on('framereceived', (f) => frames.received.push({ size: typeof f.payload === 'string' ? f.payload.length : 0, text: typeof f.payload === 'string' ? f.payload.slice(0, 200) : '' }));
    });
    page.on('console', (m) => { if (m.type() === 'error') console.log(`  [phone console] ${m.text()}`); });
    page.on('pageerror', (e) => console.log(`  [phone pageerror] ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400) console.log(`  [phone ${r.status()}] ${r.url()}`); });
    page.on('requestfailed', (r) => console.log(`  [phone request failed] ${r.url()} ${r.failure()?.errorText ?? ''}`));
    globalThis.__phonePage = page;

    // 0. Without the PIN the page asks for one — the socket is never open without pairing.
    await page.goto(PAGE);
    await page.waitForSelector('[data-mobile="pair"]', { timeout: 30_000 });
    await shot(page, '00-pair');
    check('the page without a PIN shows the pairing form', true);

    // 1–2. Pair with the PIN in the QR's hash: the dashboard, then pick a workspace.
    // A scanned QR opens a FRESH page; a hash-only goto on the open page would not reload it.
    await page.goto("about:blank");
    await page.goto(`${PAGE}#pin=${pin}`);
    await page.waitForSelector('[data-mobile="shell"] [data-mobile-agent]', { timeout: 30_000 });
    await shot(page, '01-dashboard');
    check('paired: the dashboard shows the agents with their state', await page.locator('[data-mobile-agent]').count() >= 2);
    await page.tap('[data-mobile-ws="tynn"]');
    await page.waitForSelector('[data-mobile-ws="tynn"][data-selected="true"]');
    await shot(page, '02-workspace-selected');
    check('picking a workspace narrows the dashboard and offers its Files', await page.locator('[data-action="open-files"]').count() === 1);

    // THE INSTALLABLE APP: a secure context, this host's manifest, the app-shell worker, Chromium's own installability verdict.
    const cdp = await context.newCDPSession(page);
    check('the page is a secure context (HTTPS on the tailnet name)', await page.evaluate(() => window.isSecureContext));
    const manifest = await cdp.send('Page.getAppManifest');
    const parsed = JSON.parse(manifest.data || '{}');
    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ url: manifest.url, errors: manifest.errors, manifest: parsed }, null, 2));
    check('the manifest is this host’s: named after it, standalone, with a maskable icon', manifest.errors.length === 0 && parsed.name === 'Genie — omarchy-test' && parsed.display === 'standalone' && parsed.icons?.some((i) => i.purpose === 'maskable'), `${parsed.name} · ${parsed.display} · errors ${JSON.stringify(manifest.errors)}`);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null || navigator.serviceWorker?.ready, null, { timeout: 20_000 }).catch(() => {});
    const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, state: r.active?.state ?? null }; });
    check('the app-shell service worker is active for /mobile', sw.state === 'activated' && sw.scope.endsWith('/mobile'), JSON.stringify(sw));
    let installability = await cdp.send('Page.getInstallabilityErrors');
    for (let i = 0; i < 10 && installability.installabilityErrors.length > 0; i++) { await sleep(1000); installability = await cdp.send('Page.getInstallabilityErrors'); }
    writeFileSync(join(OUT, 'installability.json'), JSON.stringify(installability, null, 2));
    check('Chromium says the app is INSTALLABLE (Page.getInstallabilityErrors is empty)', installability.installabilityErrors.length === 0, JSON.stringify(installability.installabilityErrors));
    await page.reload();
    await page.waitForSelector('[data-mobile="shell"] [data-mobile-agent]', { timeout: 30_000 });
    check('beforeinstallprompt fired (the browser offers Install / Add to Home Screen)', await page.evaluate(() => window.__installPrompt === true), 'headless Chromium may withhold it; the installability verdict above is the gate');
    await shot(page, '02b-installable');

    // 3. An agent's chat. Start it when it is not running.
    await page.tap(`[data-mobile-agent="${ATLAS}"]`);
    await page.waitForSelector(`[data-mobile-agent-view="${ATLAS}"]`, { timeout: 20_000 });
    if (await page.locator('[data-action="start-agent"]').count()) await page.tap('[data-action="start-agent"]');
    await page.waitForSelector('[data-mobile-composer]', { timeout: 60_000 });
    await shot(page, '03-agent-chat');
    check('the agent’s chat opens with a composer (camera, gallery, file)', await page.locator('[data-attach="camera"]').count() === 1 && await page.locator('[data-attach="gallery"]').count() === 1);

    // 4. A message, and the reply streaming in.
    const receivedBefore = frames.received.length;
    await page.fill('textarea[name="text"]', 'Hello from the phone — what is the plan?');
    await page.tap('[data-action="send-prompt"]');
    await page.waitForSelector('[data-mobile-row] >> text=Got it', { timeout: 30_000 });
    await shot(page, '04-reply-streaming');
    await page.waitForSelector('[data-mobile-row] >> text=a few words at a time.', { timeout: 30_000 });
    await shot(page, '05-reply-done');
    const agentFrames = frames.received.slice(receivedBefore).filter((f) => f.text.includes('"channel":"agent:'));
    const terminalFrames = frames.received.filter((f) => f.text.includes('terminal-data') || f.text.includes('"channel":"features"'));
    check('the reply streamed as several pushes', agentFrames.length >= 3, `${agentFrames.length} agent pushes`);
    check('the pushes are patches, not the whole ledger', agentFrames.filter((f) => f.size > 20_000).length === 0, `largest ${Math.max(0, ...agentFrames.map((f) => f.size))} chars`);
    check('the phone received no terminal bytes and no feature pushes', terminalFrames.length === 0, `${terminalFrames.length} such frames`);

    // 5. A photo from the CAMERA input, attached to the chat: the agent receives it as a file.
    const photo = await makeJpeg(page, 4032, 3024, 0.92);
    writeFileSync(join(OUT, 'camera-photo.jpg'), photo);
    await page.setInputFiles('[data-attach="camera"]', { name: 'IMG_20261030_1200.jpg', mimeType: 'image/jpeg', buffer: photo });
    await page.waitForSelector('[data-pending-attachment]');
    await page.fill('textarea[name="text"]', 'What is in this photo?');
    await shot(page, '06-photo-attached');
    await page.tap('[data-action="send-prompt"]');
    await page.waitForSelector('[data-mobile-row] >> text=I received 1 image file', { timeout: 60_000 });
    await page.waitForSelector('[data-mobile-row] >> text=I received 1 image file >> xpath=.. >> text=a few words at a time.', { timeout: 30_000 }).catch(() => {});
    await sleep(1500);
    await shot(page, '07-photo-received');
    const got = existsSync(RECEIVED) ? readdirSync(RECEIVED) : [];
    const file = got[0] ? readFileSync(join(RECEIVED, got[0])) : null;
    check(`the camera photo (${(photo.byteLength / 1048576).toFixed(1)} MB, more than one 1 MiB frame) reached the agent as an image file`, file !== null && file[0] === 0xff && file[1] === 0xd8, file ? `${got[0]}, ${file.byteLength} bytes` : 'nothing received');
    check('the largest frame the phone sent stayed under the 1 MiB cap', Math.max(0, ...frames.sent) < 1024 * 1024, `largest ${Math.max(0, ...frames.sent)} chars`);

    // 6. The file browser and viewer (an image for the preview, made like the photos above).
    writeFileSync(join(WS_DIR, 'images', 'proof.jpg'), await makeJpeg(page, 800, 600, 0.85));
    await page.goBack();
    await page.waitForSelector('[data-mobile="shell"]');
    if (await page.locator('[data-action="open-files"]').count() === 0) await page.tap('[data-mobile-ws="tynn"]');
    await page.tap('[data-action="open-files"]');
    await page.waitForSelector('[data-mobile-files=""] [data-file-entry]');
    await shot(page, '08-files');
    await page.tap('[data-file-entry="README.md"]');
    await page.waitForSelector('[data-preview="markdown"]');
    await shot(page, '09-markdown');
    check('markdown is rendered', await page.locator('[data-preview="markdown"] strong').count() >= 1);
    await page.goBack();
    await page.tap('[data-file-entry="src"]');
    await page.tap('[data-file-entry="src/app.ts"]');
    await page.waitForSelector('[data-preview="text"]');
    await shot(page, '10-code');
    await page.goBack();
    await page.goBack();
    await page.tap('[data-file-entry="images"]');
    await page.tap('[data-file-entry="images/proof.jpg"]');
    await page.waitForSelector('[data-preview="image"]');
    await page.waitForFunction(() => { const i = document.querySelector('[data-preview="image"]'); return i && i.complete && i.naturalWidth > 0; });
    await shot(page, '11-image');
    check('an image previews as an image', true);
    await page.goBack();
    await page.goBack();
    await page.tap('[data-file-entry="spec.pdf"]');
    await page.waitForSelector('[data-action="open-pdf"]');
    await shot(page, '12-pdf');
    check('a PDF is offered to open in the phone’s viewer', await page.locator('[data-action="open-pdf"]').getAttribute('href').then((h) => h?.startsWith('blob:')));
    await page.goBack();

    // 7. Upload into a folder: a 2.6 MB photo (chunks) and a text file; and a photo from the camera input.
    await page.tap('[data-file-entry="docs"]');
    await page.waitForSelector('[data-mobile-files="docs"]');
    const big = await makeJpeg(page, 3000, 2250, 0.97);
    await page.setInputFiles('[data-action="upload"]', [{ name: 'site-photo.jpg', mimeType: 'image/jpeg', buffer: big }, { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('written on the phone\n') }]);
    await page.waitForSelector('[data-upload-outcome] >> text=Uploaded', { timeout: 60_000 });
    await shot(page, '13-uploaded');
    const landed = join(WS_DIR, 'docs', 'site-photo.jpg');
    const same = existsSync(landed) && createHash('sha256').update(readFileSync(landed)).digest('hex') === createHash('sha256').update(big).digest('hex');
    check(`a ${(big.byteLength / 1048576).toFixed(1)} MB upload landed in the workspace byte for byte`, same, landed);
    await page.setInputFiles('[data-action="upload-photo"]', { name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: photo });
    await page.waitForSelector('[data-upload-outcome] >> text=IMG_0002.jpg', { timeout: 60_000 });
    await shot(page, '14-photo-uploaded');
    check('Take photo uploads into the folder', existsSync(join(WS_DIR, 'docs', 'IMG_0002.jpg')));

    // 7b. Only the app shell is cached: no socket, no data, no token.
    const cached = await page.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
    writeFileSync(join(OUT, 'sw-cache.json'), JSON.stringify(cached, null, 2));
    check('the service worker cached the app shell only (page, hashed assets, icons)', cached.length > 0 && cached.every((p) => p === '/mobile' || /^\/(mobile\/)?assets\//.test(p) || /^\/mobile\/.*\.png$/.test(p)), `${cached.length} entries`);

    // 7c. Reopened from the home screen with the host unreachable: the cached shell says Connecting — no stale agents
    // dressed as live — and when the network is back it connects by itself with its token, no PIN.
    await context.setOffline(true);
    await page.goto(PAGE).catch(() => {});
    await page.waitForSelector('[data-mobile="connecting"]', { timeout: 20_000 }).catch(() => {});
    await shot(page, '14b-reopened-offline');
    check('reopened offline: the cached shell shows Connecting, and no agent data', await page.locator('[data-mobile="connecting"]').count() === 1 && await page.locator('[data-mobile-agent]').count() === 0);
    await context.setOffline(false);
    await page.waitForSelector('[data-mobile="shell"] [data-mobile-agent]', { timeout: 60_000 });
    await shot(page, '14c-reopened-online');
    check('back online: it reconnected by itself with its token, no PIN asked', await page.locator('[data-mobile="pair"]').count() === 0);

    // 8. The connection drops (Settings → Restart): the phone says Reconnecting and comes back on its own, resuming.
    await page.goto(`${PAGE}#agent=${ATLAS}`);
    await page.waitForSelector('[data-mobile-row] >> text=I received 1 image file', { timeout: 30_000 });
    const before = frames.received.length;
    await act(g, { kind: 'remote.restart' });
    await page.waitForSelector('[data-mobile-reconnecting]', { timeout: 15_000 }).then(() => shot(page, '15-reconnecting')).catch(() => {});
    await page.waitForSelector('[data-mobile-reconnecting]', { state: 'detached', timeout: 60_000 });
    await shot(page, '16-reconnected');
    const resumed = frames.received.slice(before).filter((f) => f.text.includes('"base":"resume"'));
    check('after the drop the phone reconnected on its own, without the PIN', await page.locator('[data-mobile="pair"]').count() === 0);
    check('the chat resumed from its cursor (base "resume"), not a full replay', resumed.length >= 1, `${resumed.length} resume answers`);

    // 9. Removing the device in Settings ends the phone's session at once.
    const devicesNow = (await g.evaluate('window.genie.features.snapshot().then((d) => d.remote.devices)'));
    check('the paired phone is listed in Settings', devicesNow.length >= 1, devicesNow.map((d) => d.label).join(', '));
    await act(g, { kind: 'remote.revokeDevice', deviceId: devicesNow[0].id });
    await page.waitForSelector('[data-mobile="pair"]', { timeout: 30_000 });
    await shot(page, '17-device-removed');
    check('removing the device sends the phone back to pairing', true);

    await browser.close();
    g.close();
}

try {
    await main();
} catch (error) {
    check('the drive ran to the end', false, String(error?.stack ?? error));
    const page = globalThis.__phonePage;
    if (page) {
        await page.screenshot({ path: join(OUT, 'zz-failure.png') }).catch(() => {});
        const dom = await page.evaluate(() => `${location.href}\n${document.documentElement.outerHTML.slice(0, 4000)}`).catch((e) => String(e));
        writeFileSync(join(OUT, 'zz-failure-dom.txt'), dom);
        console.log(`  [failure DOM] ${dom.slice(0, 1500)}`);
    }
}
writeFileSync(join(OUT, 'checks.json'), JSON.stringify(checks, null, 2));
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
