/**
 * WHAT'S NEW, OUT OF A ROW'S WAY (Tynn #1009). Genie shows "What's new in Genie <version>" over the whole window once per
 * version, until it is closed (src/core/whats-new.ts whatsNewFor; src/main/genie-host.ts reads `whats_new_seen_version`).
 * A row that starts the app on a fresh home has nothing in that setting, so the dialog opens over whatever the row is
 * about to click, and it opens LATE: only once the window has its feature data. Gate 1121-054848-5be253 (PR #2125) lost
 * windows/sound-picker to it: the mouse at the Settings nav reached the dialog's backdrop.
 *
 * Two parts, both used by every scripts/*-cdp.mjs that clicks:
 *
 *   seedWhatsNewSeen(genieHome)   before the app starts: records the running version as seen in the home's
 *                                 settings.json (other settings kept), so no row races the dialog at all.
 *   closeWhatsNew(evaluate)       before a click: if one is open anyway, closes it by its own Close button (as a
 *                                 person does), waits until it has gone, and says so in the row's log.
 *
 * test/cdp-whats-new.test.ts holds both.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The setting the host reads (src/core/settings.ts). */
export const WHATS_NEW_SEEN = 'whats_new_seen_version';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The version the app under test runs as: package.json's, which is what the host compares the setting with. */
export function appVersion(root = ROOT) {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

/**
 * Record `version` as the What's new already seen, in `<genieHome>/runtime/settings.json`. Settings already there are
 * kept; a file that is not JSON is an error (a seed that silently dropped another row's settings would hide it).
 * Returns the path written.
 */
export function seedWhatsNewSeen(genieHome, version = appVersion()) {
    if (typeof version !== 'string' || version === '') throw new Error('seedWhatsNewSeen: no version to record');
    const runtime = join(genieHome, 'runtime');
    mkdirSync(runtime, { recursive: true });
    const file = join(runtime, 'settings.json');
    let settings = {};
    let raw = null;
    try { raw = readFileSync(file, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (raw !== null && raw.trim() !== '') settings = JSON.parse(raw);
    writeFileSync(file, JSON.stringify({ ...settings, [WHATS_NEW_SEEN]: version }, null, 2));
    return file;
}

/** In the page: the open What's new's version, after pressing its Close button; null when none is open. */
export const CLOSE_WHATS_NEW = `(() => {
    const body = document.querySelector('[data-whats-new]');
    if (!body) return null;
    const button = body.querySelector('[data-action="whats-new-close"]') ?? document.querySelector('[data-action="whats-new-close"]');
    if (button) button.click();
    return { version: body.getAttribute('data-whats-new') ?? '', clicked: Boolean(button) };
})()`;
export const WHATS_NEW_GONE = `!document.querySelector('[data-whats-new]')`;

/**
 * If What's new is open over the page, close it by its Close button and wait until it has gone. `evaluate` runs an
 * expression in the page and returns its value (each row's own CDP client). Returns `{ closed: false }` when nothing was
 * open, `{ closed: true, version }` when it closed one; throws when it would not close (a row must not click on through
 * a dialog it could not move).
 */
export async function closeWhatsNew(evaluate, { log = console.log, timeoutMs = 15_000, pollMs = 100 } = {}) {
    const open = await evaluate(CLOSE_WHATS_NEW);
    if (!open) return { closed: false };
    if (!open.clicked) throw new Error(`What's new ${open.version} is open and has no Close button`);
    for (const until = Date.now() + timeoutMs; Date.now() < until;) {
        if (await evaluate(WHATS_NEW_GONE)) {
            log(`  What's new ${open.version} was open over the page; closed it by its Close button`);
            return { closed: true, version: open.version };
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`What's new ${open.version} did not close within ${timeoutMs} ms of its Close button`);
}

/**
 * BREAK PROBES ONLY: `GENIE_PROBE_WHATS_NEW=open` asks the app for What's new as Help → What's new does (shown although
 * seen), and waits until it is drawn, so a probe can put the dialog over the page at a known moment instead of hoping the
 * late one races. Returns whether it was drawn: a probe's RED counts only when this says the dialog was really there.
 * Without the variable it does nothing and returns null.
 */
export async function forceWhatsNewOpenForProbe(evaluate, { log = console.log, timeoutMs = 15_000 } = {}) {
    if (process.env.GENIE_PROBE_WHATS_NEW !== 'open') return null;
    await evaluate(`(window.genieTest ?? window.genie).features.act({ kind: 'whatsNew.show' }).then(() => true)`);
    let drawn = false;
    for (const until = Date.now() + timeoutMs; Date.now() < until && !drawn;) {
        drawn = Boolean(await evaluate(`Boolean(document.querySelector('[data-whats-new]'))`));
        if (!drawn) await new Promise((r) => setTimeout(r, 100));
    }
    log(`  PROBE: What's new forced open over the page: ${drawn ? 'drawn' : 'NOT drawn'}`);
    return drawn;
}
