#!/usr/bin/env node
/**
 * PAIRING NEEDS ALLOW ON THE DESKTOP, AND A YELLOW ! BEFORE A PAIRING EXPIRES — driven live (genie#1366; the owner,
 * 2026-10-31, q_8c07b142). Run INSIDE omarchy-test by `scripts/mobile-proof/run.sh` with MOBILE_PROOF=confirm, never on
 * a desktop. run.sh seeded a paired device last seen 80 days ago (10 days left of its 90) before Genie started — the
 * "simulated time near expiry" — whose token this script knows.
 *
 *  1. Genie's rail: the yellow ! on Settings, and its tooltip naming that device and the date.
 *  2. Settings → Remote access: the same mark on the device's row, its tooltip, and Re-pair.
 *  3. A phone (Pixel 7 emulation) opens the QR's address: it waits for Allow; the desktop shows "Pair this device?" naming
 *     it — while the owner is typing in Genie, whose caret stays put. Allow → paired.
 *  4. Another phone: Deny → nothing paired, and the phone says it was denied.
 *  5. A third phone: nobody answers for two minutes → nothing paired, and the phone says so.
 *  6. The old device connects with its token: its 90 days start again, and the ! goes away.
 *
 * Every check is written to `mobile-evidence/confirm-checks.json`; a failed one fails the run.
 */
