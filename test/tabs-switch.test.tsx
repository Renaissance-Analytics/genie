import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * TABS THAT SWITCH (the owner, 2026-10-12: "many of the pages with tabs, the tabs are not working"). Fancy's `Tabs` is
 * controllable: given `activeTab`, it changes ONLY through `onTabChange` (its useControllableState never updates a
 * controlled value itself). Settings passed `activeTab` from the route and no `onTabChange`, so a click did nothing.
 *
 * No DOM here (house rule): the props Fancy's Tabs receives are captured and its `onTabChange` called, which is
 * exactly what a click on a tab does inside Fancy.
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const Tabs = Object.assign((props: Record<string, unknown>) => { seen.push(props); return (real.Tabs as unknown as (p: unknown) => unknown)(props); }, real.Tabs);
    return { ...real, Tabs };
});
// Settings no longer has tabs (Genie 1's sidebar, 2026-10-19): its section links are proven in the real window (smoke 56/57).

describe('every tab bar in the renderer', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : []; });
    const tabsTags = (src: string) => [...src.matchAll(/<Tabs\b[^>]*>/g)].map((m) => m[0]);

    it('a controlled Tabs always has an onTabChange — counted, so a bar with none is named (positive control: the scan finds the bars)', () => {
        const all = files('src/renderer').flatMap((f) => tabsTags(readFileSync(f, 'utf8')).map((tag) => ({ f, tag })));
        expect(all.length).toBeGreaterThanOrEqual(2);
        const missing = (tags: readonly { f: string; tag: string }[]) => tags.filter((t) => /\bactiveTab=/.test(t.tag) && !/\bonTabChange=/.test(t.tag)).map((t) => `${t.f}: ${t.tag}`);
        expect(missing(all)).toEqual([]);
        // POSITIVE CONTROL: the scan DOES name a controlled bar without onTabChange, and passes one that has it. (Settings,
        // the one controlled bar, became Genie 1's sidebar on 2026-10-19 — so the control is a planted bar, not a live one.)
        const planted = tabsTags('<Tabs activeTab={x} variant="underline"><Tabs activeTab={y} onTabChange={go}>').map((tag) => ({ f: 'planted.tsx', tag }));
        expect(missing(planted)).toEqual(['planted.tsx: <Tabs activeTab={x} variant="underline">']);
    });
});
