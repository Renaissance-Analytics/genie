/**
 * THE SMOKE PATH — a real Electron window, driven over the Chrome DevTools Protocol.
 *
 * §8.1, and the single thing that was missing from all four failed betas: **nobody ever opened
 * the built app and clicked an agent.** Four releases shipped on green unit suites and every
 * one was broken on first use.
 *
 * ## Why CDP and not a test framework
 *
 * Because it needs **no third-party dependency and no test-only code in the product.**
 * `--remote-debugging-port` is a Chromium flag passed on the command line in the container;
 * Node 22 has a global `WebSocket`; the protocol is JSON. Nothing is added to the tree and
 * nothing in `src/` knows this file exists.
 *
 * That last part matters more than the convenience. The previous build had a `GENIE_E2E`
 * escape hatch that short-circuited the single-instance lock, and the measured result was two
 * instances opening windows on the owner's desktop while real agents were mid-turn. A harness
 * that requires the product to behave differently is a harness that tests a different product.
 *
 * ## Where it runs
 *
 * In a Linux container under Xvfb, never on the owner's machine. That is the standing rule and
 * it is absolute: no browser, no Electron, no window on the live desktop. A `--rm` container
 * reaped in the same command is the measurement the rules ask for.
 *
 * ## What it proves, and what it does not
 *
 * It proves the app BOOTS, that the Dashboard is the landing surface, that the chrome and the
 * rail render, and that the renderer got its bridge. It does not prove the layout looks right
 * at any size, or that the typography is correct — a screenshot is written for a human to
 * look at, and until a human looks at it that remains unverified.
 */

/**
 * Where screenshots go: beside whatever is running this, not at a fixed path.
 *
 * It was hardcoded to `/work`, which exists inside the smoke container and nowhere else. On
 * the CI runner the whole job failed on the LAST step with `ENOENT: /work/smoke-agent.png`
 * after twenty-one checks had already passed — a harness bug reported as a red build, which is
 * the most expensive kind because the obvious reading is that the app broke.
 */
const shotPath = (name) => `${process.cwd()}/${name}`;

const PORT = Number(process.env.CDP_PORT ?? 9222);
const DEADLINE_MS = 60_000;

/*
 * The chat composer, found by Genie's own handle and by what it IS: an editable input inside `[data-chat-composer]`.
 *
 * Not `textarea`. With paste pills on, react-fancy 5.39.0's `PromptInput` renders a `contenteditable` `role="textbox"`
 * and no `<textarea>` at all (react-fancy#32) — a selector for the library's element timed out on a composer that was
 * on screen (PR #313, checks 21 and 28a). `[data-chat-composer]` is on the composer only: no flyout, or a flyout whose
 * composer is replaced by the "no agent to message" notice, has no match, so the checks below still fail without it.
 */
const CHAT_COMPOSER_INPUT = '[data-chat-composer] :is([contenteditable="true"][role="textbox"], textarea:not([disabled]))';

const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

