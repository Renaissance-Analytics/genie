/**
 * DOES THE LAYOUT HOLD AT WIDTHS I HAVE NOT LOOKED AT?
 *
 * Two window sizes have been looked at so far and **both produced a defect**: 1440 showed an
 * Agent view with an empty bordered rail and no way to type, and 1024 spilled a column header
 * onto the row beneath it. Two for two is not a run of bad luck, it is a check that does not
 * exist.
 *
 * ## What it measures, and why that and not a screenshot diff
 *
 * A screenshot diff tells you something changed, not whether it is wrong, and it needs a
 * blessed baseline that somebody has to look at anyway. This asserts a PROPERTY instead:
 *
 *  - **Nothing overflows a fixed-height row.** Every row in this app has a stated height from
 *    the design board — 28px headers, 32px agent rows, 36px title bar. Content taller than its
 *    row lands on top of whatever is below it, which is exactly what "Current target" did.
 *  - **Nothing overflows the window horizontally.** A surface wider than its viewport means a
 *    scrollbar the design never asked for, or content a reader cannot reach.
 *  - **The rail keeps its width.** 208px is a fixed measurement; a rail that squeezes is the
 *    `flex: 1` margin bug that took the old build's left rail from 300px to 163px.
 *
 * Properties survive a redesign. A baseline image does not.
 *
 * ## Widths
 *
 * 800 is smaller than anybody should run this at and is included deliberately: the failure
 * mode at a hostile width is what tells you whether the layout degrades or breaks. 2560 catches
 * the opposite — things that only look right because they were cramped.
 */
import { isMainWindow } from './cdp-main-window.mjs';

const PORT = Number(process.env.CDP_PORT ?? 9222);
const WIDTHS = [800, 1024, 1280, 1440, 1920, 2560];
const HEIGHT = 900;

const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

/*
 * Progress lines through the connection sequence, because this script HUNG here on CI.
 *
 * Five consecutive Linux runs on 2026-10-10 printed `SMOKE PASSED` from the previous script and
 * then nothing — no header, no PASS, no FAIL — until the job's 15-minute limit cancelled it.
 * Everything below the header reports itself; nothing above it did, so the hang could have been
 * the target list, the socket, or the landing step, and there was no way to tell from the log.
 * A step that can stall must say it has started.
 */
const say = (what) => console.log(`  … ${what}`);

say(`listing CDP targets on :${PORT}`);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
// The smoke may have opened a Take Over window; the sweep measures the MAIN window.
// A Take Over window: genie://takeover/<id>, or its address genie://{workstation}/takeover/<id> (Tynn #831).
const pages = list.filter(isMainWindow);
say(`${list.length} target(s), ${pages.length} page(s): ${pages.map((p) => p.url).join(' | ') || '(none)'}`);
const page = pages[0];
if (!page) {
    console.error('LAYOUT SWEEP found no page target to attach to');
    process.exit(1);
}

