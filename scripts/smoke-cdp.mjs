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
const route = await cdp.evaluate('document.querySelector("[data-route]")?.textContent ?? null');
check(typeof route === 'string' && route.startsWith('genie://dashboard'), '3. the title bar shows the route', String(route));

const features = await cdp.evaluate('document.querySelectorAll("[data-feature]").length');
check(features === 4, '4. the four feature icons are in the title bar', `found ${features}`);

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
        const row = document.querySelector('[data-agent]');
        return row ? JSON.stringify({ id: row.getAttribute('data-agent'), text: row.textContent }) : null;
    })()
`);
check(typeof agentRow === 'string', '16. the seeded agent appears on the Dashboard', String(agentRow));

if (typeof agentRow === 'string') {
    await cdp.evaluate(`document.querySelector('[data-agent]').click(); true`);

    const opened = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-surface="agent"]'))`,
        'the Agent view after clicking a row',
    );
    check(opened, '17. clicking the row OPENS the Agent view');

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
            `Boolean(document.querySelector('[data-chat]') && document.querySelector('textarea'))`,
            'the chat flyout and its composer',
        );
        check(composer, '21. clicking it opens the flyout with a real composer');
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
    check(routeNow.startsWith('genie://agent/'), '22. the route names the agent', routeNow);

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
    await cdp.evaluate('history.back(); true');
    const chatClosed = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-surface="agent"]')) && !document.querySelector('[data-chat]')`,
        'the flyout closing on Back',
    );
    check(chatClosed, '23. Back closes the chat and leaves you on the agent');

    await cdp.evaluate('history.back(); true');
    const backHome = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-surface="dashboard"]'))`,
        'the Dashboard after Back',
    );
    check(backHome, '24. Back again returns to the Dashboard');
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
        const row = rows.find((r) => r.textContent && r.textContent.includes('codex'));
        return row ? row.getAttribute('data-agent') : null;
    })()
`)
    : null;

if (!approvalEnabled) {
    console.log('  ----  the approval round trip is OFF (SMOKE_APPROVAL=0)');
} else if (typeof codexRow !== 'string') {
    console.log('  SKIP  the approval round trip — no codex agent was seeded');
} else {
    await cdp.evaluate(`document.querySelector('[data-agent="${codexRow}"]').click(); true`);
    await waitFor(cdp, `Boolean(document.querySelector('[data-surface="agent"]'))`, 'the codex agent');

    // The composer must be REACHABLE — that is a claim about this screen and worth asserting.
    await cdp.evaluate(`document.querySelector('[data-action="chat"]')?.click(); true`);
    const composer = await waitFor(cdp, `Boolean(document.querySelector('textarea'))`, 'the composer');
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
{
    const token = `genie-${Math.random().toString(16).slice(2, 10)}`;
    await cdp.evaluate(`document.querySelector('[data-nav="genie://workspace/tynn"]').click(); true`);
    const onWorkspace = await waitFor(cdp, `Boolean(document.querySelector('[data-surface="workspace"]'))`, 'the Workspace surface');
    check(onWorkspace, '35. the rail reaches the Workspace surface');

    // 48–49. THE OWNER'S THIRD LOOK (beta.8): "when I select a workspace, I should not see the workspace settings, I
    // should see the agent lanes and all of the agents." The route opens on the agents rail with the seeded agent's
    // card and NO settings section; the terminals are a labelled tab away.
    const home = await cdp.evaluate(`(() => ({
        rail: Boolean(document.querySelector('[data-workspace-home]')),
        cards: document.querySelectorAll('[data-home-agent]').length,
        settings: Boolean(document.querySelector('[data-workspace-settings]')),
        terminals: Boolean(document.querySelector('[data-terminal-tabs]')),
    }))()`);
    check(home.rail && home.cards >= 1 && !home.settings && !home.terminals, '48. the workspace opens on its agents — the rail with the seeded agent, no settings, no terminals', JSON.stringify(home));
    await cdp.evaluate(`document.querySelector('[data-workspace-tab="terminals"]').click(); true`);
    const terminalsView = await waitFor(cdp, `Boolean(document.querySelector('[data-terminal-add]')) && !document.querySelector('[data-workspace-home]')`, 'the Terminals view');
    check(terminalsView, '49. the Terminals tab shows the terminal strip (and puts the rail away)');

    await cdp.evaluate(`document.querySelector('[data-terminal-add]').click(); true`);
    const paneUp = await waitFor(
        cdp,
        `Boolean(document.querySelector('[data-terminal-pane] .xterm-rows'))`,
        'an xterm to mount for the new terminal',
    );
    check(paneUp, '36. "+ terminal" opens a real terminal pane with xterm mounted');

    // Let the shell print its prompt, then focus xterm's textarea and type.
    await new Promise((r) => setTimeout(r, 1200));
    await cdp.evaluate(`document.querySelector('[data-terminal-pane] textarea')?.focus(); true`);
    await cdp.send('Input.insertText', { text: `echo ${token}` });
    const rowsText = `(document.querySelector('[data-terminal-pane] .xterm-rows')?.innerText ?? '')`;
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
        return list.filter((t) => t.type === 'page' && String(t.url).includes('#genie://takeover/'));
    };
    const before = (await takeoverTargets()).length;
    check(before === 0, '39. CONTROL: no take-over window exists before the click', `${before} target(s)`);

    await cdp.evaluate(`document.querySelector('[data-nav="genie://dashboard"]').click(); true`);
    await waitFor(cdp, `Boolean(document.querySelector('[data-surface="dashboard"]'))`, 'the Dashboard');
    await cdp.evaluate(`document.querySelector('[data-agent]')?.click(); true`);
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

// 11. Nothing threw on the way up.
const errors = await cdp.evaluate('JSON.stringify(window.__smokeErrors ?? [])');
const parsed = JSON.parse(errors || '[]');
check(parsed.length === 0, '34. the console is clean', parsed.join(' | ') || 'no errors');

// A screenshot, for a human to look at. Writing one is not the same as somebody having seen
// it, and this script does not claim otherwise.
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