/** Wait for the debugger to come up. Electron needs a moment, and a fixed sleep is a guess. */
async function findTarget() {
    const until = Date.now() + DEADLINE_MS;
    let lastError = 'no attempt made';

    while (Date.now() < until) {
        try {
            const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            const targets = await response.json();
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page;
            lastError = `no page target yet (${targets.length} targets)`;
        } catch (error) {
            lastError = String(error);
        }
        await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error(`the Electron window never appeared on the debugger port: ${lastError}`);
}

class Cdp {
    #socket;
    #nextId = 1;
    #pending = new Map();

    static async connect(url) {
        const cdp = new Cdp();
        cdp.#socket = new WebSocket(url);
        cdp.#socket.addEventListener('message', (event) => {
            const frame = JSON.parse(event.data);
            const resolve = cdp.#pending.get(frame.id);
            if (!resolve) return;
            cdp.#pending.delete(frame.id);
            resolve(frame);
        });
        await new Promise((resolve, reject) => {
            cdp.#socket.addEventListener('open', resolve, { once: true });
            cdp.#socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
        });
        return cdp;
    }

    send(method, params = {}) {
        const id = this.#nextId++;
        return new Promise((resolve) => {
            this.#pending.set(id, resolve);
            this.#socket.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Evaluate in the page and return the value, or throw with the page's own error. */
    async evaluate(expression) {
        const frame = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (frame.error) throw new Error(`CDP error: ${JSON.stringify(frame.error)}`);
        const result = frame.result;
        if (result.exceptionDetails) {
            throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? 'unknown'}`);
        }
        return result.result.value;
    }

    close() {
        this.#socket.close();
    }
}

/** Poll the page until a predicate holds. A render is asynchronous; a fixed sleep is a guess. */
async function waitFor(cdp, expression, label) {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
        try {
            if (await cdp.evaluate(expression)) return true;
        } catch {
            // The page may not have a document yet. Keep waiting; the deadline is the guard.
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`  (timed out waiting for: ${label})`);
    return false;
}

const target = await findTarget();
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

/*
 * Collect console errors from the moment we attach.
 *
 * Reading them at the end would miss everything logged during boot — capture starts when the
 * reader attaches, and a console read after first paint reports an empty console whether or
 * not one was clean. So the hook is installed first and the page is reloaded under it.
 */
await cdp.send('Runtime.enable');
await cdp.evaluate(`
    window.__smokeErrors = [];
    const original = console.error;
    console.error = (...args) => { window.__smokeErrors.push(args.map(String).join(' ')); original(...args); };
    window.addEventListener('error', (e) => window.__smokeErrors.push('window.onerror: ' + e.message));
    window.addEventListener('unhandledrejection', (e) => window.__smokeErrors.push('unhandled: ' + String(e.reason)));
    true
`);
await cdp.send('Page.enable');
await cdp.send('Page.reload', { ignoreCache: false });

console.log('\nTHE SMOKE PATH — a real window, in a container\n');

// 1. It boots at all.
const booted = await waitFor(cdp, 'document.querySelector("#root") && document.querySelector("#root").children.length > 0', 'the renderer mounting');
check(booted, '1. the app boots and the renderer mounts');

// 2. The Dashboard is the LANDING surface — reachable with no keyboard shortcut and no clicks.
const onDashboard = await waitFor(cdp, 'Boolean(document.querySelector(\'[data-surface="dashboard"]\'))', 'the Dashboard');
check(onDashboard, '2. the Dashboard is the landing surface, with nothing typed or clicked');

// 3. The chrome rendered: the route, the four feature icons, the rail.
// The address is genie://{workstation}/… (the owner, 2026-10-19; Tynn #831) — written once the snapshot names the workstation.
const ADDRESS = { dashboard: '^genie://[^/?]+/dashboard(\\?|$)', dashboardExact: '^genie://[^/?]+/dashboard$', workspace: '^genie://[^/?]+/[^/?]+/dashboard$', settings: '^genie://[^/?]+/settings' };
await waitFor(cdp, `new RegExp(${JSON.stringify(ADDRESS.dashboard)}).test(document.querySelector('[data-route]')?.textContent ?? '')`, 'the address genie://{workstation}/dashboard');
const route = await cdp.evaluate('document.querySelector("[data-route]")?.textContent ?? null');
check(typeof route === 'string' && new RegExp(ADDRESS.dashboard).test(route), '3. the title bar shows the address, genie://{workstation}/dashboard', String(route));

const features = await cdp.evaluate('document.querySelectorAll("[data-feature]").length');
check(features === 4, '4. the four feature icons are in the title bar', `found ${features}`);

// 4b. THE AGENTINBOX among the header's system icons (beta.33 item 19): a press opens the flyout over the page, a second
// closes it — in the real window, where the address layer carries `inbox=`.
const inboxIcon = await cdp.evaluate('document.querySelectorAll("[data-system-icon=\\"AgentInbox\\"]").length');
await cdp.evaluate(`document.querySelector('[data-system-icon="AgentInbox"]')?.click(); true`);
const inboxOpened = await waitFor(cdp, 'Boolean(document.querySelector("[data-inbox-flyout]")) && /[?&]inbox=/.test(document.querySelector("[data-route]")?.textContent ?? "")', 'the AgentInbox flyout');
await cdp.evaluate(`document.querySelector('[data-system-icon="AgentInbox"]')?.click(); true`);
const inboxClosed = await waitFor(cdp, '!document.querySelector("[data-inbox-flyout]")', 'the AgentInbox flyout to close');
check(inboxIcon === 1 && inboxOpened && inboxClosed, '4b. the AgentInbox icon in the title bar opens and closes its flyout', JSON.stringify({ inboxIcon, inboxOpened, inboxClosed }));

const navRows = await cdp.evaluate('document.querySelectorAll("[data-nav]").length');
check(navRows >= 2, '5. the rail offers labelled navigation', `${navRows} rows`);

// 6. The ICONS actually rendered. An unregistered name is an empty span with no warning, and
//    this is the one check that sees what a person would see rather than what the markup says.
const glyphs = await cdp.evaluate('document.querySelectorAll("[data-react-fancy-icon] svg").length');
check(glyphs > 0, '6. icons rendered as real SVG, not empty spans', `${glyphs} glyphs`);

// 7. The renderer got its bridge. Without the preload, `window.genie` is simply absent and the
//    app opens looking like a Dashboard with no agents rather than like a broken bridge.
const bridge = await cdp.evaluate('typeof window.genie === "object" && typeof window.genie.snapshot === "function"');
check(bridge === true, '7. the preload bridge reached the renderer');

/*
 * 8. The main process answers over IPC.
 *
 * The first version of this read:
 *
 *     cdp.evaluate('window.genie ? JSON.stringify(await window.genie.snapshot()) : null')
 *         .catch(() => null)
 *
 * `await` at the top level of a non-async expression is a SyntaxError, the `.catch` swallowed
 * it, and the check reported a failure that said nothing about the product — while a passing
 * version of the same mistake would have reported success on no evidence at all. Both halves
 * of that are this project's signature defect.
 *
 * So: an async IIFE, no `.catch`, and the error surfaces as the error it is.
 */
const snapshot = await cdp.evaluate(`
    (async () => {
        if (!window.genie) return null;
        const s = await window.genie.snapshot();
        return JSON.stringify({ workspaces: s.workspaces.length, agents: s.agents.length, workstation: s.workstation });
    })()
`);
check(typeof snapshot === 'string', '8. the main process answers a snapshot over IPC', String(snapshot));

/*
 * 9. And the answer came from the REAL registry, not from the renderer's empty default.
 *
 * `EMPTY_SNAPSHOT` has `workstation: null`; a loaded registry names the machine. Without this,
 * check 8 passes on a bridge that resolves an empty object — which is precisely how the
 * previous build shipped a Dashboard that looked fine and knew nothing.
 */
const named = await cdp.evaluate(`
    (async () => {
        if (!window.genie) return false;
        const s = await window.genie.snapshot();
        return Boolean(s.workstation && typeof s.workstation.name === 'string' && s.workstation.name.length > 0);
    })()
`);
check(named === true, '9. the snapshot came from the real registry, not the empty default');

// 9. Stylesheet actually applied. A wrong Tailwind `@source` ships a stylesheet with none of
//    the board's metrics in it, and every surface silently collapses to unstyled blocks.
const railWidth = await cdp.evaluate('(() => { const n = document.querySelector("nav"); return n ? Math.round(n.getBoundingClientRect().width) : 0; })()');
check(railWidth === 208, '10. the rail is 208px — the stylesheet applied', `${railWidth}px`);

const barHeight = await cdp.evaluate('(() => { const n = document.querySelector("[data-route]")?.parentElement; return n ? Math.round(n.getBoundingClientRect().height) : 0; })()');
check(barHeight === 36, '11. the title bar is 36px', `${barHeight}px`);

/*
 * The fonts actually RESOLVE, and sans is not mono.
 *
 * Found by looking at a screenshot: the whole app rendered in one face because
 * `@theme inline { --font-sans: var(--font-sans) }` is a circular custom property, which is
 * invalid at computed-value time. Both variables resolved to nothing and every element fell
 * back to the browser default.
 *
 * Every unit test passed. The stylesheet even CONTAINED both stacks — they were simply
 * unusable. So this measures the computed value on a real element, which is the only level at
 * which the defect exists.
 */
const fonts = await cdp.evaluate(`
    (() => {
        const sans = getComputedStyle(document.body).fontFamily;
        const monoEl = document.querySelector('[data-route]');
        const mono = monoEl ? getComputedStyle(monoEl).fontFamily : '';
        return JSON.stringify({ sans, mono });
    })()
`);
const { sans, mono } = JSON.parse(fonts);
check(sans.length > 0 && !sans.startsWith('var('), '12. the sans stack resolves', sans);
check(mono.includes('mono') || mono.includes('Mono'), '13. the mono stack resolves', mono);
check(sans !== mono, '14. sans and mono are different faces — the theme is not circular');

/*
 * Is the body font actually PROPORTIONAL?
 *
 * The computed `font-family` string being correct is not the same as the glyphs on screen
 * being right: every name in the stack can be absent and the engine falls back to whatever it
 * has. Comparing the strings told me the theme was no longer circular and told me nothing
 * about what a reader sees.
 *
 * So measure it: in a proportional face `iii` is narrower than `mmm`; in a monospace face they
 * are identical. That is a property of the rendered glyphs, which is the level the defect
 * lives at.
 */
const proportional = await cdp.evaluate(`
    (() => {
        const probe = (text, family) => {
            const el = document.createElement('span');
            el.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:48px;font-family:' + family;
            el.textContent = text;
            document.body.appendChild(el);
            const w = el.getBoundingClientRect().width;
            el.remove();
            return w;
        };
        const family = getComputedStyle(document.body).fontFamily;
        return JSON.stringify({ narrow: probe('iiiiii', family), wide: probe('mmmmmm', family) });
    })()
`);
const widths = JSON.parse(proportional);
check(
    widths.wide > widths.narrow * 1.2,
    '15. the body font is PROPORTIONAL, not a monospace fallback',
    `iiiiii=${Math.round(widths.narrow)}px mmmmmm=${Math.round(widths.wide)}px`,
);

/*
 * THE FLOW: a seeded agent appears, and CLICKING IT OPENS IT.
 *
 * §0.4's exact shape. A finished Conversation UI was built, shipped and unreachable for three
 * releases because one condition decided it should not render — and every test of that feature
 * was green, because each one rendered the feature directly rather than asking whether the
 * screen would. **The only check that would have caught it is a click.**
 */
const agentRow = await cdp.evaluate(`
    (() => {
        // A WORKSPACE agent's row: genie's own group comes first on the Dashboard (the design mockup, 2026-10-19).
        const row = document.querySelector('[data-surface="dashboard"] div[data-workspace] [data-agent]');
        return row ? JSON.stringify({ id: row.getAttribute('data-agent'), text: row.textContent }) : null;
    })()
`);
check(typeof agentRow === 'string', '16. the seeded agent appears on the Dashboard', String(agentRow));
// 60. GENIE'S OWN GROUP, FIRST (the design mockup): `genie · default agent · not in a workspace`, above every workspace.
check(await cdp.evaluate(`(() => { const g = document.querySelector('[data-genie-group]'); const w = document.querySelector('[data-surface="dashboard"] div[data-workspace]'); return Boolean(g && w && (g.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING) && /default agent · not in a workspace/.test(g.textContent ?? '')); })()`), '60. the Dashboard opens with genie’s own group, above the workspaces', await cdp.evaluate(`document.querySelector('[data-genie-group]')?.textContent?.slice(0, 80) ?? null`));

if (typeof agentRow === 'string') {
    // 17. A ROW CLICK OPENS THAT AGENT'S CHAT BESIDE THE DASHBOARD, WHICH STAYS (genie#1209; the owner, 2026-10-26: "on the
    // dashboard page I should be able to click on agent to bring up their chat and stay on the dashboard").
    const rowId = JSON.parse(agentRow).id;
    await cdp.evaluate(`document.querySelector('[data-surface="dashboard"] div[data-workspace] [data-agent]').click(); true`);
    const chatted = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-chat="pinned"][data-chat-subject="${rowId}"]')) && Boolean(document.querySelector('[data-surface="dashboard"]'))`,
        'that agent\'s chat beside the Dashboard after clicking a row',
    );
    check(chatted, '17. clicking the row opens THAT agent\'s chat beside the Dashboard, which stays');

    // The Agent view itself is the agent's page (the row tray's Open agent): reached by its route.
    await cdp.evaluate(`window.location.hash = '#genie://agent/${rowId}?tab=stream'; true`);
    const opened = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-surface="agent"]'))`,
        'the Agent view from its route',
    );
    check(opened, '17b. the agent\'s page OPENS the Agent view');

    // And the Stream is PRESENT and showing — not hidden behind a fidelity check, which is the
    // precise mechanism that hid it for three releases.
    const stream = await cdp.evaluate(`
        (() => {
            const tab = document.querySelector('[data-tab="stream"]');
            const body = document.querySelector('[data-stream]');
            return JSON.stringify({
                tab: Boolean(tab),
                active: tab?.getAttribute('data-active') === 'true',
                body: body?.getAttribute('data-stream') ?? null,
            });
        })()
    `);
    const s = JSON.parse(stream || '{}');
    check(s.tab === true && s.active === true, '18. the Stream tab is present and selected');
    check(s.body !== null, '19. the Stream body renders — an empty state, not nothing', String(s.body));

    // 54. THE HEADER PER THE BOARD (re-audit, 2026-10-12): `{workspace} /` breadcrumb, the provider chip (the provider's
    // LOGO, named for hover and screen readers, then `ACP` — genie#1266: no provider word), the pill in the board's words (`Turn N · running` / `Idle` / `No turns yet` / `Not started` / `Broken · …`), and the
    // chords on Take over and Chat. One right column at most (never the old 420px Inspector beside a 260px rail).
    const header = await cdp.evaluate(`JSON.stringify({
        crumb: Boolean(document.querySelector('[data-crumb]')),
        chip: document.querySelector('[data-provider-chip]')?.textContent ?? null,
        logo: document.querySelector('[data-provider-chip] [data-provider-logo] svg') ? (document.querySelector('[data-provider-chip] [data-provider-logo]')?.getAttribute('aria-label') ?? '') : null,
        pill: document.querySelector('[data-pill]')?.getAttribute('data-pill') ?? null,
        chords: (document.querySelector('[data-action="take-over"]')?.textContent ?? '').includes('⌘⇧T') && (document.querySelector('[data-action="chat"]')?.textContent ?? '').includes('⌘J'),
        columns: document.querySelectorAll('[data-right-column]').length,
    })`);
    const h = JSON.parse(header || '{}');
    check(h.crumb && (h.chip ?? '').trim() === 'ACP' && Boolean(h.logo) &&/^(Turn \d+ · |Idle$|No turns yet$|Not started$|Broken · )/.test(h.pill ?? '') && h.chords && h.columns <= 1, '54. the Agent view header is the board\'s: breadcrumb, provider chip, pill in turns, chords, one right column', header);

    // 51. EVERY TAB HAS A BODY (board audit, 2026-10-12: only Stream had one). Files mounts the workspace's one file
    // panel for the agent's workspace; Changes lists this agent's changed files or says there are none. Then back to
    // Stream, so the checks that follow see the view they expect.
    await cdp.evaluate(`document.querySelector('[data-tab="files"]').click(); true`);
    const filesTab = await waitFor(cdp, `Boolean(document.querySelector('[data-files-panel]'))`, 'the Files tab body');
    await cdp.evaluate(`document.querySelector('[data-tab="changes"]').click(); true`);
    const changesTab = await waitFor(cdp, `Boolean(document.querySelector('[data-agent-changes]'))`, 'the Changes tab body');
    const changesText = await cdp.evaluate(`(document.querySelector('[data-agent-changes]')?.textContent ?? '').slice(0, 60)`);
    check(filesTab && changesTab, '51. the Files and Changes tabs have bodies (the file panel; this agent\'s changes or a sentence)', changesText);
    // Each tab click is a NAVIGATION (the tab lives in the route), so the two clicks above are two history entries.
    // Undo exactly those two, or check 24's "Back again returns to the Dashboard" lands on a tab instead — the first
    // CI run of this check did precisely that. `go(-2)`, not a click on Stream, which would be a third entry.
    await cdp.evaluate('history.go(-2); true');
    await waitFor(cdp, `document.querySelector('[data-tab="stream"]')?.getAttribute('data-active') === 'true'`, 'the Stream tab again, by history');

    /*
     * The composer is REACHABLE from here.
     *
     * The chat flyout is the only place a human types to an agent, so a screen with no route
     * to it is read-only — someone can open an agent and then do nothing with it. The first
     * screenshot of this view showed exactly that, and no test said a word about it.
     */
    const chatButton = await cdp.evaluate(`Boolean(document.querySelector('[data-action="chat"]'))`);
    check(chatButton === true, '20. the Agent view offers a route to the composer');

    if (chatButton) {
        await cdp.evaluate(`document.querySelector('[data-action="chat"]').click(); true`);
        const composer = await waitFor(
            cdp,
            `Boolean(document.querySelector('[data-chat]')?.querySelector(${JSON.stringify(CHAT_COMPOSER_INPUT)}))`,
            'the chat flyout and its composer',
        );
        check(composer, '21. clicking it opens the flyout with a real composer');

        // 50. THE FLYOUT IS A CONVERSATION, NOT A SHELL (board audit, 2026-10-12: `messages: []` was hard-coded). With the
        // agent's detail read, the flyout carries the context line (what the agent is doing, in the board's words) and
        // NO thread chips: there are no chat tabs (the owner, 2026-10-18) — the view picks the agent. The context line is
        // the positive control: the chat IS drawn, so zero chips is a count, not a corpse. Messages are counted when there
        // are any; an empty thread says nothing.
        const conversation = await waitFor(
            cdp,
            `Boolean(document.querySelector('[data-chat-context]'))`,
            'the chat context line',
        );
        const chatShape = await cdp.evaluate(`JSON.stringify({
            context: document.querySelector('[data-chat-context]')?.textContent ?? null,
            chips: document.querySelectorAll('[data-chat-thread-chip]').length,
            messages: document.querySelectorAll('[data-chat-message]').length,
            greeting: /How can I help|Hello|Hi there/i.test(document.querySelector('[data-chat]')?.textContent ?? ''),
        })`);
        const shape = JSON.parse(chatShape || '{}');
        check(conversation && shape.chips === 0 && shape.greeting === false, '50. the chat shows the agent\'s context line, no thread chips, and no fake greeting', chatShape);
    }

    // A screenshot of the AGENT VIEW, while we are on it. The Dashboard one is taken at the
    // end, after Back, so without this there would be no picture of the screen that matters
    // most — and a surface nobody has looked at is how this product got here.
    const agentShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (agentShot.result?.data) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(shotPath('smoke-agent.png'), Buffer.from(agentShot.result.data, 'base64'));
    }

    // The route followed the click, which is what makes the place linkable.
    const routeNow = await cdp.evaluate('document.querySelector("[data-route]")?.textContent ?? ""');
    // An agent's address is genie://{workstation}/{workspace-slug}/{agent} — by NAME: no ULID, no chat= (Tynn #831).
    check(/^genie:\/\/[^/?]+\/[^/?]+\/[^/?]+/.test(routeNow) && !/agent_|chat=|genie:\/\/agent\//.test(routeNow), '22. the address names the agent by workspace and name', routeNow);

    /*
     * BACK, twice, and both steps mean something.
     *
     * Opening the chat is a NAVIGATION — its subject lives in the route — so one Back closes
     * the flyout and leaves you on the agent, and a second returns to the Dashboard. All view
     * state is in the URL precisely so this works.
     *
     * The first version of this check went back once and expected the Dashboard. It failed,
     * and the failure was the EXPECTATION: adding the chat step added a history entry. Worth
     * saying plainly, because "the back button is broken" was the easier conclusion and the
     * wrong one.
     */
    // Since 2026-10-19 the chat CANNOT close and is not in the address (the owner: "the chat is always the workspace agent
    // unless I click on another agents tab"; Tynn #831): opening it is NOT a navigation, so one Back leaves the agent for
    // where you came from — the Dashboard — with the chat still docked beside it.
    await cdp.evaluate('history.back(); true');
    const backHome = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-surface="dashboard"]')) && Boolean(document.querySelector('[data-dock-frame="chat"] [data-chat]'))`,
        'the Dashboard after Back, the chat still docked',
    );
    check(backHome, '23. Back leaves the agent for the Dashboard (opening the chat is no history entry), the chat still docked');
    check(backHome, '24. Back returns to the Dashboard');

    // 52. THE BOARD'S DOORS ARE REAL (board audit, 2026-10-12: "Open workspace →" was a span, no By status, no Chat ⌘J,
    // the group header named the workspace by its id). The header names the seeded workspace by its NAME (never a
    // 26-char id), offers the segmented control and Chat ⌘J, and `Open workspace →` is a button that lands on the
    // workspace; Back returns to the Dashboard.
    const doors = await cdp.evaluate(`JSON.stringify({
        open: document.querySelectorAll('button[data-open-workspace]').length,
        toggle: Boolean(document.querySelector('[data-group-toggle="status"]')),
        chat: Boolean(document.querySelector('button[data-action="chat-genie"]')),
        header: (document.querySelector('[data-workspace] .font-semibold')?.textContent ?? ''),
    })`);
    const d = JSON.parse(doors || '{}');
    check(d.open >= 1 && d.toggle && d.chat && d.header.length > 0 && !/^[0-9a-z]{26}$/i.test(d.header), '52. the Dashboard\'s doors are real: Open workspace, By status, Chat ⌘J, and the group header names the workspace', doors);
    await cdp.evaluate(`document.querySelector('button[data-open-workspace]').click(); true`);
    const landed = await waitFor(cdp, `Boolean(document.querySelector('[data-surface="workspace"]'))`, 'the workspace after Open workspace →');
    check(landed, '53. Open workspace → lands on the workspace');
    await cdp.evaluate('history.back(); true');
    await waitFor(cdp, `Boolean(document.querySelector('[data-surface="dashboard"]'))`, 'the Dashboard after Back');
}