say(`opening ${page.webSocketDebuggerUrl}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`CDP socket error: ${e.message ?? 'unknown'}`)), { once: true });
});
say('socket open');

let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
    const frame = JSON.parse(e.data);
    { const done = pending.get(frame.id); if (typeof done === 'function') done(frame); }
    pending.delete(frame.id);
});
const send = (method, params = {}) =>
    new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
    });
const evaluate = async (expression) => {
    const frame = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return frame.result?.result?.value;
};

/*
 * The measurement, run at each width.
 *
 * `scrollHeight > clientHeight + 1` rather than `>`: sub-pixel layout rounds, and a check that
 * fires on a third of a pixel is a check people disable. One pixel of slack is the difference
 * between "a line wrapped" and "the browser rounded".
 */
const PROBE = `
    (() => {
        const over = [];

        // Every element whose height is pinned by a Tailwind h-* class from the board.
        for (const el of document.querySelectorAll('[class*="h-7"], [class*="h-8"], [class*="h-9"], [class*="h-11"], [class*="h-14"], [class*="h-[30px]"]')) {
            if (el.scrollHeight > el.clientHeight + 1) {
                over.push({
                    what: (el.getAttribute('data-agent') || el.getAttribute('data-nav') || el.className || '').slice(0, 60),
                    clientHeight: el.clientHeight,
                    scrollHeight: el.scrollHeight,
                });
            }
        }

        // The rail CONTAINER (data-rail, w-52): since #1430 the first <nav> is react-fancy Sidebar's landmark inside it (191px).
        const rail = document.querySelector('[data-rail=expanded]');
        const doc = document.documentElement;

        /*
         * How many fixed-height elements were examined.
         *
         * THE POSITIVE CONTROL. "Nothing overflows" passes identically on a page with nothing
         * to overflow — an empty Dashboard, a failed render, a changed class name that the
         * selector no longer matches. The count is what makes the absence mean something.
         */
        const examined = document.querySelectorAll('[class*="h-7"], [class*="h-8"], [class*="h-9"], [class*="h-11"], [class*="h-14"], [class*="h-[30px]"]').length;

        return JSON.stringify({
            examined,
            overflowing: over,
            railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : null,
            horizontalOverflow: doc.scrollWidth - doc.clientWidth,
        });
    })()
`;

/*
 * LAND ON A KNOWN SURFACE FIRST.
 *
 * This measured whatever the smoke happened to leave on screen, which made the measurement
 * depend on the previous script's last click. Switching the approval round trip on moved that
 * last click from the Dashboard to an agent, and the count of fixed-height rows went from
 * eight to seven -- so the POSITIVE CONTROL failed and reported, correctly, that "nothing
 * overflows" had passed on too little to mean anything.
 *
 * That is the control doing its job, not a threshold being too strict. Lowering the eight
 * would have been loosening an assertion to get green; the actual defect was a sweep with no
 * stated subject.
 */
say('landing on the Dashboard');
const landed = await evaluate(`(() => {
    const row = document.querySelector('[data-nav^="genie://dashboard"]');
    if (!row) return 'no Dashboard row in the rail';
    row.click();
    return 'clicked';
})()`);
say(`landing click: ${landed}`);
if (landed !== 'clicked') {
    console.error(`LAYOUT SWEEP could not reach the Dashboard: ${landed}`);
    process.exit(1);
}
// One frame for the route change to render before the first width is measured.
await new Promise((r) => setTimeout(r, 300));
const onDashboard = await evaluate(`Boolean(document.querySelector('[data-surface="dashboard"]'))`);
say(`Dashboard rendered: ${onDashboard}`);
if (!onDashboard) {
    console.error('LAYOUT SWEEP clicked the Dashboard row and the Dashboard did not render');
    process.exit(1);
}

console.log('\nLAYOUT SWEEP — does it hold at widths nobody has looked at?\n');

for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', {
        width, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });
    // One frame for layout to settle. Measuring in the same tick as the resize reads the old
    // geometry, which would make every width report the first one's numbers.
    await new Promise((r) => setTimeout(r, 250));

    const result = JSON.parse(await evaluate(PROBE));

    // POSITIVE CONTROL first, and upstream of the result — a control computed after the table
    // is a footnote under data, and the data wins.
    check(
        result.examined >= 8,
        `${width}px — found fixed-height rows to examine`,
        `${result.examined} elements`,
    );

    check(
        result.overflowing.length === 0,
        `${width}px — nothing overflows a fixed-height row`,
        result.overflowing.length === 0
            ? ''
            : result.overflowing.map((o) => `${o.what} ${o.clientHeight}→${o.scrollHeight}`).join(' | '),
    );

    check(
        result.horizontalOverflow <= 0,
        `${width}px — nothing overflows the window horizontally`,
        result.horizontalOverflow > 0 ? `${result.horizontalOverflow}px wider than the viewport` : '',
    );

    // The rail is a fixed 208px at every width. Below ~700 a real responsive design would
    // collapse it, and there is no such rule yet — so this asserting a constant is honest
    // about what the app currently claims rather than about what it should eventually do.
    check(result.railWidth === 208, `${width}px — the rail keeps its 208px`, `${result.railWidth}px`);
}

/*
 * A PAGE HEADER NEVER OVERFLOWS ITS COLUMN (beta.33 item 23). The owner (2026-10-20): "why the fuck is any content at all
 * behind the fucking chat panel?" The workspace header drew a chip per repo in one row that could not wrap; `<main>` is
 * `overflow-auto`, so it clipped the row at the chat's edge — content "behind the chat" — and the WINDOW never
 * overflowed, which is why the checks above passed. Measured where it happens: the header and the page column, on the
 * seeded workspace, which smoke-seed.mjs gives twelve repos (with one, there was nothing to overflow).
 */
say('landing on the workspace');
await evaluate(`window.location.hash = '#genie://workspace/tynn'; true`);
await new Promise((r) => setTimeout(r, 400));
const onWorkspace = await evaluate(`Boolean(document.querySelector('[data-surface="workspace"] [data-top-bar]'))`);
say(`workspace rendered: ${onWorkspace}`);
if (!onWorkspace) {
    console.error('LAYOUT SWEEP could not reach the seeded workspace');
    process.exit(1);
}
/*
 * ONE BAR FOR EVERY VIEW (the owner on beta.64, 2026-11-17: "agents should not have a different header UX than
 * workspaces ... I prefer the tabs along the top layout"). The workspace's tab strip is the view's only header: the tabs
 * scroll inside it, the right end holds the selected view's status and actions. Measured: it is the surface's first
 * child, 32px tall at every width, and it never pushes the page column sideways. The workspace's height is kept and the
 * agent's is compared with it below.
 */
const BAR_PROBE = (surface) => `
    (() => {
        const surface = document.querySelector('[data-surface="${surface}"]');
        const bar = surface?.firstElementChild?.hasAttribute('data-top-bar') ? surface.firstElementChild : null;
        const column = bar ? bar.closest('main') : null;
        const lines = (el) => {
            if (!el) return 0;
            const tops = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if (!(n.textContent ?? '').trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(n);
                for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) tops.push(r.top);
            }
            return tops.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > 4).length;
        };
        const selected = bar?.querySelector('[data-workspace-tab][aria-selected="true"], [data-agent-name][aria-selected="true"]') ?? null;
        const chip = bar?.querySelector('[data-provider-chip]') ?? null;
        const pill = bar?.querySelector('[data-pill]') ?? null;
        const box = bar ? bar.getBoundingClientRect() : null;
        const pinned = document.querySelector('[data-chat="pinned"]');
        return JSON.stringify({
            // THE POSITIVE CONTROLS: the bar is there, it is this surface's first child, and the selected tab is in it.
            bar: Boolean(bar),
            id: surface?.getAttribute('data-workspace') ?? surface?.getAttribute('data-agent') ?? null,
            // A built-in tab is an icon named by aria-label since Tynn #945; an agent's or a designed tab says its name.
            selected: (selected?.getAttribute('aria-label') ?? selected?.textContent ?? '').trim(),
            selectedWidth: selected ? Math.round(selected.getBoundingClientRect().width) : null,
            selectedLines: lines(selected),
            title: selected?.getAttribute('title') ?? null,
            actions: bar ? bar.querySelectorAll('[data-bar-actions] [data-action]').length : 0,
            // Every action at the bar's right end (Share is drawn by the strip, beside the view's own actions).
            trailing: bar ? [...bar.querySelectorAll('[data-bar-trailing] [data-action]')].map((b) => b.getAttribute('data-action')).sort().join(',') : '',
            chips: bar ? bar.querySelectorAll('[data-repo-chip]').length : 0,
            crumbs: surface ? surface.querySelectorAll('[data-crumb], [data-react-fancy-breadcrumbs], [data-header-path]').length : -1,
            subviews: Boolean(bar?.querySelector('[data-agent-subviews] [data-tab]')),
            logo: Boolean(chip?.querySelector('[data-provider-logo]')),
            pill: lines(pill),
            // An action shows its icon, never words: no line of text in any.
            buttons: bar ? [...bar.querySelectorAll('[data-bar-actions] button[data-action]')].map((b) => b.getAttribute('data-action') + ':' + lines(b)) : [],
            pinned: Boolean(pinned),
            chatWidth: pinned ? Math.round(pinned.getBoundingClientRect().width) : 0,
            height: box ? Math.round(box.height) : null,
            barWidth: box ? Math.round(box.width) : null,
            wide: bar ? bar.scrollWidth - bar.clientWidth : null,
            column: column ? column.scrollWidth - column.clientWidth : null,
        });
    })()