import { X509Certificate, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright-core';
import { answerPairOnDesktop, genieWindow, waitInGenie } from './genie-cdp.mjs';

const OUT = join(process.cwd(), 'mobile-evidence');
const IP = process.env.TAILNET_IP ?? '100.100.7.7';
const OLD_TOKEN = process.env.OLD_DEVICE_TOKEN ?? '';
const OLD_LABEL = process.env.OLD_DEVICE_LABEL ?? 'Pixel 6 (old)';
const DNS = 'omarchy-test.tailnet-proof.ts.net';
const PAGE = `https://${DNS}:7421/mobile`;
const CERT = join(homedir(), '.genie', 'runtime', 'mobile-tls', 'cert.pem');
mkdirSync(OUT, { recursive: true });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const act = (g, action) => g.evaluate(`window.genie.features.act(${JSON.stringify(action)}).then((d) => d.remote)`);
const snap = (g) => g.evaluate('window.genie.features.snapshot().then((d) => d.remote)');

/**
 * Genie's window, as the owner sees it: the SCREEN, from the compositor (grim), tooltips and all. CDP's
 * Page.captureScreenshot was tried first and never answered in this VM (2026-10-31, run 3: 30 s, idle lock already off)
 * — it waits for a frame from Chromium's Wayland surface; grim reads what Hyprland is showing.
 */
async function desktopShot(g, name) {
    const file = join(OUT, `${name}.png`);
    try {
        execFileSync('grim', [file], { timeout: 20_000 });
        console.log(`  screenshot ${name}.png (grim)`);
        return;
    } catch (error) {
        console.log(`  grim failed for ${name}: ${String(error?.message ?? error).split('\n')[0]}; trying CDP`);
    }
    return cdpShot(g, name);
}

async function cdpShot(g, name) {
    // A window that paints no frames (a locked or asleep session) never answers a screenshot: fail loud, not forever.
    const { data } = await Promise.race([
        g.send('Page.captureScreenshot', { format: 'png' }),
        sleep(30_000).then(() => { throw new Error(`no screenshot of Genie's window in 30 s (${name}): is the session locked or the display asleep?`); }),
    ]);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  screenshot ${name}.png`);
}

/** Move the mouse onto an element in Genie's window (a real hover: Genie's tooltip opens on it). */
async function hoverInGenie(g, selector) {
    const box = await g.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(600);
    return g.evaluate(`document.querySelector('[role="tooltip"]')?.textContent ?? null`);
}
async function unhover(g) { await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }); await sleep(300); }

async function phone(profile) {
    const spki = createHash('sha256').update(new X509Certificate(readFileSync(CERT)).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const context = await chromium.launchPersistentContext(profile, { ...devices['Pixel 7'], executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', `--host-resolver-rules=MAP ${DNS} ${IP}`, `--ignore-certificate-errors-spki-list=${spki}`] });
    const page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', (e) => console.log(`  [phone pageerror] ${e.message}`));
    globalThis.__phonePage = page;
    return { context, page };
}
const phoneShot = async (page, name) => { await page.screenshot({ path: join(OUT, `${name}.png`) }); console.log(`  screenshot ${name}.png`); };

async function main() {
    const g = await genieWindow();
    let remote = await act(g, { kind: 'settings.set', key: 'remote_access', value: true });
    for (let i = 0; i < 40 && !remote.url; i++) { await sleep(500); remote = await snap(g); }
    check('remote access listens on the tailnet name', remote.url === `wss://${DNS}:7421/genie`, `url=${remote.url}`);

    // A first run opens What's new over everything; close it as a person would, so the hovers reach the rail.
    await g.evaluate(`(async () => { for (let i = 0; i < 20; i++) { const d = document.querySelector('[data-whats-new]'); if (d) { const dlg = d.closest('[role="dialog"]') ?? document; const b = [...dlg.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Close'); if (b) { b.click(); return; } } await new Promise((r) => setTimeout(r, 250)); } })()`);
    await sleep(800);
    check('nothing covers Genie’s window (What’s new closed)', await g.evaluate(`!document.querySelector('[data-whats-new]')`));

    // 1. THE YELLOW ! ON SETTINGS — the seeded device has 10 of its 90 days left.
    const old = remote.devices.find((d) => d.label === OLD_LABEL);
    check('the seeded device is paired, expiring in about 10 days', old && Math.round((Date.parse(old.expiresAt) - Date.now()) / 86_400_000) === 10, old ? `expires ${old.expiresAt}` : 'not listed');
    await g.evaluate(`window.location.hash = 'genie://dashboard'`);
    const markLabel = await g.evaluate(`(async () => { for (let i = 0; i < 40; i++) { const m = document.querySelector('[data-nav="genie://settings"] [data-settings-alert]'); if (m) return m.getAttribute('aria-label'); await new Promise((r) => setTimeout(r, 250)); } return null; })()`);
    const expiryDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(old?.expiresAt ?? 0));
    check('a yellow ! is on the Settings row', markLabel !== null);
    await desktopShot(g, 'c01-settings-mark');
    const tip = await hoverInGenie(g, '[data-nav="genie://settings"] [data-settings-alert]');
    check('its tooltip names the device and the date it expires', tip !== null && tip.includes(OLD_LABEL) && tip.includes(expiryDate), tip ?? 'no tooltip');
    await desktopShot(g, 'c02-settings-tooltip');
    await unhover(g);

    // 2. THE DEVICE'S ROW in Settings → Remote access: the same mark, its tooltip, and Re-pair.
    await g.evaluate(`window.location.hash = 'genie://settings/remote'`);
    await waitInGenie(g, `[data-device="${old?.id}"] [data-device-expiry-alert]`);
    const rowTip = await hoverInGenie(g, `[data-device="${old?.id}"] [data-device-expiry-alert]`);
    check('the device’s row carries the same ! and tooltip', rowTip !== null && rowTip === tip, rowTip ?? 'no tooltip');
    check('the row offers Re-pair', await g.evaluate(`!!document.querySelector('[data-device="${old?.id}"] [data-action="repair-device"]')`));
    await g.evaluate(`document.querySelector('[data-device="${old?.id}"]').scrollIntoView({ block: 'center' })`);
    await sleep(300);
    await hoverInGenie(g, `[data-device="${old?.id}"] [data-device-expiry-alert]`);
    await desktopShot(g, 'c03-device-row-tooltip');
    await unhover(g);

    // 3. ALLOW. The owner is typing in Genie (the rail's filter) when the phone asks; the prompt must not take the caret.
    remote = await act(g, { kind: 'remote.issuePin' });
    await g.evaluate(`window.location.hash = 'genie://dashboard'`);
    await sleep(500);
    await g.evaluate(`(() => { const i = document.querySelector('[data-rail-filter]'); i.focus(); })()`);
    await g.send('Input.insertText', { text: 'tyn' });
    const a = await phone('/tmp/phone-allow');
    await a.page.goto(`${PAGE}#pin=${remote.pin.code}`);
    await a.page.waitForSelector('[data-mobile-waiting]', { timeout: 30_000 });
    const waitingWords = await a.page.textContent('[data-mobile-waiting]');
    check('the phone says it waits for Allow on the host, with the time left', /Press Allow on .+ to finish pairing · \d:\d\d left/.test(waitingWords ?? ''), waitingWords ?? '');
    await phoneShot(a.page, 'c04-phone-waiting');
    const prompt = await waitInGenie(g, '[data-pair-prompt]');
    check('the desktop asks "Pair this device?" naming the phone and where it connects from', prompt.includes('Pair this device?') && prompt.includes('Pixel 7') && /from \S+\./.test(prompt), prompt);
    check('…and nothing is paired yet', (await snap(g)).devices.every((d) => d.label !== 'Pixel 7'));
    const focus = await g.evaluate(`({ filter: document.activeElement?.matches?.('[data-rail-filter]') ?? false, value: document.querySelector('[data-rail-filter]').value })`);
    await g.send('Input.insertText', { text: 'n' });
    const typed = await g.evaluate(`document.querySelector('[data-rail-filter]').value`);
    check('the prompt did not take focus: the caret stayed in what the owner was typing, and typing went on there', focus.filter && typed === 'tynn', `active=${focus.filter} value=${typed}`);
    await desktopShot(g, 'c05-desktop-prompt');
    await answerPairOnDesktop(g, true);
    await waitInGenie(g, '[data-pair-outcome="allowed"]');
    await desktopShot(g, 'c06-desktop-allowed');
    await a.page.waitForSelector('[data-mobile="shell"]', { timeout: 30_000 });
    await phoneShot(a.page, 'c07-phone-paired');
    check('Allow paired the phone: it opened the dashboard, and Settings lists it', (await snap(g)).devices.some((d) => d.label === 'Pixel 7'));
    await a.context.close();

    // 4. DENY.
    const before = (await snap(g)).devices.length;
    remote = await act(g, { kind: 'remote.issuePin' });
    const d = await phone('/tmp/phone-deny');
    await d.page.goto(`${PAGE}#pin=${remote.pin.code}`);
    await d.page.waitForSelector('[data-mobile-waiting]', { timeout: 30_000 });
    // With a dialog open (What's new — found live in run 5 hiding the prompt under its backdrop), Deny is pressed with a
    // REAL mouse click at the button's place on screen: it lands only if nothing covers the prompt.
    await g.evaluate(`window.genie.features.act({ kind: 'whatsNew.show' })`).catch(() => {});
    const modalOpen = await g.evaluate(`(async () => { for (let i = 0; i < 20; i++) { if (document.querySelector('[data-whats-new]')) return true; await new Promise((r) => setTimeout(r, 250)); } return false; })()`);
    await waitInGenie(g, '[data-pair-prompt]');
    check('a dialog is open while the prompt is up (What’s new)', modalOpen);
    await desktopShot(g, 'c07b-desktop-prompt-over-dialog');
    const deny = await g.evaluate(`(() => { const r = document.querySelector('[data-action="deny-pair"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const onTop = await g.evaluate(`document.elementFromPoint(${deny.x}, ${deny.y})?.closest('[data-action="deny-pair"]') !== null`);
    check('Deny is the topmost thing at its own place on screen, over the dialog', onTop);
    await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: deny.x, y: deny.y });
    await g.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: deny.x, y: deny.y, button: 'left', clickCount: 1 });
    await g.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: deny.x, y: deny.y, button: 'left', clickCount: 1 });
    await waitInGenie(g, '[data-pair-outcome="denied"]');
    await desktopShot(g, 'c08-desktop-denied');
    await d.page.waitForSelector('[data-refusal]', { timeout: 30_000 });
    const denied = await d.page.textContent('[data-refusal]');
    check('Deny: the phone says it was denied', /Pairing was denied on .+\. Ask for a new PIN to try again\./.test(denied ?? ''), denied ?? '');
    await phoneShot(d.page, 'c09-phone-denied');
    check('Deny: nothing was paired', (await snap(g)).devices.length === before);
    await d.context.close();

    // 5. NO ANSWER for the PIN's two minutes.
    remote = await act(g, { kind: 'remote.issuePin' });
    const t = await phone('/tmp/phone-timeout');
    await t.page.goto(`${PAGE}#pin=${remote.pin.code}`);
    await t.page.waitForSelector('[data-mobile-waiting]', { timeout: 30_000 });
    await waitInGenie(g, '[data-pair-prompt]');
    await t.page.waitForSelector('[data-refusal]', { timeout: 150_000 });
    const lapsed = await t.page.textContent('[data-refusal]');
    check('No answer in two minutes: the phone says nobody pressed Allow', /Nobody pressed Allow on .+ within 2 minutes/.test(lapsed ?? ''), lapsed ?? '');
    await phoneShot(t.page, 'c10-phone-timed-out');
    await waitInGenie(g, '[data-pair-outcome="expired"]');
    await desktopShot(g, 'c11-desktop-timed-out');
    check('No answer: nothing was paired', (await snap(g)).devices.length === before);
    await t.context.close();

    // 6. RENEWAL: the old device connects with its token — its 90 days start again, and the ! goes away.
    const hello = await new Promise((resolve) => {
        const ws = new WebSocket(`wss://${IP}:7421/genie`);
        ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', auth: { kind: 'token', token: OLD_TOKEN }, label: OLD_LABEL, profile: 'mobile' }));
        ws.onmessage = (e) => { resolve(JSON.parse(String(e.data))); ws.close(); };
        ws.onerror = () => resolve({ kind: 'error' });
        setTimeout(() => resolve({ kind: 'timeout' }), 10_000);
    });
    check('the old device connected with its token (no PIN, no prompt)', hello.kind === 'welcome', JSON.stringify(hello).slice(0, 120));
    const renewed = (await snap(g)).devices.find((x) => x.label === OLD_LABEL);
    check('…which renewed it: 90 days from now', renewed && Math.round((Date.parse(renewed.expiresAt) - Date.now()) / 86_400_000) === 90, renewed?.expiresAt ?? 'gone');
    await g.evaluate(`window.location.hash = 'genie://dashboard'`);
    const cleared = await g.evaluate(`(async () => { for (let i = 0; i < 40; i++) { if (!document.querySelector('[data-settings-alert]')) return true; await new Promise((r) => setTimeout(r, 250)); } return false; })()`);
    check('the yellow ! went away: nothing is close to expiring', cleared);
    await desktopShot(g, 'c12-mark-cleared');
    g.close();
}

try {
    await main();
} catch (error) {
    check('the drive ran to the end', false, String(error?.stack ?? error));
    const page = globalThis.__phonePage;
    if (page) await page.screenshot({ path: join(OUT, 'zz-confirm-failure.png') }).catch(() => {});
}
writeFileSync(join(OUT, 'confirm-checks.json'), JSON.stringify(checks, null, 2));
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