/*
 * THE DECK IS REACHABLE.
 *
 * Not "the Deck renders" — that is a unit test. **Reachable**, by clicking the thing a person
 * would click, which is the check §0.4 is about: a finished surface that nothing navigates to
 * is a surface nobody has.
 *
 * Its band is empty here, because a parked approval needs a provider that sends permission
 * requests and there is none in this container. That is stated rather than faked: the empty
 * state is what an honest Deck shows when nothing needs you.
 */
const deckRow = await cdp.evaluate(`Boolean(document.querySelector('[data-nav="genie://deck"]'))`);
check(deckRow === true, '25. the rail offers the Deck');

if (deckRow) {
    await cdp.evaluate(`document.querySelector('[data-nav="genie://deck"]').click(); true`);
    const onDeck = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-surface="deck"]'))`,
        'the Deck after clicking its rail row',
    );
    check(onDeck, '26. clicking it opens the Deck');

    const empty = await cdp.evaluate(`document.querySelector('[data-deck]')?.getAttribute('data-deck') ?? null`);
    check(empty === 'empty', '27. and it says nothing needs you, rather than showing a blank', String(empty));

    // Back to the Dashboard, so the screenshot at the end is still of the board.
    await cdp.evaluate(`document.querySelector('[data-nav="genie://dashboard"]').click(); true`);
    await waitFor(cdp, `Boolean(document.querySelector('[data-surface="dashboard"]'))`, 'the Dashboard again');
}

/*
 * A REAL APPROVAL, ON SCREEN, ANSWERED.
 *
 * The last item on this build's status that no unit test could close: producing one needs a
 * provider that sends permission requests. `ClaudeDriver.permissionRequests` is false in
 * prism-acp 0.6.1 and `CodexDriver`'s is true, so the smoke points codex at a stub that speaks
 * the real App Server protocol.
 *
 * **Nothing above that stub is mocked.** The real `CodexDriver`, the real session holding the
 * real promise the provider is blocked on, the real host, bridge, registry and UI.
 *
 * SKIPPED rather than failed when no codex agent is seeded: the approval path and the rest of
 * the smoke are separable, and a missing seed should not read as a broken surface.
 */
/*
 * THE APPROVAL ROUND TRIP — on by default, because it passes.
 *
 * It was opt-in for a while: I put it in the merge gate before it worked and turned `main` red,
 * which is the one thing a gate must never be. It is back in now that it earns its place.
 *
 * `SMOKE_APPROVAL=0` turns it off, for an environment where the stub cannot run. Nothing in CI
 * sets that — the escape hatch exists for a person debugging, not for the gate.
 *
 * Three defects came out of building it, every one of which would have shipped:
 *  - a provider that could not start failed SILENTLY (`onProtocolError`/`onStderr` dropped);
 *  - `onRequestPermission` was never forwarded, so the whole feature was unreachable;
 *  - a parked approval notified NOBODY, so the screen stayed blank while the session held it.
 *
 * None was findable by a unit test. All three were found by insisting on seeing it happen.
 */
const approvalEnabled = process.env.SMOKE_APPROVAL !== '0';

const codexRow = approvalEnabled
    ? await cdp.evaluate(`
    (() => {
        const rows = [...document.querySelectorAll('[data-agent]')];
        // The row shows the provider as its LOGO now (genie#1266), so the word is no longer in its text.
        const row = rows.find((r) => r.querySelector('[data-provider-logo="codex"]'));
        return row ? row.getAttribute('data-agent') : null;
    })()
`)
    : null;