`;
const workspaceHeights = new Map();
for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 250));
    const r = JSON.parse(await evaluate(BAR_PROBE('workspace')));
    workspaceHeights.set(width, r.height);
    // Tynn #945: the bar's actions are exactly Terminal, Share and Clean up; the Dashboard tab is an icon whose path is in its
    // react-fancy Tooltip, so it carries no native title (two bubbles otherwise).
    check(r.bar && r.id === 'tynn' && r.selected === 'Dashboard' && r.title === null && ['open-scratch-terminal,remove-workspace', 'open-scratch-terminal,remove-workspace,share-workspace'].includes(r.trailing) && r.chips === 0 && r.crumbs === 0, `${width}px — the seeded workspace's ONE bar: its Dashboard tab selected (an icon, the path its tooltip), Terminal, Share (where this Genie can share) and Clean up only, no repo list, no crumbs`, JSON.stringify({ bar: r.bar, id: r.id, selected: r.selected, title: r.title, trailing: r.trailing, chips: r.chips, crumbs: r.crumbs }));
    // One 32px line wherever the page is wide enough for it (from 1024px, measured by scripts/one-bar-proof.mjs). At 800px the
    // pinned chat leaves the page 72px: the bar wraps there by design (TopBar.tsx), and only "nothing spills" is asked.
    if (width >= 1024) check(r.height === 32, `${width}px — the workspace bar is one 32px line`, `${r.height}px`);
    check(r.wide !== null && r.wide <= 1, `${width}px — the workspace bar fits its column`, r.wide > 1 ? `${r.wide}px wider than its column (bar ${r.barWidth}px)` : '');
    check(r.column !== null && r.column <= 1, `${width}px — the page column does not scroll sideways`, r.column > 1 ? `${r.column}px wider` : '');
}

