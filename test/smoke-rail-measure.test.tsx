// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
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

/** The selector step 10 passes to querySelector, read from the smoke itself. */
function smokeRailSelector(): string {
    const smoke = readFileSync(new URL('../scripts/smoke-cdp.mjs', import.meta.url), 'utf8');
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
        const smoke = readFileSync(new URL('../scripts/smoke-cdp.mjs', import.meta.url), 'utf8');
        expect(smoke).toMatch(/check\(railWidth === 208, '10\. the rail is 208px/);
    });
});
