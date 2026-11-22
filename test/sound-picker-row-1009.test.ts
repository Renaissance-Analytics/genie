import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * THE SOUND-PICKER ROW ACTS ON A SETTLED PAGE AND READS SETTLED COLOURS (Tynn #1009). With What's new seeded as seen the
 * row no longer waits on a dialog, and the gates showed the races that dialog used to hide. Once the window has its
 * snapshot, App.tsx rewrites the address to this workstation's own form FROM THE ADDRESS IT LAST RENDERED
 * (rewrittenAddress), so anything the row does before then is overwritten:
 *
 * - gate 1122-020342-554d85: the row's own `#genie://settings` went back to the Dashboard (check 1 never saw Settings);
 * - rerun 1122-013356-260f53: the Notifications click landed and the page stayed on General.
 *
 * The row now waits for the rewrite before it navigates (0b) and before its first click (1b). The app-side lost click is
 * its own story. Separately, gate 1122-000850-5f70c8 (and #996's proof 1121-033216 before this change) read 13c/14c
 * mid-way through the buttons' transition after the theme switch: transitions are finished before colours are read.
 */
const src = readFileSync(join(__dirname, '..', 'scripts', 'sound-picker-cdp.mjs'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The row's in-page test, run against a window of our making. */
function onThisWorkstation(page: string | null, hash: string, workstation: string | null, throws = false): Promise<boolean> {
    const m = /const ON_THIS_WORKSTATION = `([^`]+)`;/.exec(src);
    if (!m) throw new Error('ON_THIS_WORKSTATION not found in the row');
    const window = {
        location: { hash },
        genieTest: { snapshot: async () => { if (throws) throw new Error('no bridge yet'); return { workstation: workstation === null ? null : { name: workstation, healthy: true } }; } },
    };
    return (new Function('window', `return (${m[1]});`)(window) as (p: string | null) => Promise<boolean>)(page);
}

describe('sound-picker row (Tynn #1009)', () => {
    it('waits for the app to settle on its own address before it navigates, and on Settings before its first click', () => {
        const settled = src.indexOf('0b. the app has settled on this workstation');
        const navigate = src.indexOf("window.location.hash = '#genie://settings'");
        const settings = src.indexOf("waitFor(cdp, onThisWorkstation('settings')");
        const firstClick = src.indexOf(`click(cdp, '[data-settings-nav="notifications"]')`);
        expect(settled).toBeGreaterThan(-1);
        expect(navigate).toBeGreaterThan(settled);
        expect(src.slice(settled - 200, navigate)).toMatch(/waitFor\(cdp, onThisWorkstation\(null\)/);
        expect(settings).toBeGreaterThan(navigate);
        expect(firstClick).toBeGreaterThan(settings);
    });

    it('the in-page test holds only for this workstation\'s own address, and only once the window has its snapshot', async () => {
        const ws = 'gt-11220205-b6b2af28';
        expect(await onThisWorkstation(null, `#genie://${ws}/dashboard`, ws)).toBe(true);
        expect(await onThisWorkstation('settings', `#genie://${ws}/settings`, ws)).toBe(true);
        expect(await onThisWorkstation('settings', `#genie://${ws}/settings/notifications?x=1`, ws)).toBe(true);
        // What the gates saw: the bare route the row wrote, and the Dashboard it was rewritten back to.
        expect(await onThisWorkstation(null, '#genie://dashboard', ws)).toBe(false);
        expect(await onThisWorkstation('settings', '#genie://settings', ws)).toBe(false);
        expect(await onThisWorkstation('settings', `#genie://${ws}/dashboard`, ws)).toBe(false);
        // No snapshot yet, or no bridge yet: not settled (and no throw: the row keeps waiting).
        expect(await onThisWorkstation(null, `#genie://${ws}/dashboard`, null)).toBe(false);
        expect(await onThisWorkstation(null, `#genie://${ws}/dashboard`, ws, true)).toBe(false);
        // Another workstation's address is not this one's.
        expect(await onThisWorkstation(null, '#genie://other-host/dashboard', ws)).toBe(false);
    });

    it('finishes the theme switch\'s transitions before it reads the colours', () => {
        const toggle = src.indexOf("classList.toggle('dark', ${theme === 'dark'})");
        const measure = src.indexOf('await cdp.evaluate(MEASURE)', toggle);
        expect(toggle).toBeGreaterThan(-1);
        expect(src.slice(toggle, measure)).toMatch(/getAnimations\(\)[^\n]*finish\(\)/);
    });
});
