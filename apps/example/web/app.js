/**
 * The Genie App Example's front end.
 *
 * Written to be read. It uses `window.genieApp` directly rather than
 * `@genie/app-sdk` for exactly one reason: this file is the proof of what the
 * runtime surface IS. The SDK is a thin, typed wrapper over these two calls, and
 * a real app should use it — see the README beside this folder.
 *
 * The pattern worth copying is the third section: ASK what you were granted, and
 * render accordingly. Everything on screen comes from `me().capabilities`, not
 * from what the manifest requested — the user may have given less, and may take it
 * away later.
 */

const $ = (id) => document.getElementById(id);

/** The whole surface. No Node, no filesystem, no `window.genie`. */
const genie = globalThis.genieApp;

/** Every capability this example knows how to demonstrate. */
const DEMONSTRATED = [
    { key: 'hosting', label: 'Host sites and services', section: 'hosting-section' },
    { key: 'knowledge', label: 'Genie’s memory', section: null },
    { key: 'terminals', label: 'Run commands', section: 'terminals-section' },
];

function show(el, text) {
    el.hidden = false;
    el.textContent = text;
}

/**
 * Render a refusal as the sentence Genie wrote.
 *
 * Genie writes refusals for a person — "was not granted Run commands, which is
 * required to use manageTerminals" — so showing it verbatim is both the most
 * useful thing and the least work.
 */
async function callGenie(tool, args) {
    const outcome = await genie.call(tool, args);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
}

async function main() {
    if (!genie) {
        // Opening this page outside Genie is a normal thing to do while building
        // it. Say so plainly instead of throwing on an undefined.
        $('status').textContent =
            'Not running in a Genie App window — install this folder in Genie to see it work.';
        $('capabilities').innerHTML = '<li>—</li>';
        return;
    }

    const me = await genie.me();
    if (!me) {
        $('status').textContent = 'Genie does not recognise this window.';
        return;
    }

    $('identity').innerHTML = `
        <dt>Name</dt><dd>${me.name}</dd>
        <dt>App id</dt><dd>${me.id}</dd>
        <dt>Workspace</dt><dd>${me.workspaceId}</dd>
        <dt>Reach</dt><dd>${me.scope}</dd>
    `;

    const granted = new Set(me.capabilities);
    $('capabilities').innerHTML = DEMONSTRATED.map(
        (c) =>
            `<li class="${granted.has(c.key) ? 'granted' : 'withheld'}">` +
            `${granted.has(c.key) ? '✓' : '✗'} ${c.label}</li>`,
    ).join('');

    // Reveal only what was granted. The terminals section is the deliberate
    // exception — it stays visible so the example can show a refusal.
    for (const c of DEMONSTRATED) {
        if (!c.section) continue;
        const el = $(c.section);
        if (el) el.hidden = c.key === 'terminals' ? false : !granted.has(c.key);
    }

    $('list-sites').addEventListener('click', async () => {
        try {
            const result = await callGenie('manageSite', { action: 'list' });
            show($('sites-out'), JSON.stringify(result, null, 2));
        } catch (e) {
            show($('sites-out'), e.message);
        }
    });

    $('run-command').addEventListener('click', async () => {
        try {
            const result = await callGenie('manageTerminals', { action: 'list' });
            show($('terminal-out'), JSON.stringify(result, null, 2));
        } catch (e) {
            // The expected path. This is what a well-behaved refusal looks like.
            show($('terminal-out'), e.message);
        }
    });

    $('ping-service').addEventListener('click', async () => {
        try {
            const res = await fetch('http://127.0.0.1:8791/health');
            show($('service-out'), await res.text());
        } catch (e) {
            show(
                $('service-out'),
                `The app’s own service is not answering: ${e.message}\n\n` +
                    'If Node was missing at install time, Genie will have told you so ' +
                    'in the installer rather than refusing to install the app.',
            );
        }
    });
}

void main();
