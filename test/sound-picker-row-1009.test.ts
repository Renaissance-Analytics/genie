import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * THE SOUND-PICKER ROW PINS THE LOST NAVIGATION, AND READS SETTLED COLOURS (Tynn #1009, #1023). With What's new seeded as
 * seen the row no longer waits on a dialog, and the gates found an app bug the dialog used to hide: a late address
 * rewrite undid a navigation made before the snapshot landed (gate 1122-020342-554d85: `#genie://settings` went back to
 * the Dashboard; rerun 1122-013356-260f53: Notifications went back to General). The app is fixed (useAddressQualifier,
 * test/address-qualifier-1023.test.tsx); the row navigates and clicks as early as a person can, with NO wait for the
 * snapshot, and checks (3b) that the window ends at this workstation's own Settings → Notifications.
 * Separately, gate 1122-000850-5f70c8 (and #996's proof 1121-033216 before this change) read 13c/14c mid-way through the
 * buttons' transition after the theme switch: transitions are finished before colours are read.
 */
const src = readFileSync(join(__dirname, '..', 'scripts', 'sound-picker-cdp.mjs'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The row's in-page test, run against a window of our making. */
function onThisWorkstation(path: string | null, hash: string, workstation: string | null, throws = false): Promise<boolean> {
    const m = /const ON_THIS_WORKSTATION = `([^`]+)`;/.exec(src);
    if (!m) throw new Error('ON_THIS_WORKSTATION not found in the row');
    const window = {
        location: { hash },
        genieTest: { snapshot: async () => { if (throws) throw new Error('no bridge yet'); return { workstation: workstation === null ? null : { name: workstation, healthy: true } }; } },
    };
    return (new Function('window', `return (${m[1]});`)(window) as (p: string | null) => Promise<boolean>)(path);
}

describe('sound-picker row (Tynn #1009, #1023)', () => {
    it('navigates and clicks without waiting for the snapshot, then checks neither was undone (3b)', () => {
        const navigate = src.indexOf("window.location.hash = '#genie://settings'");
        const firstClick = src.indexOf(`click(cdp, '[data-settings-nav="notifications"]')`);
        const pinned = src.indexOf("waitFor(cdp, onThisWorkstation('settings/notifications')");
        expect(navigate).toBeGreaterThan(-1);
        expect(firstClick).toBeGreaterThan(navigate);
        expect(src.slice(0, firstClick)).not.toContain('waitFor(cdp, onThisWorkstation(');
        expect(pinned).toBeGreaterThan(firstClick);
        expect(src.slice(pinned, pinned + 300)).toContain('3b. the address is this workstation');
    });

    it('the in-page test holds only for this workstation\'s own address at that page, once the window has its snapshot', async () => {
        const ws = 'gt-11220205-b6b2af28';
        expect(await onThisWorkstation(null, `#genie://${ws}/dashboard`, ws)).toBe(true);
        expect(await onThisWorkstation('settings/notifications', `#genie://${ws}/settings/notifications`, ws)).toBe(true);
        expect(await onThisWorkstation('settings/notifications', `#genie://${ws}/settings/notifications?x=1`, ws)).toBe(true);
        // What the gates saw: the bare route the row wrote, and the pages the late rewrite put back.
        expect(await onThisWorkstation('settings/notifications', '#genie://settings/notifications', ws)).toBe(false);
        expect(await onThisWorkstation('settings/notifications', `#genie://${ws}/dashboard`, ws)).toBe(false);
        expect(await onThisWorkstation('settings/notifications', `#genie://${ws}/settings`, ws)).toBe(false);
        expect(await onThisWorkstation('settings/notifications', `#genie://${ws}/settings/notificationsx`, ws)).toBe(false);
        // No snapshot yet, or no bridge yet: not there yet (and no throw: the row keeps waiting).
        expect(await onThisWorkstation(null, `#genie://${ws}/dashboard`, null)).toBe(false);
        expect(await onThisWorkstation(null, `#genie://${ws}/dashboard`, ws, true)).toBe(false);
        expect(await onThisWorkstation(null, '#genie://other-host/dashboard', ws)).toBe(false);
    });

    it('finishes the theme switch\'s transitions before it reads the colours', () => {
        const toggle = src.indexOf("classList.toggle('dark', ${theme === 'dark'})");
        const measure = src.indexOf('await cdp.evaluate(MEASURE)', toggle);
        expect(toggle).toBeGreaterThan(-1);
        expect(src.slice(toggle, measure)).toMatch(/getAnimations\(\)[^\n]*finish\(\)/);
    });
});