if (!approvalEnabled) {
    console.log('  ----  the approval round trip is OFF (SMOKE_APPROVAL=0)');
} else if (typeof codexRow !== 'string') {
    console.log('  SKIP  the approval round trip — no codex agent was seeded');
} else {
    // The agent's PAGE, by its route: a Dashboard row click now opens the chat beside the board (genie#1209, step 17).
    // Start it as the row click used to (App's onOpenAgent: openAgent, then its page) — the approval needs a running agent.
    await cdp.evaluate(`window.genie.openAgent('${codexRow}'); window.location.hash = '#genie://agent/${codexRow}?tab=stream'; true`);
    await waitFor(cdp, `Boolean(document.querySelector('[data-surface="agent"]'))`, 'the codex agent');

    // The composer must be REACHABLE — that is a claim about this screen and worth asserting.
    await cdp.evaluate(`document.querySelector('[data-action="chat"]')?.click(); true`);
    const composer = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(CHAT_COMPOSER_INPUT)}))`, 'the composer');
    check(composer, '28a. the composer is open on the codex agent');

    /*
     * Send through the BRIDGE rather than by faking keystrokes.
     *
     * The first version set the textarea's value through the native setter and dispatched a
     * synthetic Ctrl+Enter. That is re-testing Fancy's `PromptInput` keybinding — a controlled
     * component with its own state, already covered by its own suite — and when it silently did
     * not fire, the failure read as "the approval never appeared" rather than "the prompt was
     * never sent". A harness that fails for a reason it does not name costs more than it saves.
     *
     * `window.genie.prompt` is the real IPC path: preload → main → host → session → driver.
     * Everything this check is actually about is downstream of here.
     */
    await cdp.evaluate(`window.genie.prompt(${JSON.stringify(codexRow)}, 'run the migration'); true`);

    const parked = await waitFor(cdp, `Boolean(document.querySelector('[data-approval]'))`, 'the approval card');

    /*
     * When it does not appear, SAY WHERE IT STOPPED.
     *
     * A timeout on "the approval card" is true and useless: it cannot distinguish a provider
     * that never asked, a session that never parked it, a bridge that did not carry it, and a
     * component that did not render it. Four quite different problems behind one message.
     *
     * So the state is read back through the bridge and printed. This stays in permanently — a
     * check that explains its own failure is worth more than one that only passes.
     */
    if (!parked) {
        const state = await cdp.evaluate(`
            (async () => {
                const d = await window.genie.agentDetail(${JSON.stringify(codexRow)});
                return JSON.stringify({
                    running: d?.session?.running ?? null,
                    turnState: d?.session?.turnState ?? null,
                    pendingApproval: d?.session?.pendingApproval ?? null,
                    failure: d?.session?.failure ?? null,
                    refusal: d?.refusal ?? null,
                    rowCount: d?.rows.length ?? null,
                    rowKinds: [...new Set((d?.rows ?? []).map((r) => r.event.kind))],
                });
            })()
        `);
        console.log(`        session state: ${state}`);
    }
    check(parked, '29. a REAL parked approval renders on screen');

    if (parked) {
        const question = await cdp.evaluate(`document.querySelector('[data-approval-question]')?.textContent ?? ''`);
        check(question.includes('migrate'), "30. showing the PROVIDER's own words, not ours", question);

        const options = await cdp.evaluate(`
            JSON.stringify([...document.querySelectorAll('[data-approval-option]')]
                .map((b) => ({ id: b.getAttribute('data-approval-option'), tone: b.getAttribute('data-tone') })))
        `);
        const parsedOptions = JSON.parse(options || '[]');
        check(parsedOptions.length >= 2, "31. with the provider's own options", options);

        /*
         * Tone comes from the protocol's `kind`, never from the label. A provider could ship an
         * option called "Allow once and remember" that denies, and a substring match on "allow"
         * would paint a deny button green — the most dangerous way this surface could be wrong.
         */
        check(
            parsedOptions.some((o) => o.tone === 'ok') && parsedOptions.some((o) => o.tone === 'bad'),
            '32. coloured from the protocol kind, not from the label',
        );

        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result?.data) {
            const { writeFileSync } = await import('node:fs');
            writeFileSync(shotPath('smoke-approval.png'), Buffer.from(shot.result.data, 'base64'));
        }

        // ANSWER IT. The provider is blocked on one promise, so this is the whole round trip:
        // click → bridge → host → session → driver → the stub, which logs the decision it got.
        const first = parsedOptions[0]?.id;
        await cdp.evaluate(`document.querySelector('[data-approval-option="${first}"]').click(); true`);

        const cleared = await waitFor(
            cdp,
            `!document.querySelector('[data-approval]')`,
            'the approval clearing once answered',
        );
        check(cleared, '33. answering it CLEARS it — the round trip completed');

        /*
         * 33a–c. THE CHAT'S COPY BUTTONS, IN A REAL WINDOW (genie#1263, react-fancy 5.67.0). The stub answers the approval
         * with a reply holding one code block, one table and one <result>. react-fancy adds its copy buttons AFTER mount,
         * so no static render can count them — and fancy tested them in jsdom only. Here: exactly one per block (fancy's
         * on the code and the table, Genie's on the result, none of Genie's beside fancy's), and a click COPIES — the
         * button turns "copied" only when main wrote the clipboard through Electron and read the same text back.
         */
        const PROSE = `[...document.querySelectorAll('[data-chat] [data-chat-prose]')].find((p) => p.querySelector('[data-chat-result]'))`;

        /*
         * 33d. A <result> STILL ARRIVING IS ITS CARD ALREADY (react-fancy 5.68 `streaming="progressive"`, #1277's behaviour).
         * The stub streams the reply and holds it mid-body (`**Migrated:** us`) until this check creates its release file.
         * Mid-stream: the card is drawn with the body so far, no `<result` shows as text, the reply's renderer streams
         * progressively (Genie told it the reply is still arriving), and the code block that DID finish has its copy button.
         */
        const { writeFileSync: writeRelease } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join: joinPath } = await import('node:path');
        const midCard = await waitFor(cdp, `(() => { const r = ${PROSE}?.querySelector('[data-chat-result]'); return Boolean(r && r.textContent.includes('Migrated:') && !r.textContent.includes('users')); })()`, 'the <result> card mid-stream');
        const mid = await cdp.evaluate(`(() => { const p = ${PROSE}; if (!p) return '{}'; const root = p.querySelector('[data-react-fancy-content-renderer]'); return JSON.stringify({
            mode: root?.getAttribute('data-streaming-mode') ?? null, body: p.querySelector('[data-chat-result]')?.textContent ?? null,
            raw: /<\\/?result/.test(p.textContent), code: p.querySelectorAll('[data-react-fancy-content-copy="code"]').length }); })()`);
        // Release the rest of the reply whatever happened above: the checks after this one need the whole of it.
        writeRelease(joinPath(tmpdir(), 'genie-stub-codex-stream-release'), '');
        const m = JSON.parse(mid || '{}');
        check(midCard && m.mode === 'progressive' && m.raw === false && m.code === 1 && /Migrated:\s*us$/.test((m.body ?? '').trim()),
            '33d. a streamed <result> shows its card MID-STREAM (react-fancy progressive), never a raw tag', mid);

        const replied = await waitFor(cdp, `Boolean(${PROSE}?.querySelector('[data-react-fancy-content-copy="table"]')) && (${PROSE}?.querySelector('[data-chat-result]')?.textContent ?? '').includes('users')`, 'the whole reply with its copy buttons in the chat');
        const blocks = await cdp.evaluate(`(() => { const p = ${PROSE}; if (!p) return '{}'; const n = (s) => p.querySelectorAll(s).length; return JSON.stringify({
            pre: n('pre'), tables: n('table'), code: n('[data-react-fancy-content-copy="code"]'), table: n('[data-react-fancy-content-copy="table"]'),
            result: n('[data-copy="result"]'), genieCodeOrTable: n('[data-copy="code"], [data-copy="table"]'), live: n('[data-react-fancy-content-renderer-live]') }); })()`);
        const b = JSON.parse(blocks || '{}');
        check(replied && b.pre === 1 && b.tables === 1 && b.code === 1 && b.table === 1 && b.result === 1 && b.genieCodeOrTable === 0 && b.live === 1,
            '33a. ONE copy button per block in the chat: react-fancy’s on the code and the table, Genie’s on the result', blocks);

        await cdp.evaluate(`${PROSE}?.querySelector('[data-react-fancy-content-copy="code"]')?.click(); true`);
        const codeCopied = await waitFor(cdp, `${PROSE}?.querySelector('[data-react-fancy-content-copy="code"]')?.getAttribute('data-copy-state') === 'copied' && ${PROSE}?.querySelector('[data-react-fancy-content-renderer-live]')?.textContent === 'Copied'`, 'the code copy to be confirmed');
        check(codeCopied, '33b. "Copy code" writes through main’s clipboard and says Copied', await cdp.evaluate(`${PROSE}?.querySelector('[data-react-fancy-content-copy="code"]')?.getAttribute('data-copy-state') ?? null`));

        await cdp.evaluate(`${PROSE}?.querySelector('[data-copy="result"]')?.click(); true`);
        const resultCopied = await waitFor(cdp, `${PROSE}?.querySelector('[data-copy="result"]')?.getAttribute('data-copy-state') === 'copied'`, 'the result copy to be confirmed');
        check(resultCopied, '33c. "Copy result" writes through main’s clipboard (rich) and says Copied', await cdp.evaluate(`${PROSE}?.querySelector('[data-copy="result"]')?.getAttribute('data-copy-state') ?? null`));

        /*
         * 64a. A LONG CONVERSATION SCROLLED BACK DOES NOT STRETCH THE WINDOW (genie#1290). The reply above carries
         * absolutely positioned "Copied" live regions. A conversation longer than the chat, read from its start, puts
         * them far below the chat's fold; on beta.48 they escaped the chat scroller and the DOCUMENT grew, so the whole
         * shell could scroll up. A spacer before the conversation makes it that long, the chat goes to its start, and
         * the document is measured AND pushed (a programmatic scroll, as a focus() or scrollIntoView would do). Then
         * everything is put back, in the same evaluate.
         */
        const scrolledBack = await cdp.evaluate(`(() => {
            const log = document.querySelector('[data-chat] [data-chat-log]'); const sc = document.querySelector('[data-chat] [data-chat-scroll]');
            if (!log || !sc) return JSON.stringify({ missing: true });
            const spacer = document.createElement('div'); spacer.style.height = '4000px'; spacer.style.flexShrink = '0';
            log.insertBefore(spacer, log.firstChild); sc.scrollTop = 0;
            const d = document.scrollingElement; d.scrollTop = 100000;
            const r = { chatTop: sc.scrollTop, chatScroll: sc.scrollHeight, top: d.scrollTop, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight };
            d.scrollTop = 0; spacer.remove(); sc.scrollTop = sc.scrollHeight;
            return JSON.stringify(r); })()`);
        const sb = JSON.parse(scrolledBack || '{}');
        check(sb.chatScroll > 4000 && sb.chatTop === 0 && sb.top === 0 && sb.scrollHeight === sb.clientHeight,
            '64a. a long conversation read from its start leaves the window unscrolled: the document cannot scroll (genie#1290)', scrolledBack);

        /*
         * 64c. THE PLAN PILL FOCUSES THE COMPOSER WITHOUT SCROLLING ANYTHING (genie#1290 follow-up, react-fancy 5.69.0).
         * A plan step's chat icon puts a pill into this agent's draft with `setDraft(…, { focus: true })` (#1282). Up to
         * 5.68 that was a bare `focus()`, which scrolls every scrollable ancestor to reveal the composer. The root lock
         * (#1291) keeps the WINDOW still either way, and (measured on omarchy-test, 2026-10-27) nothing between the composer
         * and the root is a scroll container today. So the check MAKES one, as any future layout could: the composer
         * wrapper's parent is held at its current height with `overflow-y: hidden`, and a spacer at its top pushes the
         * composer below its fold, so a scrolling focus WOULD move it. Then:
         *  - the icon is clicked (the person's gesture), and the pill landing in the composer with focus is awaited;
         *  - every ancestor and the document must still be at 0;
         *  - POSITIVE CONTROL in the same arrangement: a bare `focus()` on the composer DOES scroll that ancestor, so a
         *    0 above is a measurement, not an arrangement that could not have moved.
         * Everything is put back afterwards. The seed gives this agent a kept plan (smoke-seed.mjs).
         */
        const planSetup = await cdp.evaluate(`(() => {
            const input = document.querySelector(${JSON.stringify(CHAT_COMPOSER_INPUT)});
            const icon = document.querySelector('[data-surface="agent"] [data-plan-discuss="1"]');
            if (!input || !icon) return JSON.stringify({ missing: { input: !input, icon: !icon, steps: document.querySelectorAll('[data-plan-step]').length } });
            // From Genie's own composer wrapper up: react-fancy's internals are not ours to put a spacer in.
            const box = document.querySelector('[data-chat-composer]')?.parentElement ?? null;
            if (!box) return JSON.stringify({ missing: { composerParent: true } });
            const was = { overflowY: box.style.overflowY, maxHeight: box.style.maxHeight };
            box.style.maxHeight = box.clientHeight + 'px'; box.style.overflowY = 'hidden';
            const spacer = document.createElement('div'); spacer.style.height = '4000px'; spacer.style.flexShrink = '0';
            box.insertBefore(spacer, box.firstChild); box.scrollTop = 0;
            document.activeElement?.blur?.();
            window.__smoke64c = { box, spacer, input, was };
            icon.click();
            return JSON.stringify({ ok: true, box: box.tagName.toLowerCase() + (box.getAttribute('data-chat-draft') !== null ? '[data-chat-draft]' : '') + '.' + String(box.className).split(/\\s+/).slice(0, 3).join('.'), range: box.scrollHeight - box.clientHeight }); })()`);
        const ps = JSON.parse(planSetup || '{}');
        const pillIn = ps.ok ? await waitFor(cdp, `(() => { const s = window.__smoke64c; return Boolean(s && s.input.isConnected && (document.querySelector('[data-chat-composer]')?.textContent ?? '').includes('Migrate the accounts') && s.input.contains(document.activeElement)); })()`, 'the plan pill in the composer, focused') : false;
        const planScroll = await cdp.evaluate(`(() => {
            const s = window.__smoke64c; if (!s) return '{}';
            const scrolled = []; for (let el = s.input.parentElement; el; el = el.parentElement) if (el.scrollTop !== 0 || el.scrollLeft !== 0) scrolled.push(el.tagName.toLowerCase() + ':' + el.scrollTop);
            const after = { boxTop: s.box.scrollTop, docTop: document.scrollingElement.scrollTop, scrolled, focused: s.input.contains(document.activeElement) };
            s.input.blur(); s.box.scrollTop = 0; s.input.focus();
            const control = s.box.scrollTop;
            s.input.blur(); s.spacer.remove(); s.box.scrollTop = 0; s.box.style.overflowY = s.was.overflowY; s.box.style.maxHeight = s.was.maxHeight; delete window.__smoke64c;
            return JSON.stringify({ ...after, control }); })()`);
        const pc = JSON.parse(planScroll || '{}');
        check(ps.ok && ps.range > 0 && pillIn && pc.focused && pc.boxTop === 0 && pc.docTop === 0 && (pc.scrolled ?? []).length === 0 && pc.control > 0,
            '64c. a plan step’s chat icon puts its pill in the composer, focused, and scrolls nothing; a bare focus() there would (genie#1290, react-fancy 5.69)',
            `${planSetup} · ${planScroll}`);
    }
}

/*
 * 35–38. A REAL TERMINAL, through the whole stack.
 *
 * Rail → Workspace surface → `+ terminal` → fancy-term-host spawns the user's shell →
 * keystrokes through xterm → preload → main → pty → output back the same way → xterm's rows.
 * Nothing is mocked above the shell. This is P5's done-when: a command runs in a terminal, and
 * no agent has one.
 *
 * The token is random, and the assertion is a COUNT: once Enter is pressed the token must
 * appear at least twice in xterm's rows — the line as typed, and the line the shell PRINTED.
 * Before Enter it appears exactly once (the positive control that the typed text landed in the
 * terminal at all). A single occurrence after Enter would mean the keystrokes reached xterm and
 * the pty never ran them, which is the failure this check exists to see.
 */
/*
 * 55. CTRL+K — THE COMMAND WINDOW (Tynn #757; Genie 1's Ctrl+K). The title bar's "Search, jump, run · Ctrl K" opened
 * nothing. Driven here because Fancy's Command mounts its body only in a real window: the chord opens it, a COMPLETE
 * prefix narrows it (`w> tynn` — workspaces only, and Fancy's own text filter does not hide them), Enter goes there.
 */
{
    // A MEASUREMENT beside the check: what keydown actually reached the page (CI Linux failed this step while Windows
    // passed — the record says whether the chord arrived, and as what).
    await cdp.evaluate(`window.__genieKeys = []; window.addEventListener('keydown', (e) => window.__genieKeys.push([e.key, e.code, e.ctrlKey, e.metaKey, e.defaultPrevented]), true); true`);
    const ctrlK = (type) => cdp.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 2 });
    await ctrlK('rawKeyDown');
    await ctrlK('keyUp');
    // Fancy's Command draws in a portal on <body>, outside Genie's wrapper: the palette is found by ITS input.
    const PALETTE_INPUT = `input[placeholder^="Search prompts"]`;
    const opened = await waitFor(cdp, `Boolean(document.querySelector('${PALETTE_INPUT}'))`, 'the Command Window to open');
    const arrived = await cdp.evaluate(`JSON.stringify({ keys: window.__genieKeys, focus: document.activeElement?.tagName ?? null, platform: navigator.platform })`);
    check(opened, '55. Ctrl+K opens the Command Window, its input ready', arrived);
    await cdp.evaluate(`document.querySelector('${PALETTE_INPUT}')?.focus(); true`);
    // The workspace's NAME is what the palette matches (the seeded workspace is named "genie", its id is tynn): `w>`
    // alone lists every workspace and nothing else — the prefix is what is under test.
    await cdp.send('Input.insertText', { text: 'w>' });
    const listed = await waitFor(cdp, `document.querySelectorAll('[data-command-item^="workspace:"]').length >= 1 && document.querySelectorAll('[data-command-item^="agent:"], [data-command-item^="action:"]').length === 0`, 'only workspaces to be listed for w>');
    const counts = await cdp.evaluate(`(() => { const input = document.querySelector('${PALETTE_INPUT}'); const box = input ? input.closest('.fixed') ?? input.parentElement?.parentElement : null; return JSON.stringify({ workspaces: document.querySelectorAll('[data-command-item^="workspace:"]').length, others: document.querySelectorAll('[data-command-item]:not([data-command-item^="workspace:"])').length, value: input ? input.value : null, open: Boolean(input), options: box ? box.querySelectorAll('[role="option"], button, li').length : null, text: box ? box.innerText.slice(0, 240) : null }); })()`);
    check(listed, '55a. "w>" lists the workspaces and nothing else — the prefix narrows; Fancy’s own filter does not hide them', counts);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const landed = await waitFor(cdp, `new RegExp(${JSON.stringify(ADDRESS.workspace)}).test(document.querySelector('[data-route]')?.textContent ?? '') && !document.querySelector('${PALETTE_INPUT}')`, 'Enter to open the workspace');
    check(landed, '55b. Enter opens the chosen workspace and closes the window');
}

/*
 * 56. SAVED PROMPTS WITH THEIR OWN HOTKEYS (Tynn #758; the owner, 2026-10-17: "the ability to create prompts I can assign
 * hotkeys to is missing"). Settings → Agents: Add a prompt, name it, give it text, Save; click its hotkey box and press
 * Ctrl+Alt+P — the box reads it back; Ctrl+K, `p>` lists it with that key beside it. Not SENT here: CI has no signed-in
 * provider, and the send itself is the chat's own path (unit-tested in test/prompt-library.test.ts for where it goes).
 */
{
    // GENIE 1'S SIDEBAR (2026-10-19): open Settings, then CLICK the sidebar's Saved prompts — the click navigating is
    // the thing proven here (the unit tests have no DOM to click in).
    await cdp.evaluate(`window.location.hash = '#genie://settings'; true`);
    const sidebar = await waitFor(cdp, `Boolean(document.querySelector('[data-settings-nav="prompts"]'))`, 'the Settings sidebar');
    if (sidebar) await cdp.evaluate(`document.querySelector('[data-settings-nav="prompts"]').click(); true`);
    const onSettings = sidebar && await waitFor(cdp, `Boolean(document.querySelector('[data-settings-page="prompts"] [data-saved-prompts] [data-action="prompt-add"]'))`, 'the sidebar to open Saved prompts');
    check(onSettings, '56. Settings → the sidebar’s Saved prompts opens its page, with Add', await cdp.evaluate(`window.location.hash`));
    /*
     * THE PROMPT THIS RUN MAKES, named uniquely and found by its row (beta.30's Windows VM check, 2026-10-17): the VM runs
     * this smoke twice on ONE profile (from dist/, then the installed app), so the second run started with the first's
     * prompt — "exactly one row" passed on the OLD row before the new save landed, and the hotkey went to the old one.
     * First the smoke removes its own earlier prompts (named "Smoke status…"), counted; then it adds one and waits for
     * the count to rise by exactly one with THAT name.
     */
    const SMOKE_NAME = 'Smoke status';
    const rowsNamed = (prefix) => `[...document.querySelectorAll('[data-saved-prompt]')].filter((r) => (r.querySelector('input')?.value ?? '').startsWith(${JSON.stringify(prefix)}))`;
    for (let i = 0; i < 5; i++) {
        const left = await cdp.evaluate(`${rowsNamed(SMOKE_NAME)}.length`);
        if (!left) break;
        await cdp.evaluate(`${rowsNamed(SMOKE_NAME)}[0].querySelector('[data-action="prompt-remove"]').click(); true`);
        await waitFor(cdp, `${rowsNamed(SMOKE_NAME)}.length === ${left - 1}`, 'an earlier run’s prompt to be removed');
    }
    const before = await cdp.evaluate(`document.querySelectorAll('[data-saved-prompt]').length`);
    const name = `${SMOKE_NAME} ${Math.random().toString(16).slice(2, 8)}`;
    await cdp.evaluate(`document.querySelector('[data-saved-prompts] [data-action="prompt-add"]').click(); true`);
    await waitFor(cdp, `Boolean(document.querySelector('[data-prompt-draft] input'))`, 'the new-prompt draft');
    await cdp.evaluate(`document.querySelector('[data-prompt-draft] input').focus(); true`);
    await cdp.send('Input.insertText', { text: name });
    await cdp.evaluate(`document.querySelector('[data-prompt-draft] textarea').focus(); true`);
    await cdp.send('Input.insertText', { text: 'Where are you up to?' });
    await cdp.evaluate(`document.querySelector('[data-action="prompt-save"]')?.click(); true`);
    const saved = await waitFor(cdp, `document.querySelectorAll('[data-saved-prompt]').length === ${before + 1} && ${rowsNamed(name)}.length === 1 && !document.querySelector('[data-prompt-draft]')`, 'the prompt to be saved');
    check(saved, '56a. a new prompt is saved once it has a name and text — and stays (it is not dropped as unusable)', await cdp.evaluate(`JSON.stringify({ before: ${before}, now: document.querySelectorAll('[data-saved-prompt]').length, mine: ${rowsNamed(name)}.length })`));
    const rowId = await cdp.evaluate(`${rowsNamed(name)}[0]?.getAttribute('data-saved-prompt') ?? ''`);
    const hotkeyBox = `[data-saved-prompt="${rowId}"] input[data-prompt-hotkey], [data-saved-prompt="${rowId}"] [data-prompt-hotkey] input`;
    await cdp.evaluate(`document.querySelector('${hotkeyBox}')?.focus(); true`);
    const ctrlAltP = (type) => cdp.send('Input.dispatchKeyEvent', { type, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80, modifiers: 3 });
    await ctrlAltP('rawKeyDown');
    await ctrlAltP('keyUp');
    const recorded = await waitFor(cdp, `(document.querySelector('${hotkeyBox}')?.value ?? '') === 'Ctrl+Alt+P'`, 'the hotkey to be recorded');
    check(recorded, '56b. pressing Ctrl+Alt+P in its hotkey box assigns it, and the box reads it back', await cdp.evaluate(`JSON.stringify(document.querySelector('${hotkeyBox}')?.value ?? null)`));
    const ctrlK = (type) => cdp.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 2 });
    await cdp.evaluate(`document.activeElement?.blur?.(); true`);
    await ctrlK('rawKeyDown');
    await ctrlK('keyUp');
    const PALETTE_INPUT = `input[placeholder^="Search prompts"]`;
    await waitFor(cdp, `Boolean(document.querySelector('${PALETTE_INPUT}'))`, 'the Command Window to open');
    await cdp.evaluate(`document.querySelector('${PALETTE_INPUT}')?.focus(); true`);
    await cdp.send('Input.insertText', { text: 'p>' });
    // Prompts and nothing else; THIS run's prompt among them, exactly once, with its key beside it.
    const offered = await waitFor(cdp, `document.querySelectorAll('[data-command-item]:not([data-command-item^="prompt:"])').length === 0 && [...document.querySelectorAll('[data-command-item^="prompt:"]')].filter((e) => (e.parentElement?.textContent ?? '').startsWith(${JSON.stringify(name)})).length === 1 && [...document.querySelectorAll('[data-command-item^="prompt:"]')].some((e) => (e.parentElement?.textContent ?? '') === ${JSON.stringify(name)} + 'Ctrl+Alt+P')`, 'the prompt to be offered under p>');
    check(offered, '56c. Ctrl+K, "p>" lists prompts and nothing else — this run’s, once, its hotkey beside it', await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('[data-command-item]')].map((e) => e.parentElement?.textContent ?? ''))`));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(cdp, `!document.querySelector('${PALETTE_INPUT}')`, 'the Command Window to close');
}

