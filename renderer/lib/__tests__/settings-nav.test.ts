import { describe, expect, it } from 'vitest';
import {
    NAV_GROUPS,
    defaultSection,
    filterNavGroups,
    isSectionVisible,
    type SectionId,
} from '../settings-nav';

/**
 * The remote-window Settings restriction: in a remote/host window Settings shows
 * ONLY the connection-relevant subset (all under Customization); a local window is
 * unchanged. React rendering is manual/e2e-verify (Node test env has no DOM) — this
 * covers the pure gating the page renders from.
 */

const allIds = (): SectionId[] => NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

describe('local (unrestricted) Settings', () => {
    it('shows the full nav unchanged', () => {
        expect(filterNavGroups(NAV_GROUPS, false)).toBe(NAV_GROUPS);
    });
    it('shows every section', () => {
        for (const id of allIds()) expect(isSectionVisible(id, false)).toBe(true);
    });
    it('defaults to General', () => {
        expect(defaultSection(false)).toBe('general');
    });
});

describe('remote (restricted) Settings', () => {
    it('nav shows ONLY Customization (empty groups dropped)', () => {
        const groups = filterNavGroups(NAV_GROUPS, true);
        const items = groups.flatMap((g) => g.items.map((i) => i.id));
        expect(items).toEqual(['customization']);
        // The "Agents & network" and "System" groups have no visible item → dropped.
        expect(groups.map((g) => g.label)).toEqual(['Workspace']);
    });

    it('only Customization renders; every other section is hidden', () => {
        expect(isSectionVisible('customization', true)).toBe(true);
        for (const id of allIds().filter((i) => i !== 'customization')) {
            expect(isSectionVisible(id, true)).toBe(false);
        }
        // Spot-check the explicit HIDE list.
        for (const id of [
            'general',
            'tools',
            'workspaces',
            'agent-mcp',
            'mobile',
            'connections',
            'devices',
            'updates',
        ] as SectionId[]) {
            expect(isSectionVisible(id, true)).toBe(false);
        }
    });

    it('defaults to Customization (General is hidden)', () => {
        expect(defaultSection(true)).toBe('customization');
    });
});
