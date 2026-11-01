#!/usr/bin/env node
/**
 * THE PHONE SCROLLS (the owner, 2026-11-01, beta.55 over Tailscale: "it won't scroll at all so I am stuck") — run INSIDE
 * the test VM by `MOBILE_PROOF=scroll scripts/mobile-proof/run.sh`, never on a desktop.
 *
 * For each phone profile (iPhone 13 and Pixel 7: viewport, device scale, touch, mobile UA — in Chromium; the VM has no
 * WebKit, so iOS Safari itself is NOT exercised here) it pairs with the host as drive.mjs does, then on every screen —
 * pairing, dashboard, agent chat, files list, file viewer (markdown and code) — it:
 *
 *  1. picks a TARGET below the fold (the last agent row, the last chat row, the last file, the end of the file) and
 *     records that it is below the fold: the positive control that there IS something to scroll to;
 *  2. scrolls with a real TOUCH gesture (CDP Input.synthesizeScrollGesture, gestureSourceType touch — the compositor's
 *     own touch-scroll path, momentum included) and measures the target's position before and after;
 *  3. keeps swiping until the target is on screen, or gives up after 12 swipes.
 *
 * The gauge is the target's on-screen position, not any one element's scrollTop, so it reads the same on the code
 * before the fix (where nothing scrolls) and after it — run it against the pre-fix commit for the red half.
 *
 * Every check goes to `mobile-evidence/scroll-checks.json`, with before/after screenshots; a failed check fails the run.
 * Informational lines (computed styles, the pull-at-the-top probe) are recorded as `note`, never as a pass.
 */
