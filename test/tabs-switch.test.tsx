import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * TABS THAT SWITCH (the owner, 2026-10-12: "many of the pages with tabs, the tabs are not working"). Fancy's `Tabs` is
 * controllable: given `activeTab`, it changes ONLY through `onTabChange` (its useControllableState never updates a
 * controlled value itself). Settings passed `activeTab` from the route and no `onTabChange`, so a click did nothing.
 * Settings' tab is its route's `group`, so a click navigates to that group — refresh and back keep it.
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
const { SettingsSurface } = await import('../src/renderer/components/FeatureSurfaces.js');
const { EMPTY_FEATURES } = await import('../src/renderer/features.js');

describe('Settings', () => {
    it('a click on a tab navigates to that group (positive control: the tab the route names is the one shown)', () => {
        seen.length = 0;
        const went: string[] = [];
        const data = { ...EMPTY_FEATURES, settings: { values: {} } } as typeof EMPTY_FEATURES;
        renderToStaticMarkup(<SettingsSurface data={data} onAction={() => {}} onNavigate={(r) => went.push(r)} group="agents" />);
        const tabs = seen.find((p) => 'activeTab' in p)!;
        expect(tabs.activeTab).toBe('agents');
        expect(typeof tabs.onTabChange).toBe('function');
        (tabs.onTabChange as (v: string) => void)('workstation');
        expect(went).toEqual(['genie://settings?group=workstation']);
    });
});

describe('every tab bar in the renderer', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : []; });
    const tabsTags = (src: string) => [...src.matchAll(/<Tabs\b[^>]*>/g)].map((m) => m[0]);

    it('a controlled Tabs always has an onTabChange — counted, so a bar with none is named (positive control: the scan finds the bars)', () => {
        const all = files('src/renderer').flatMap((f) => tabsTags(readFileSync(f, 'utf8')).map((tag) => ({ f, tag })));
        expect(all.length).toBeGreaterThanOrEqual(2);
        const controlled = all.filter((t) => /\bactiveTab=/.test(t.tag));
        expect(controlled.length).toBeGreaterThanOrEqual(1);
        expect(controlled.filter((t) => !/\bonTabChange=/.test(t.tag)).map((t) => `${t.f}: ${t.tag}`)).toEqual([]);
    });
});
