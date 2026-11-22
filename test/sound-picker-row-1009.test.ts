import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * THE SOUND-PICKER ROW CLICKS A SETTLED PAGE AND READS SETTLED COLOURS (Tynn #1009). With What's new seeded as seen the
 * row no longer waits on a dialog, and the gate showed two races that dialog used to hide:
 *
 * - gate rerun 1122-013356-260f53: the Notifications click landed (the mouse reached it) and the page stayed on General.
 *   The row opens Settings as `#genie://settings`; once the window has its snapshot, App.tsx rewrites that to this
 *   workstation's own address from the address it last RENDERED (rewrittenAddress), so a click made before then is
 *   overwritten. A person's click comes after the page has settled, and so must the row's.
 * - gate 1122-000850-5f70c8 (and #996's proof 1121-033216 before this change): 13c/14c read the name and play buttons
 *   mid-way through their 200 ms transition-all after the theme switch (light read the dark colour). Transitions are
 *   finished before the colours are read, so what is measured is what a person sees once it has settled.
 */
const src = readFileSync(join(__dirname, '..', 'scripts', 'sound-picker-cdp.mjs'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('sound-picker row (Tynn #1009)', () => {
    it('waits for the app to settle on its own Settings address before the first click', () => {
        const settle = src.indexOf('1b. the address settled on this workstation');
        const firstClick = src.indexOf(`click(cdp, '[data-settings-nav="notifications"]')`);
        expect(settle).toBeGreaterThan(-1);
        expect(firstClick).toBeGreaterThan(settle);
        expect(src.slice(src.indexOf("window.location.hash = '#genie://settings'"), firstClick)).toMatch(/waitFor\(cdp, SETTLED_SETTINGS/);
    });

    it('the settled test accepts the rewritten address and refuses the one the row wrote', () => {
        const m = /const SETTLED_SETTINGS = `([^`]+)`;/.exec(src);
        expect(m).not.toBeNull();
        const settled = (hash: string) => new Function('window', `return ${m![1]};`)({ location: { hash } }) as boolean;
        expect(settled('#genie://settings')).toBe(false);
        expect(settled('#genie://gt-11220134-2c826405/settings')).toBe(true);
        expect(settled('#genie://gt-11220134-2c826405/settings/notifications')).toBe(true);
        expect(settled('#genie://gt-11220134-2c826405/dashboard')).toBe(false);
    });

    it('finishes the theme switch\'s transitions before it reads the colours', () => {
        const toggle = src.indexOf("classList.toggle('dark', ${theme === 'dark'})");
        const measure = src.indexOf('await cdp.evaluate(MEASURE)', toggle);
        expect(toggle).toBeGreaterThan(-1);
        expect(src.slice(toggle, measure)).toMatch(/getAnimations\(\)[^\n]*finish\(\)/);
    });
});
