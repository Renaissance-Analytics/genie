#!/usr/bin/env node
/**
 * THE HOST DIRECTORY, PHOTOGRAPHED AND READ (Tynn #1058 L4; the client-no-host row). In a test VM only. The row starts the
 * installed genie-client with --remote-debugging-port=<port> and the environment the launcher hands it; this connects to
 * the directory's page ("Genie — hosts"), at 1280x800, and:
 *
 *   node scripts/host-directory-cdp.mjs <port> <out dir> <shot.png> [reload] [start]
 *     reload: read the page again first (the row has just changed what the directory reads, e.g. the paired hosts)
 *     start:  press the local host's Start after the picture, and wait for the directory to give way to the host's window
 *
 * Prints `ROWS <json>` (each row's id and state, the empty state's words), `SCREENSHOT <path>`, and
 * `### host-directory-cdp=PASS|FAIL <why>`; exits 1 on a failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, out, name, ...flags] = process.argv.slice(2);
if (!port || !out || !name) { console.error('usage: host-directory-cdp.mjs <port> <out dir> <shot.png> [reload] [start]'); process.exit(2); }
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (why) => { console.log(`### host-directory-cdp=FAIL ${why}`); process.exit(1); };
const WIDTH = 1280;
const HEIGHT = 800;

let target = null;
for (let i = 0; i < 240 && !target; i++) {
    try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && (t.url ?? '').includes('host-directory.html')) ?? null;
    } catch { /* not up yet */ }
    if (!target) await sleep(500);
}
if (!target) fail(`no host directory page on port ${port} within 120 s`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('the page\'s debugger did not open')); });
let next = 1;
const waiting = new Map();
ws.onmessage = (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)(v); waiting.delete(v.id); } };
ws.onclose = () => { for (const [, r] of waiting) r({ closed: true }); waiting.clear(); };
const call = (method, params = {}) => new Promise((res) => { const id = next++; waiting.set(id, res); try { ws.send(JSON.stringify({ id, method, params })); } catch { res({ closed: true }); } });
const js = async (expr) => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
if (flags.includes('reload')) { await call('Page.reload', { ignoreCache: true }); await sleep(1500); }
const read = () => js(`(() => {
    const root = document.querySelector('[data-host-directory]');
    if (!root) return null;
    return {
        empty: document.querySelector('[data-host-directory-empty]')?.textContent?.trim() ?? null,
        rows: [...document.querySelectorAll('[data-host-row]')].map((r) => ({ id: r.getAttribute('data-host-row'), state: r.getAttribute('data-host-state'), action: r.querySelector('button[data-action]')?.getAttribute('data-action') ?? null })),
        add: !!document.querySelector('button[data-action="add-host"]'),
        size: [innerWidth, innerHeight],
    };
})()`);
let seen = null;
for (let i = 0; i < 80 && !(seen = await read()); i++) await sleep(250);
if (!seen) fail('the directory never drew (no [data-host-directory])');
await sleep(800);
seen = await read();
console.log(`ROWS ${JSON.stringify(seen)}`);
if (seen.size[0] !== WIDTH || seen.size[1] !== HEIGHT) fail(`the page is ${seen.size.join('x')}, not ${WIDTH}x${HEIGHT}`);
const shot = await call('Page.captureScreenshot', { format: 'png' });
if (!shot.result?.data) fail(`no screenshot for ${name}`);
const path = join(out, name);
writeFileSync(path, Buffer.from(shot.result.data, 'base64'));
console.log(`SCREENSHOT ${path} (${WIDTH}x${HEIGHT})`);

if (flags.includes('start')) {
    if (!seen.rows.some((r) => r.id === 'local' && r.action === 'start')) fail(`no Start on the local host's row: ${JSON.stringify(seen.rows)}`);
    await js(`document.querySelector('[data-host-row="local"] button[data-action="start"]').click()`);
    // The directory goes when the launcher has started the host and the window links to it; a failure stays, in words.
    let gone = false;
    for (let i = 0; i < 360 && !gone; i++) {
        await sleep(250);
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            gone = !list.some((t) => t.id === target.id);
        } catch { /* the port goes with nothing else open: still gone from here */ }
        if (!gone) {
            const notice = await js(`document.querySelector('[data-host-directory-notice="failed"]')?.textContent ?? null`);
            if (notice) fail(`Start failed, in the directory's words: ${notice}`);
        }
    }
    if (!gone) fail('the directory was still open 90 s after Start');
    console.log('the directory gave way after Start');
}
console.log(`### host-directory-cdp=PASS ${name}: ${seen.empty ?? `${seen.rows.length} row(s)`}`);
try { ws.close(); } catch { /* gone */ }
process.exit(0);
