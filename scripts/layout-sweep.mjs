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
const pages = list.filter((t) => t.type === 'page' && !/#genie:\/\/(?:[^/?#]+\/)?takeover\//.test(String(t.url)));
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
    pending.get(frame.id)?.(frame);
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

        const rail = document.querySelector('nav');
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
const onWorkspace = await evaluate(`Boolean(document.querySelector('[data-surface="workspace"] [data-view-header]'))`);
say(`workspace rendered: ${onWorkspace}`);
if (!onWorkspace) {
    console.error('LAYOUT SWEEP could not reach the seeded workspace');
    process.exit(1);
}
const HEADER_PROBE = `
    (() => {
        const header = document.querySelector('[data-surface="workspace"] [data-view-header]');
        const column = header ? header.closest('main') : null;
        // THE POSITIVE CONTROL: the repos the header accounts for — its chips plus "+N more". Twelve seeded; fewer means
        // the seed did not land and "nothing overflows" would mean nothing.
        const chips = header ? header.querySelectorAll('[data-repo-chip]').length : 0;
        const more = Number((header?.querySelector('[data-action="more-repos"]')?.textContent ?? '').match(/[0-9]+/)?.[0] ?? 0);
        // WHAT spills, when something does: each child whose right edge passes the header's content box, by how much — so
        // a failure names its element instead of only a number.
        const box = header ? header.getBoundingClientRect() : null;
        const padRight = header ? parseFloat(getComputedStyle(header).paddingRight) || 0 : 0;
        const spills = header && box ? [...header.querySelectorAll('*')].map((el) => {
            const r = el.getBoundingClientRect();
            const over = Math.round(r.right - (box.right - padRight));
            const tag = el.tagName.toLowerCase();
            const mark = [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + (a.value ? '=' + a.value : '')).join(' ');
            return { over, what: (tag + ' ' + mark + ' ' + (el.textContent ?? '').trim().slice(0, 24)).trim(), width: Math.round(r.width) };
        }).filter((x) => x.over > 1).sort((a, b) => b.over - a.over).slice(0, 3) : [];
        return JSON.stringify({
            repos: chips + more,
            header: header ? header.scrollWidth - header.clientWidth : null,
            column: column ? column.scrollWidth - column.clientWidth : null,
            headerWidth: box ? Math.round(box.width) : null,
            spills,
        });
    })()
`;
for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 250));
    const r = JSON.parse(await evaluate(HEADER_PROBE));
    check(r.repos >= 12, `${width}px — the workspace header accounts for the seeded repos`, `${r.repos} of 12`);
    check(r.header !== null && r.header <= 1, `${width}px — the workspace header fits its column`, r.header > 1 ? `${r.header}px wider than its column (header ${r.headerWidth}px; spilling: ${JSON.stringify(r.spills)})` : '');
    check(r.column !== null && r.column <= 1, `${width}px — the page column does not scroll sideways`, r.column > 1 ? `${r.column}px wider` : '');
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