{
    const token = `genie-${Math.random().toString(16).slice(2, 10)}`;
    await cdp.evaluate(`document.querySelector('[data-nav="genie://workspace/tynn"]').click(); true`);
    const onWorkspace = await waitFor(cdp, `Boolean(document.querySelector('[data-surface="workspace"]'))`, 'the Workspace surface');
    check(onWorkspace, '35. the rail reaches the Workspace surface');

    // 61. THE CHAT NEVER CLOSES — AND SHOWS ITS CONVERSATION ON EVERY PAGE (the owner, 2026-10-19, said three times). The
    // page was reached with no `chat=` in the route: the chat still holds its subject's LOADED conversation, not an empty
    // panel that reads as closed (the conversation used to load for the route's `chat=` only).
    const chatHere = await waitFor(cdp, `Boolean(document.querySelector('[data-dock-frame="chat"] [data-chat][data-chat-loaded="true"]'))`, 'the chat to show its conversation');
    const chatState = await cdp.evaluate(`(() => ({ route: location.hash || location.href, loaded: document.querySelector('[data-chat]')?.getAttribute('data-chat-loaded') ?? null }))()`);
    check(chatHere, '61. a page reached without chat= still shows the chat with its loaded conversation', JSON.stringify(chatState));

    // 63. ADDRESSES ARE genie://{workstation}/{workspace-slug}/{tab} (the owner, 2026-10-19; Tynn #831): an OLD address with
    // a chat= in it is rewritten in place — the workspace by its slug, no id, no chat=.
    await cdp.evaluate(`window.location.hash = '#genie://workspace/tynn?chat=genie'; true`);
    const rewritten = await waitFor(cdp, `(() => { const a = document.querySelector('[data-route]')?.textContent ?? ''; return new RegExp(${JSON.stringify(ADDRESS.workspace)}).test(a) && !a.includes('chat=') && !a.includes('workspace/'); })()`, 'the old address rewritten to the new form');
    check(rewritten, '63. an old address is rewritten to genie://{workstation}/{workspace-slug}/dashboard — no id, no chat=', await cdp.evaluate(`document.querySelector('[data-route]')?.textContent ?? null`));

    // 62. THE FILE TREE LOADS A FOLDER WHEN IT IS OPENED, AND NOTHING OPENS BY ITSELF (the owner, 2026-10-19: "I can't load
    // files below the 3rd layer and when it opens all folders are open at once"). Over this checkout: the panel opens with
    // top-level rows only; opening `src` lists its children; a file named by the route reveals its folders and opens.
    const rowIds = `[...document.querySelectorAll('[data-files-panel] [data-react-fancy-virtual-row-id]')].map((r) => r.getAttribute('data-react-fancy-virtual-row-id'))`;
    await cdp.evaluate(`window.location.hash = '#genie://workspace/tynn?files='; true`);
    const treeUp = await waitFor(cdp, `${rowIds}.includes('src')`, 'the file tree’s top level');
    const closedRows = treeUp ? await cdp.evaluate(rowIds) : [];
    await cdp.evaluate(`[...document.querySelectorAll('[data-files-panel] [data-react-fancy-virtual-row-id="src"] button')][0]?.click(); true`);
    const srcOpened = await waitFor(cdp, `${rowIds}.some((id) => id && id.startsWith('src/'))`, 'src’s children, loaded on open');
    const deep = 'src/renderer/components/FilesPanel.tsx';
    await cdp.evaluate(`window.location.hash = '#genie://workspace/tynn?files=' + encodeURIComponent(${JSON.stringify(deep)}); true`);
    // The tree is windowed, so the file's own row may sit below the fold: its FOLDER's row (revealed) and its open tab are the evidence.
    const revealed = await waitFor(cdp, `${rowIds}.includes('src/renderer/components') && Boolean(document.querySelector('[data-file-tab=${JSON.stringify(deep)}]'))`, 'the routed file revealed and open');
    const nested = Array.isArray(closedRows) ? closedRows.filter((id) => typeof id === 'string' && id.includes('/')).length : -1;
    check(treeUp && nested === 0 && srcOpened && revealed, '62. the file tree opens with nothing expanded, lists a folder when opened, and reveals a routed file', JSON.stringify({ top: Array.isArray(closedRows) ? closedRows.length : null, nestedAtStart: nested, srcOpened, revealed }));
    await cdp.evaluate(`window.location.hash = '#genie://workspace/tynn'; true`);
    await waitFor(cdp, `Boolean(document.querySelector('[data-surface="workspace"]'))`, 'the Workspace surface again');

    // 48–49. THE OWNER'S THIRD LOOK (beta.8): "when I select a workspace, I should not see the workspace settings";
    // and 2026-10-19: the first tab is the WORKSPACE DASHBOARD, not an agent list (q_09d1f4a0). The route opens on it —
    // the seeded agent in the header's strip, the dashboard's "Working in" section — and NO settings section. The terminals are a PANEL in a tab you design (Tynn #282, 2026-10-17): the small +
    // makes a tab, the tab offers every panel kind, and a Terminals panel is ONE terminal (beta.33 item 9: the owner, "a
    // terminal panel is 1 panel for that terminal") — placing it starts the terminal; no manager, no + terminal inside.
    const home = await cdp.evaluate(`(() => ({
        dashboard: Boolean(document.querySelector('[data-workspace-dashboard]')),
        pills: document.querySelectorAll('[data-agent-pill]').length,
        tab: document.querySelector('[data-workspace-tab="home"]')?.textContent ?? null,
        settings: Boolean(document.querySelector('[data-workspace-settings]')),
        terminals: Boolean(document.querySelector('[data-terminal-tabs]')),
    }))()`);
    check(home.dashboard && home.pills >= 1 && home.tab === 'Dashboard' && !home.settings && !home.terminals, '48. the workspace opens on its dashboard — the seeded agent in the strip, the Dashboard tab, no settings, no terminals', JSON.stringify(home));
    await cdp.evaluate(`document.querySelector('[data-workspace-tab="add"]').click(); true`);
    const designer = await waitFor(cdp, `Boolean(document.querySelector('[data-designed-tab] [data-add-panel="terminal"]')) && !document.querySelector('[data-workspace-dashboard]')`, 'the new tab to open on its designer');
    check(designer, '49a. + makes a tab that opens on its panel designer (and puts the dashboard away)');
    await cdp.evaluate(`document.querySelector('[data-designed-tab] [data-add-panel="terminal"]').click(); true`);
    const terminalsView = await waitFor(cdp, `Boolean(document.querySelector('[data-panel="terminal"] [data-terminal-panel]')) && !document.querySelector('[data-panel="terminal"] [data-terminal-add]') && !document.querySelector('[data-panel="terminal"] [data-terminal-tabs]')`, 'the Terminals panel’s own terminal');
    check(terminalsView, '49. a Terminals panel in that tab is ONE terminal, started by placing it — no manager, no + terminal');

    const paneUp = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-panel="terminal"] [data-terminal-pane] .xterm-rows'))`,
        'an xterm to mount for the panel’s terminal',
    );
    check(paneUp, '36. the panel’s terminal is a real terminal pane with xterm mounted');

    // Let the shell print its prompt, then focus xterm's textarea and type.
    await new Promise((r) => setTimeout(r, 1200));
    await cdp.evaluate(`document.querySelector('[data-terminal-pane] textarea')?.focus(); true`);
    await cdp.send('Input.insertText', { text: `echo ${token}` });
    // The rows JOINED, without the line breaks between them: a narrow pane WRAPS the typed command ("echo g" / "enie-…"),
    // and counting per line read it as absent — 37 and 38 failed on the Windows VM's 1024-px window (beta.32, the docked
    // chat taking half of it) while the shell had run it. The token is random, so joining rows cannot make one up.
    const rowsText = `(document.querySelector('[data-terminal-pane] .xterm-rows')?.innerText ?? '').replace(/\\n/g, '')`;
    const typed = await waitFor(cdp, `${rowsText}.split('${token}').length - 1 === 1`, 'the typed token to show once');
    check(typed, '37. CONTROL: the typed command shows in the terminal, once, before Enter', token);

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const ran = await waitFor(cdp, `${rowsText}.split('${token}').length - 1 >= 2`, 'the shell to print the token back');
    const count = await cdp.evaluate(`${rowsText}.split('${token}').length - 1`);
    check(ran, '38. the SHELL ran it — the token comes back as output, not just as typed', `${count} occurrence(s)`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(shotPath('smoke-terminal.png'), Buffer.from(shot.result.data, 'base64'));
    }
}

