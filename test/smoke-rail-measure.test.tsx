// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * THE SMOKE MEASURES THE RAIL, not something inside it (genie#1430 follow-up, 2026-11-02).
 *
 * `scripts/smoke-cdp.mjs` step 10 proves the stylesheet applied by measuring the rail at 208px (`w-52`). It used to read
 * the first `<nav>` — the rail itself, until the rail became react-fancy's Sidebar (#1430): now the rail is a container
 * (`data-rail`, `w-52`, a 1px right border, 8px padding each side) and the first `<nav>` is Sidebar's own landmark INSIDE
 * it, 208 − 1 − 16 = 191px. The rail did not shrink; the smoke measured the wrong element. The 208 stays.
 *
 * This reads the selector the smoke actually uses and checks, on the real rail, that it lands on the w-52 container.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

/**
 * A script, read by PATH: under happy-dom `URL` is happy-dom's, and `readFileSync(new URL(…, import.meta.url))` threw
 * "The URL must be of scheme file" on CI (ERR_INVALID_URL_SCHEME). test/mobile-scroll.test.tsx reads the same way.
 */
const script = (name: string) => readFileSync(join(__dirname, '../scripts', name), 'utf8');

/** The selector step 10 passes to querySelector, read from the smoke itself. */
function smokeRailSelector(): string {
    const smoke = script('smoke-cdp.mjs');
    const line = smoke.split('\n').find((l) => l.includes('const railWidth'));
    expect(line, 'the smoke still measures the rail (const railWidth)').toBeDefined();
    const sel = /querySelector\((["'])(.+?)\1\)/.exec(line!.replace(/\\"/g, '"'))?.[2];
    expect(sel, 'step 10 queries one selector').toBeDefined();
    return sel!;
}

describe('step 10 of the smoke', () => {
    it('measures the rail container (w-52, 208px) — not a nav inside it', () => {
        act(() => root.render(
            <Sidebar route="genie://dashboard" deckCount={0} workspaces={[]} available={['deck', 'dashboard', 'settings']} onNavigate={() => {}} railStorage={{ getItem: () => '0', setItem: () => {} }} />,
        ));
        const measured = host.querySelector(smokeRailSelector());
        expect(measured, 'the smoke’s selector finds an element in the rail').not.toBeNull();
        expect(measured!.classList.contains('w-52'), `the smoke measures <${measured!.tagName.toLowerCase()} class="${measured!.className}">`).toBe(true);
        // CONTROL: the element the old selector took is narrower than the rail — Sidebar's nav, inside the padding.
        const firstNav = host.querySelector('nav');
        expect(firstNav).not.toBeNull();
        expect(firstNav!.classList.contains('w-52')).toBe(false);
    });

    it('still asserts exactly 208 (never loosened)', () => {
        expect(script('smoke-cdp.mjs')).toMatch(/check\(railWidth === 208, '10\. the rail is 208px/);
    });
});

/*
 * THE LAYOUT SWEEP MEASURES THE SAME RAIL (scripts/layout-sweep.mjs, run right after the smoke in "a real window"): it read
 * the first <nav> too, and failed "the rail keeps its 208px — 191px" at every width on #1442's first CI run, after the smoke
 * itself had passed.
 */
describe('the layout sweep', () => {
    it('measures the rail container (w-52), the element its railWidth reads', () => {
        const line = script('layout-sweep.mjs').split('\n').find((l) => /const rail = document\.querySelector\(/.test(l));
        expect(line, 'the sweep still measures the rail (const rail = document.querySelector(…))').toBeDefined();
        const sel = /querySelector\((["'])(.+?)\1\)/.exec(line!)?.[2];
        expect(sel, 'the sweep queries one selector').toBeDefined();
        act(() => root.render(
            <Sidebar route="genie://dashboard" deckCount={0} workspaces={[]} available={['deck', 'dashboard', 'settings']} onNavigate={() => {}} railStorage={{ getItem: () => '0', setItem: () => {} }} />,
        ));
        const measured = host.querySelector(sel!);
        expect(measured, 'the sweep’s selector finds an element in the rail').not.toBeNull();
        expect(measured!.classList.contains('w-52'), `the sweep measures <${measured!.tagName.toLowerCase()} class="${measured!.className}">`).toBe(true);
    });

    it('still asserts exactly 208 at every width (never loosened)', () => {
        expect(script('layout-sweep.mjs')).toMatch(/check\(result\.railWidth === 208, /);
    });
});
