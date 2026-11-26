#!/usr/bin/env node
/**
 * THE LAUNCHER'S SETUP WINDOW, DRIVEN AND PHOTOGRAPHED (Tynn #1058 L3; the launcher-install row on Windows). In a test VM
 * only. The window is WebView2 (native/launcher/src/ui.rs); the row starts it with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>, and this connects to that page:
 *
 *   1. choose: the page as it opens -> <out>/launcher-setup-choose.png; then <profile> is chosen and Install pressed
 *   2. installing: the page while the ring and the bar move -> launcher-setup-installing.png
 *   3. ready -> launcher-setup-ready.png; then Open Genie pressed
 *
 *   node scripts/launcher-setup-cdp.mjs <port> <out dir> [both|client] [fail]
 *     fail: the packages are tampered (scripts/ci/tamper-package.mjs): Install is pressed, the failure screen is
 *     photographed (launcher-setup-failed.png) and checked (the failed step, plain words, Try again and Close), then Close
 * Prints `### setup-cdp=PASS|FAIL <why>`; exits 1 on a failure, with the page's own error words when it shows one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, out, profile = 'both', mode = 'ok'] = process.argv.slice(2);
if (!port || !out) { console.error('usage: launcher-setup-cdp.mjs <port> <out dir> [both|client]'); process.exit(2); }
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (why) => { console.log(`### setup-cdp=FAIL ${why}`); process.exit(1); };

let target = null;
for (let i = 0; i < 240 && !target; i++) {
    try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /Set up Genie/.test(t.title ?? '')) ?? null;
    } catch { /* not up yet */ }
    if (!target) await sleep(500);
}
if (!target) fail(`no "Set up Genie" page on port ${port} within 120 s`);
console.log(`the setup page: ${target.title} (${target.url.slice(0, 40)}...)`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('the page\'s debugger did not open')); });
let next = 1;
const waiting = new Map();
ws.onmessage = (m) => { const v = JSON.parse(String(m.data)); if (v.id && waiting.has(v.id)) { waiting.get(v.id)(v); waiting.delete(v.id); } };
const call = (method, params = {}) => new Promise((res) => { const id = next++; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) fail(`no screenshot for ${name}`);
    const path = join(out, name);
    writeFileSync(path, Buffer.from(r.result.data, 'base64'));
    console.log(`SCREENSHOT ${path}`);
};
const state = () => js('window.genieSetup ? window.genieSetup.state() : null');

for (let i = 0; i < 60 && !(await state()); i++) await sleep(250);
const s0 = await state();
if (!s0 || s0.screen !== 's-choose') fail(`the window did not open on the choice (it shows ${JSON.stringify(s0)})`);
await sleep(1500);
await shot('launcher-setup-choose.png');
if (profile === 'client') await js(`document.querySelector('[data-profile="client"]').click()`);
const chosen = await state();
if (chosen.profile !== profile) fail(`the choice is ${chosen.profile}, not ${profile}`);
await js(`document.getElementById('install').click()`);

if (mode === 'fail') {
    let s = null;
    for (let i = 0; i < 480 && !(s = await state())?.error; i++) await sleep(250);
    if (!s?.error) fail(`no failure shown within 2 minutes for a tampered package (last: ${JSON.stringify(s)})`);
    await sleep(1200);
    await shot('launcher-setup-failed.png');
    const seen = await js(`({ step: document.querySelector('#steps li.failed')?.textContent, words: document.getElementById('why').textContent,
        actions: [...document.querySelectorAll('#fail-actions .btn')].filter((b) => !b.hidden).map((b) => b.textContent),
        actionsShown: !document.getElementById('fail-actions').hidden, detail: document.getElementById('details').textContent })`);
    console.log(`the failure screen: ${JSON.stringify(seen)}`);
    if (!seen.step) fail('no step is marked failed');
    if (!/damaged/.test(seen.words)) fail(`the plain words are not the damaged-package words: ${seen.words}`);
    if (!seen.actionsShown || !seen.actions.includes('Try again') || !seen.actions.includes('Close')) fail(`no way forward: ${JSON.stringify(seen.actions)}`);
    if (!/do not match its signed manifest/.test(seen.detail)) fail('the launcher\'s own words are not under Show details');
    await js(`document.getElementById('fail-close').click()`);
    console.log('### setup-cdp=PASS the failure screen: the failed step marked, plain words, Try again and Close, the launcher\'s words under Show details');
    ws.close();
    process.exit(0);
}

let shotInstalling = false;
let last = null;
for (let i = 0; i < 1200; i++) {
    last = await state();
    if (last.error) { await shot('launcher-setup-failed.png'); fail(`the window says the install failed: ${last.error}`); }
    if (last.screen === 's-install' && !shotInstalling && last.percent >= 8) { await sleep(300); await shot('launcher-setup-installing.png'); shotInstalling = true; }
    if (last.screen === 's-ready') break;
    await sleep(250);
}
if (last?.screen !== 's-ready') fail(`no ready screen within 5 minutes (last: ${JSON.stringify(last)})`);
if (!shotInstalling) fail('the installing screen never showed with progress on it');
await sleep(1800);
await shot('launcher-setup-ready.png');
await js(`document.getElementById('open').click()`);
console.log(`### setup-cdp=PASS choose, installing and ready shown and photographed; ${profile} installed; Open Genie pressed`);
ws.close();
process.exit(0);