/*
 * THE AGENT'S BAR IS THE SAME BAR, WITH THE CHAT PINNED (the owner's checklist, 2026-10-14: at 1024px with the chat pinned
 * the agent header wrapped). Measured on a real agent page with the chat in the dock: its bar is its workspace's strip,
 * as tall as the workspace's at the same width; its tab and pill are one line; its actions are icons; it holds its views.
 */
say('landing on a workspace agent, chat pinned');
await evaluate(`window.location.hash = '#genie://dashboard'; true`);
await new Promise((r) => setTimeout(r, 400));
await evaluate(`(() => { const stopped = document.querySelector('[data-dashboard-filter="stopped"]'); if (stopped?.getAttribute('aria-pressed') === 'false') stopped.click(); return true; })()`);
const seededAgent = await evaluate(`document.querySelector('[data-surface="dashboard"] [data-agent]:has([data-workspace="tynn"])')?.getAttribute('data-agent') ?? null`);
if (!seededAgent) {
    console.error('LAYOUT SWEEP found no seeded workspace agent on the Dashboard');
    process.exit(1);
}
await evaluate(`window.location.hash = '#genie://agent/${seededAgent}?tab=stream'; true`);
await new Promise((r) => setTimeout(r, 600));
/*
 * 1024 first: the width the defect was seen at. Not 800: there the pinned chat (520px) and the rail (208px) leave the page
 * 72px, and what a page can do in 72px is the dock's question, not the header's.
 */
const pinnedWidths = [...new Set([1024, ...WIDTHS.filter((w) => w >= 1024)])];
for (const width of pinnedWidths) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 250));
    const r = JSON.parse(await evaluate(BAR_PROBE('agent')));
    const at = `${width}px, chat pinned`;
    check(r.bar && r.pinned && r.subviews && r.logo && r.crumbs === 0, `${at} — an agent page with the chat in the dock: ONE bar, its views and logo chip in it, no crumbs`, `bar ${r.bar}, pinned ${r.pinned} (${r.chatWidth}px), views ${r.subviews}, logo ${r.logo}, crumbs ${r.crumbs}`);
    // From 1280px the page beside the pinned chat holds the whole bar on one line; at 1024px (~296px of page) the agent's
    // right end wraps onto a line of its own, by design (TopBar.tsx), so only "it does not spill" is asked there.
    if (width >= 1280) check(r.height === workspaceHeights.get(width), `${at} — the agent bar is as tall as the workspace bar`, `agent ${r.height}px, workspace ${workspaceHeights.get(width)}px`);
    check(r.selectedLines === 1 && r.pill <= 1 && r.buttons.every((b) => /:0$/.test(b)), `${at} — its tab is ONE line, its pill at most one; its actions are icons`, `tab ${r.selectedLines}, pill ${r.pill}, actions ${r.buttons.join(' ')}`);
    check(r.selectedWidth >= 24, `${at} — its tab keeps its name`, `${r.selectedWidth}px`);
    check(r.wide !== null && r.wide <= 1, `${at} — the agent bar does not spill past its column`, `${r.wide}px wider than its box`);
}

await send('Emulation.clearDeviceMetricsOverride');
ws.close();

console.log('');
if (failures.length > 0) {
    console.log(`LAYOUT SWEEP FAILED — ${failures.length}:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log(`LAYOUT SWEEP PASSED — ${WIDTHS.length} widths, nothing spilled.`);

// Same rule as smoke-cdp.mjs: the work is done, so exit — and name any handle that would have
// kept the process alive, because "it hung" is not a diagnosis.
const open = (process._getActiveHandles?.() ?? []).map((h) => h?.constructor?.name ?? typeof h);
if (open.length > 0) {
    console.log(`  (handles still open at exit: ${open.join(', ')} — exiting explicitly)`);
}
process.exit(0);