/*
 * 39–40. TAKE OVER opens a second window (§1).
 *
 * The Agent view's `Take over` button asks the main process to open the agent's TUI in a
 * terminal in a NEW BrowserWindow. From outside, a new window is a new CDP page target whose
 * URL ends in `#genie://takeover/<terminalId>` — so the check is a COUNT of such targets: zero
 * before the click (the control), exactly one after.
 *
 * The TUI itself is not asserted. On CI and in the VM `claude` is not installed, so the shell
 * reports it missing and the terminal ends; the window still opens and the terminal was still
 * spawned in the agent's workspace, which is the path this build owns. Whether the TUI runs is
 * the TUI's business and the owner's machine's.
 */
{
    const takeoverTargets = async () => {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        // genie://takeover/<id>, or the address it is rewritten to, genie://{workstation}/takeover/<id> (Tynn #831).
        return list.filter((t) => t.type === 'page' && /#genie:\/\/(?:[^/?#]+\/)?takeover\//.test(String(t.url)));
    };
    const before = (await takeoverTargets()).length;
    check(before === 0, '39. CONTROL: no take-over window exists before the click', `${before} target(s)`);

    await cdp.evaluate(`document.querySelector('[data-nav="genie://dashboard"]').click(); true`);
    await waitFor(cdp, `Boolean(document.querySelector('[data-surface="dashboard"]'))`, 'the Dashboard');
    // The agent's PAGE, by its route (a row click opens its chat beside the board, genie#1209).
    await cdp.evaluate(`(() => { const id = document.querySelector('[data-surface="dashboard"] div[data-workspace] [data-agent]')?.getAttribute('data-agent'); if (id) window.location.hash = '#genie://agent/' + id + '?tab=stream'; return true; })()`);
    const onAgent = await waitFor(cdp, `Boolean(document.querySelector('[data-action="take-over"]'))`, 'the Agent view with its Take over control');
    if (onAgent) {
        await cdp.evaluate(`document.querySelector('[data-action="take-over"]').click(); true`);
        let after = 0;
        for (let i = 0; i < 40; i += 1) {
            after = (await takeoverTargets()).length;
            if (after > 0) break;
            await new Promise((r) => setTimeout(r, 250));
        }
        check(after === 1, '40. "Take over" opens exactly ONE new window on a take-over route', `${after} target(s)`);
    } else {
        check(false, '40. "Take over" opens exactly ONE new window on a take-over route', 'the Agent view never showed the control');
    }
}

// 10b. THE WINDOW A PERSON GETS. The owner's first real run: no window buttons, no drag region, a
// `genie` row that landed on "No agent is registered". A script never drags, so what CAN be asked
// of the real window is asked: the overlay is visible (so the native buttons are drawn), the bar
// is the drag region, and the rail's genie row opens the OS agent.
{
    const overlay = await cdp.evaluate('Boolean(navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible)');
    check(overlay === true || process.platform === 'darwin', '41. the native window buttons are drawn over the bar (titleBarOverlay visible)', String(overlay));
    const region = await cdp.evaluate(`getComputedStyle(document.querySelector('[data-title-bar]')).getPropertyValue('-webkit-app-region')`);
    check(region === 'drag', '42. the title bar is the drag region', `-webkit-app-region: ${region || '(none)'}`);
    await cdp.evaluate(`document.querySelector('[data-nav="genie://agent/genie"]').click(); true`);
    const osAgent = await waitFor(cdp, `Boolean(document.querySelector('[data-surface="agent"]')) && !document.querySelector('[data-surface="agent-unknown"]')`, 'the OS agent page');
    check(osAgent, '43. the rail\'s genie row opens the OS agent, not "No agent is registered"');

    // 10c. THE OWNER'S SECOND LOOK (beta.7): ids where names belong, no Settings row, a white composer on a dark app on a
    // light desktop. The rail row's text is the seeded workspace's NAME (never its id); Settings is a labelled row;
    // the document's theme class matches what the OS prefers (the VM's Windows is light), and the chat composer's
    // background is on the same side of mid-grey as the page's — the two must agree whichever side that is.
    const railText = await cdp.evaluate(`(document.querySelector('[data-workspace]')?.textContent ?? '')`);
    check(railText.length > 0 && !/^[0-9a-z]{26}$/i.test(railText.trim()) && !railText.includes('tynn\n'), '44. the rail names the workspace, not its id', JSON.stringify(railText.trim().slice(0, 40)));
    check(Boolean(await cdp.evaluate(`Boolean(document.querySelector('[data-nav="genie://settings"]'))`)), '45. the rail offers a Settings row');
    const theme = await cdp.evaluate(`(() => {
        const dark = document.documentElement.classList.contains('dark');
        const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const lum = (el) => { const m = getComputedStyle(el).backgroundColor.match(/\\d+(\\.\\d+)?/g); if (!m || m.length < 3) return null; const [r, g, b] = m.map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
        const page = lum(document.body);
        const composer = document.querySelector('[data-mobile-composer], [data-composer], textarea[name="text"]');
        const box = composer ? lum(composer.closest('form') ?? composer.parentElement ?? composer) : null;
        return { dark, osDark, page, box };
    })()`);
    check(theme.dark === theme.osDark, '46. the theme follows the OS preference (no forced dark)', `class dark=${theme.dark}, OS prefers dark=${theme.osDark}`);
    check(theme.page !== null && (theme.box === null || (theme.page < 0.5) === (theme.box < 0.5)), '47. the chat composer and the page are on the same side of the theme', `page ${theme.page?.toFixed(2)} composer ${theme.box === null ? '(none open)' : theme.box.toFixed(2)}`);
}

/*
 * 57. GENIE'S KEYS AND MENU (Tynn #759). Ctrl+, opens Settings — the page's own chord, on every platform.
 *
 * 57a. With no menu set, Electron's default was in force: its Ctrl+W closes — on Genie's main window, HIDES to the tray
 * — from any field. Genie's menu has no Close accelerator. "Still visible after Ctrl+W" is evidence ONLY where a menu
 * accelerator demonstrably fires on a key sent this way: CI's Linux window delivered none (#911 — Ctrl+, through the
 * menu never arrived there), so a visible window there would have proved nothing. The POSITIVE CONTROL is F11, the
 * menu's togglefullscreen role: the window's size changes when it fires. Where it does not, 57a says it could not be
 * measured, rather than passing. Visibility is the page's own (a hidden window reads `document.visibilityState ===
 * 'hidden'`).
 */
{
    const key = (k, code, vk, type, modifiers) => cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    const press = async (k, code, vk, modifiers) => { await key(k, code, vk, 'rawKeyDown', modifiers); await key(k, code, vk, 'keyUp', modifiers); };
    await cdp.evaluate(`document.activeElement?.blur?.(); window.location.hash = '#genie://dashboard'; true`);
    await waitFor(cdp, `new RegExp(${JSON.stringify(ADDRESS.dashboardExact)}).test(document.querySelector('[data-route]')?.textContent ?? '')`, 'the Dashboard');
    await press(',', 'Comma', 188, 2);
    const toSettings = await waitFor(cdp, `new RegExp(${JSON.stringify(ADDRESS.settings)}).test(document.querySelector('[data-route]')?.textContent ?? '')`, 'Ctrl+, to open Settings');
    check(toSettings, '57. Ctrl+, opens Settings', await cdp.evaluate(`document.querySelector('[data-route]')?.textContent ?? null`));

    const size = () => cdp.evaluate(`window.innerWidth + 'x' + window.innerHeight`);
    const before = await size();
    await press('F11', 'F11', 122, 0);
    const fired = await waitFor(cdp, `(window.innerWidth + 'x' + window.innerHeight) !== '${before}'`, 'F11 (the menu’s togglefullscreen) to change the window size');
    if (fired) {
        await press('F11', 'F11', 122, 0);
        await waitFor(cdp, `(window.innerWidth + 'x' + window.innerHeight) === '${before}'`, 'F11 again to restore the window size');
        await press('w', 'KeyW', 87, 2);
        await new Promise((r) => setTimeout(r, 1500));
        const after = await cdp.evaluate(`JSON.stringify({ visibility: document.visibilityState, size: window.innerWidth + 'x' + window.innerHeight })`);
        check(JSON.parse(after).visibility === 'visible', '57a. Ctrl+W does not hide Genie — measured: F11 showed menu accelerators fire in this window', after);
    } else {
        console.log(`  NOTE  57a. Ctrl+W NOT MEASURED here: F11 (a menu accelerator) did not fire in this window, so a visible window would prove nothing — ${before}`);
    }
}

// 12. THE HEADER ROW (the owner, 2026-10-13: "content covered and not following color theme"). On Windows and Linux the
// native minimize / maximize / close buttons are drawn over the bar's right end: the bar must keep that space clear, and
// the buttons must wear the theme's own bar colours — in BOTH themes.
const chrome = await cdp.evaluate(`(async () => {
    const wc = window.genie?.windowChrome;
    const bar = document.querySelector('[data-title-bar]');
    const chip = document.querySelector('[data-workstation-health]');
    const inset = Number(bar?.getAttribute('data-controls-inset') ?? 'NaN');
    return JSON.stringify({ overlay: wc?.overlay === true, inset, chipRight: chip ? chip.getBoundingClientRect().right : null, width: window.innerWidth });
})()`);
const ch = JSON.parse(chrome);
if (ch.overlay) {
    check(ch.inset > 0, '48. the bar measures the space the native window buttons take', `inset ${ch.inset}px`);
    check(ch.chipRight !== null && ch.chipRight <= ch.width - ch.inset + 1, '49. nothing sits under the native window buttons (the workstation chip ends before them)', `chip right ${ch.chipRight?.toFixed?.(0)} / clear from ${ch.width - ch.inset}`);
    const themed = await cdp.evaluate(`(async () => {
        const hex = (v) => { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillStyle = v.trim(); x.fillRect(0, 0, 1, 1); const [r, g, b] = x.getImageData(0, 0, 1, 1).data; return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join(''); };
        const want = () => hex(getComputedStyle(document.documentElement).getPropertyValue('--bg-1'));
        const settle = async (expected) => { for (let i = 0; i < 40; i += 1) { const cur = await window.genie.windowChrome.current(); if (cur && cur.color === expected) return cur.color; await new Promise((r) => setTimeout(r, 100)); } const cur = await window.genie.windowChrome.current(); return cur ? cur.color : null; };
        const html = document.documentElement;
        const startDark = html.classList.contains('dark');
        const first = { want: want(), got: await settle(want()) };
        html.classList.toggle('dark');
        const flipped = { want: want(), got: await settle(want()) };
        html.classList.toggle('dark', startDark);
        const back = { want: want(), got: await settle(want()) };
        return JSON.stringify({ first, flipped, back });
    })()`);
    const t = JSON.parse(themed);
    check(t.first.got === t.first.want && t.flipped.got === t.flipped.want && t.back.got === t.back.want && t.first.want !== t.flipped.want,
        '59. the native window buttons wear the theme\u2019s bar colour, and follow a theme change both ways',
        `first ${t.first.got}/${t.first.want} · flipped ${t.flipped.got}/${t.flipped.want} · back ${t.back.got}/${t.back.want}`);
} else {
    console.log('  (48–50 skipped: this window has no native button overlay — macOS)');
}

// 58. A SOUND LOADS (the owner, 2026-10-19: "None of the sounds work at all"). The window's Content-Security-Policy named
// no media-src, so every <audio> load was refused — and the player swallows a refused play. Here the window loads one
// of its own bundled .wav files through an Audio element: it must load, with no policy violation. Loading does not need
// a speaker, so this holds on a CI machine with none.
{
    const { readdirSync, existsSync } = await import('node:fs');
    const assets = 'dist/renderer/assets';
    const wav = existsSync(assets) ? readdirSync(assets).find((f) => f.endsWith('.wav')) ?? null : null;
    if (!wav) {
        check(false, '58. a bundled sound loads in the window — no media blocked by the security policy', `no .wav under ${assets}`);
    } else {
        const loaded = await cdp.evaluate(`(async () => {
            const violations = [];
            const onViolation = (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI);
            document.addEventListener('securitypolicyviolation', onViolation);
            const url = new URL('assets/' + ${JSON.stringify(wav)}, document.baseURI).href;
            const audio = new Audio();
            audio.preload = 'auto';
            const result = await new Promise((resolve) => {
                audio.addEventListener('canplaythrough', () => resolve('loaded'), { once: true });
                audio.addEventListener('error', () => resolve('error ' + (audio.error ? audio.error.code : '?')), { once: true });
                setTimeout(() => resolve('timeout'), 8000);
                audio.src = url;
                audio.load();
            });
            document.removeEventListener('securitypolicyviolation', onViolation);
            return JSON.stringify({ result, violations, url });
        })()`);
        const s = JSON.parse(loaded || '{}');
        check(s.result === 'loaded' && (s.violations ?? []).length === 0,
            '58. a bundled sound loads in the window — no media blocked by the security policy',
            `${s.result} · ${(s.violations ?? []).join(' | ') || 'no violations'} · ${s.url}`);
    }
}

/*
 * 64b. AFTER EVERYTHING ABOVE — chat sent and streamed, copy buttons clicked, chats switched, surfaces walked — THE WINDOW
 * HAS NOT SCROLLED, and cannot (genie#1290): the document is exactly the window, at 0, and a programmatic push stays at 0.
 */
{
    const end = await cdp.evaluate(`(() => { const d = document.scrollingElement; const before = d.scrollTop; d.scrollTop = 100000;
        const r = { before, pushed: d.scrollTop, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight, body: document.body.scrollTop, root: document.getElementById('root')?.scrollTop ?? null };
        d.scrollTop = 0; return JSON.stringify(r); })()`);
    const e = JSON.parse(end || '{}');
    check(e.before === 0 && e.pushed === 0 && e.body === 0 && e.root === 0 && e.scrollHeight === e.clientHeight,
        '64b. after the whole run the window is unscrolled and unscrollable: scrollTop 0, scrollHeight === clientHeight (genie#1290)', end);
}

// 11. Nothing threw on the way up.
const errors = await cdp.evaluate('JSON.stringify(window.__smokeErrors ?? [])');
const parsed = JSON.parse(errors || '[]');
check(parsed.length === 0, '34. the console is clean', parsed.join(' | ') || 'no errors');

// A screenshot, for a human to look at. Writing one is not the same as somebody having seen
// it, and this script does not claim otherwise.
//
// 65. SMOKE-DASHBOARD.PNG SHOWS THE DASHBOARD (the owner's checklist, 2026-10-14: it showed the genie AGENT view — the run
// ends on an agent's page, and the shot was taken wherever it ended). Land on the Dashboard through the rail first, and
// check that it is what is on screen, so the file is what its name says.
const dashboardShown = await cdp.evaluate(`(() => {
    const surfaces = [...document.querySelectorAll('[data-surface]')].map((s) => s.getAttribute('data-surface'));
    return JSON.stringify({ dashboard: Boolean(document.querySelector('[data-surface="dashboard"]')), agent: Boolean(document.querySelector('[data-surface="agent"]')), surfaces });
})()`);
const ds = JSON.parse(dashboardShown || '{}');
check(ds.dashboard === true && ds.agent === false, '65. the screenshot named smoke-dashboard.png is taken ON the Dashboard (not an agent’s page)', dashboardShown);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(shotPath('smoke-dashboard.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('\n  screenshot written to smoke-dashboard.png (NOT yet looked at by anybody)');
}

cdp.close();

console.log('');
if (failures.length > 0) {
    console.log(`SMOKE FAILED — ${failures.length} of 40:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('SMOKE PASSED — the window opened, the Dashboard was the landing surface, and nothing threw.');

/*
 * EXIT EXPLICITLY, and say what would have kept us alive.
 *
 * On Linux CI this script printed the line above and then did not exit — six runs on
 * 2026-10-10, each eating the job's 15-minute limit (reported as "cancelled", which hid it),
 * then `timeout 300` turning it into exit 124. The checks had all passed; the process simply
 * never ended. Electron's own log was clean.
 *
 * A Node process stays alive for an open handle: a socket whose close handshake the peer never
 * answers, a keep-alive connection, a timer. Which one it was is not knowable from "it hung",
 * so this names them. The script's work is finished at this point; there is nothing legitimate
 * for it to wait on, and exiting here is correct whatever the handle turns out to be.
 */
const open = (process._getActiveHandles?.() ?? []).map((h) => h?.constructor?.name ?? typeof h);
if (open.length > 0) {
    console.log(`  (handles still open at exit: ${open.join(', ')} — exiting explicitly)`);
}
process.exit(0);