import { X509Certificate, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright-core';
import { answerPairOnDesktop, genieWindow } from './genie-cdp.mjs';

const OUT = join(process.cwd(), 'mobile-evidence', 'scroll');
const IP = process.env.TAILNET_IP ?? '100.100.7.7';
const DNS = 'omarchy-test.tailnet-proof.ts.net';
const PAGE = `https://${DNS}:7421/mobile`;
const CERT = join(homedir(), '.genie', 'runtime', 'mobile-tls', 'cert.pem');
const ATLAS = `agent_${'a1b2c3d4'.repeat(4)}`;
mkdirSync(OUT, { recursive: true });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const note = (name, detail) => { checks.push({ name, note: true, detail }); console.log(`NOTE ${name} — ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const act = (g, action) => g.call((a) => window.genie.features.act(a).then((d) => d.remote), action);

/** Where the target is on screen, the viewport, the document's own scroll, and the scroller's computed style (if any). */
const measure = (page, target) => page.evaluate((sel) => {
    const els = document.querySelectorAll(sel);
    const el = els[els.length - 1];
    const sc = document.querySelector('[data-mobile-scroll]');
    const cs = sc ? getComputedStyle(sc) : null;
    return {
        found: !!el,
        top: el ? el.getBoundingClientRect().top : null,
        bottom: el ? el.getBoundingClientRect().bottom : null,
        vh: window.innerHeight,
        docScroll: document.scrollingElement ? document.scrollingElement.scrollTop : null,
        scroller: sc ? { scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, overflowY: cs.overflowY, overscrollY: cs.overscrollBehaviorY, touchAction: cs.touchAction } : null,
    };
}, target);

/** One upward swipe (content moves up) from 70% to 30% of the screen, through the compositor's touch path. */
async function swipe(cdp, vw, vh, dy = -Math.round(vh * 0.4)) {
    await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(vw / 2), y: Math.round(vh * (dy < 0 ? 0.7 : 0.3)), yDistance: dy, xDistance: 0, gestureSourceType: 'touch', speed: 1200, preventFling: false });
    await sleep(700); // let the fling (momentum) settle
}

/** The whole proof for one screen: below the fold first (control), one swipe moves it, more swipes reach it. */
async function proveScreen(page, cdp, profile, screen, target) {
    const vp = page.viewportSize();
    await page.waitForSelector(target, { timeout: 30_000 });
    await sleep(500);
    const before = await measure(page, target);
    await page.screenshot({ path: join(OUT, `${profile}-${screen}-0-before.png`) });
    note(`${profile} ${screen}: layout`, JSON.stringify({ vh: before.vh, scroller: before.scroller, docScroll: before.docScroll }));
    const below = before.found && before.top > before.vh;
    check(`${profile} ${screen}: control — the target (${target}) starts below the fold, so there is something to scroll to`, below, `target top ${before.top?.toFixed(0)} vs viewport ${before.vh}`);
    if (!below) return;
    await swipe(cdp, vp.width, vp.height);
    const after = await measure(page, target);
    await page.screenshot({ path: join(OUT, `${profile}-${screen}-1-after-one-swipe.png`) });
    const moved = before.top - after.top;
    check(`${profile} ${screen}: one touch swipe scrolls the content`, moved > 100, `target moved up ${moved.toFixed(0)} px; scroller scrollTop ${before.scroller?.scrollTop ?? '-'} → ${after.scroller?.scrollTop ?? '-'}; document scrollTop ${before.docScroll} → ${after.docScroll}`);
    let last = after;
    for (let i = 0; i < 12 && last.bottom > last.vh; i++) { await swipe(cdp, vp.width, vp.height); last = await measure(page, target); }
    await page.screenshot({ path: join(OUT, `${profile}-${screen}-2-reached.png`) });
    check(`${profile} ${screen}: swiping reaches the last of it`, last.bottom <= last.vh + 1, `target bottom ${last.bottom?.toFixed(0)} vs viewport ${last.vh}`);
    check(`${profile} ${screen}: the page itself did not scroll (the screen owns its scroll; the bars stay put)`, (last.docScroll ?? 0) === 0, `document scrollTop ${last.docScroll}`);
    // Back to the top, then pull down once more: headless Chromium has no pull-to-refresh UI, so this records that the
    // pull is absorbed with no reload — informational, not proof of a real phone's behaviour.
    for (let i = 0; i < 14; i++) await swipe(cdp, vp.width, vp.height, Math.round(vp.height * 0.4));
    await page.evaluate(() => { window.__stillHere = true; });
    await swipe(cdp, vp.width, vp.height, Math.round(vp.height * 0.4));
    note(`${profile} ${screen}: a pull at the top`, (await page.evaluate(() => window.__stillHere === true)) ? 'absorbed, no reload' : 'the page RELOADED');
}

async function runProfile(g, profile, device) {
    let remote = await act(g, { kind: 'remote.issuePin' });
    const pin = remote.pin?.code;
    check(`${profile}: a PIN is issued`, /^\d{6}$/.test(pin ?? ''));
    const spki = createHash('sha256').update(new X509Certificate(readFileSync(CERT)).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const dir = `/tmp/phone-scroll-${profile}`;
    rmSync(dir, { recursive: true, force: true });
    // `devices['iPhone 13']` names WebKit as its browser; its viewport, scale, touch and UA are used here in Chromium.
    const { defaultBrowserType: _b, ...emulation } = device;
    const context = await chromium.launchPersistentContext(dir, { ...emulation, executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', `--host-resolver-rules=MAP ${DNS} ${IP}`, `--ignore-certificate-errors-spki-list=${spki}`] });
    const page = context.pages()[0] ?? await context.newPage();
    globalThis.__phonePage = page;
    page.on('pageerror', (e) => console.log(`  [${profile} pageerror] ${e.message}`));
    const cdp = await context.newCDPSession(page);
    try {
        // The pairing form: it should fit a phone; recorded, and its Connect button must be on screen.
        await page.goto(PAGE);
        await page.waitForSelector('[data-mobile="pair"]', { timeout: 30_000 });
        await page.screenshot({ path: join(OUT, `${profile}-pair.png`) });
        const pairBtn = await page.evaluate(() => { const b = document.querySelector('[data-mobile="pair"] button[type="submit"]'); return b ? b.getBoundingClientRect().bottom <= window.innerHeight : false; });
        check(`${profile} pair: Connect is on screen`, pairBtn);

        await page.goto('about:blank');
        await page.goto(`${PAGE}#pin=${pin}`);
        await answerPairOnDesktop(g, true);
        await page.waitForSelector('[data-mobile="shell"] [data-mobile-agent]', { timeout: 30_000 });

        // DASHBOARD: sixteen agents seeded (run.sh), more than a phone shows.
        await proveScreen(page, cdp, profile, 'dashboard', '[data-mobile-agent]');

        // AGENT CHAT: talk until the stream is longer than the screen.
        await page.goto(`${PAGE}#agent=${ATLAS}`);
        await page.waitForSelector(`[data-mobile-agent-view="${ATLAS}"]`, { timeout: 30_000 });
        if (await page.locator('[data-action="start-agent"]').count()) await page.tap('[data-action="start-agent"]');
        await page.waitForSelector('[data-mobile-composer]', { timeout: 60_000 });
        for (let i = 0; i < 10; i++) {
            const tall = await page.evaluate(() => { const rows = document.querySelectorAll('[data-mobile-row]'); const r = rows[rows.length - 1]; return r ? r.getBoundingClientRect().bottom > window.innerHeight : false; });
            if (tall) break;
            const n = await page.locator('[data-mobile-row]').count();
            await page.fill('textarea[name="text"]', `Message ${i + 1} from the ${profile}: keep going with the plan, and tell me what is next.`);
            await page.tap('[data-action="send-prompt"]');
            await page.waitForFunction((k) => document.querySelectorAll('[data-mobile-row]').length > k + 2, n, { timeout: 30_000 }).catch(() => {});
            await sleep(1500);
        }
        // The chat opens at its top (it does not follow the newest message — listed for the owner); the oldest rows are
        // on screen, the newest below: scroll to them.
        await page.reload();
        await page.waitForSelector('[data-mobile-row]', { timeout: 30_000 });
        await page.evaluate(() => { const s = document.querySelector('[data-mobile-activity]'); if (s) s.scrollTop = 0; });
        await proveScreen(page, cdp, profile, 'chat', '[data-mobile-row]');
        const composer = await page.evaluate(() => { const t = document.querySelector('textarea[name="text"]'); return t ? t.getBoundingClientRect().bottom <= window.innerHeight : false; });
        check(`${profile} chat: the composer stays on screen with a long stream`, composer);

        // FILES LIST: a folder of sixty files.
        await page.goto(`${PAGE}#files=tynn&path=many`);
        await page.waitForSelector('[data-file-entry]', { timeout: 30_000 }).catch(async () => {
            // The hash shape is mobileHash's; fall back to tapping in, as a person would.
            await page.goto(PAGE);
            await page.waitForSelector('[data-mobile-ws="tynn"]');
            await page.tap('[data-mobile-ws="tynn"]');
            await page.tap('[data-action="open-files"]');
            await page.tap('[data-file-entry="many"]');
        });
        await page.waitForSelector('[data-mobile-files="many"] [data-file-entry]', { timeout: 30_000 });
        await proveScreen(page, cdp, profile, 'files', '[data-file-entry]');

        // FILE VIEWER: a long markdown file, and a long code file.
        await page.tap('[data-file-entry="many/long.md"]').catch(async () => { await page.locator('[data-file-entry="many/long.md"]').scrollIntoViewIfNeeded(); await page.tap('[data-file-entry="many/long.md"]'); });
        await page.waitForSelector('[data-preview="markdown"]', { timeout: 30_000 });
        await proveScreen(page, cdp, profile, 'viewer-markdown', '[data-preview="markdown"] li');
        await page.goBack();
        await page.waitForSelector('[data-mobile-files="many"] [data-file-entry]');
        await page.locator('[data-file-entry="many/long.ts"]').scrollIntoViewIfNeeded();
        await page.tap('[data-file-entry="many/long.ts"]');
        await page.waitForSelector('[data-preview="text"]', { timeout: 30_000 });
        await page.evaluate(() => { const p = document.querySelector('[data-preview="text"]'); if (p && !p.querySelector('[data-end]')) { const m = document.createElement('span'); m.setAttribute('data-end', ''); m.textContent = '​'; p.appendChild(m); } });
        await proveScreen(page, cdp, profile, 'viewer-code', '[data-preview="text"] [data-end]');

        // BACK still works after all that scrolling (the hash routes).
        await page.goBack();
        await page.waitForSelector('[data-mobile-files="many"]', { timeout: 15_000 });
        check(`${profile}: back returns from the viewer to the folder`, true);
    } finally {
        await context.close();
    }
}

async function main() {
    const g = await genieWindow();
    let remote = await act(g, { kind: 'settings.set', key: 'remote_access', value: true });
    for (let i = 0; i < 40 && !remote.url; i++) { await sleep(500); remote = await g.evaluate('window.genie.features.snapshot().then((d) => d.remote)'); }
    check('remote access listens on the tailnet name', remote.url === `wss://${DNS}:7421/genie`, `url=${remote.url}`);
    for (const [profile, name] of [['iphone13', 'iPhone 13'], ['pixel7', 'Pixel 7']]) {
        try { await runProfile(g, profile, devices[name]); } catch (error) {
            check(`${profile}: the drive ran to the end`, false, String(error?.stack ?? error));
            const page = globalThis.__phonePage;
            if (page) await page.screenshot({ path: join(OUT, `${profile}-zz-failure.png`) }).catch(() => {});
        }
    }
    g.close();
}

try { await main(); } catch (error) { check('the drive ran', false, String(error?.stack ?? error)); }
writeFileSync(join(OUT, 'scroll-checks.json'), JSON.stringify(checks, null, 2));
const gated = checks.filter((c) => !c.note);
const failed = gated.filter((c) => !c.ok);
console.log(`\n${gated.length - failed.length}/${gated.length} scroll checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
