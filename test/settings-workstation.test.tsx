import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, NOT_DRAWN, type SectionId } from '../src/core/settings-nav.js';
import { SETTINGS } from '../src/core/settings.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { signedOutGithubView } from '../src/core/github.js';

/**
 * WORKSTATION SETTINGS, DRAWN — GENIE 1'S SIDEBAR (the owner, 2026-10-19; approved FTQ q_3e5257af): a sidebar of grouped
 * sections and ONE page at a time, Fancy controls, nothing internal on screen, the GitHub card instead of two raw
 * checkboxes, and the Tynn host behind the Tynn card's Change.
 */

const values = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));
const integrations: NonNullable<FeatureData['integrations']> = {
    tynnSignedIn: false,
    tynn: { host: 'https://tynn.ai', user: null, signInUrl: null, message: null },
    github: signedOutGithubView(null),
    gated: [],
    lastSync: null,
    mcp: { url: null, verified: null },
};
const page = (section: SectionId | null) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values }, integrations }} onAction={() => {}} onNavigate={() => {}} section={section} workspaces={[]} />);

describe('the sidebar and its pages', () => {
    it('draws every group and section as a link to its page; the page shown is the route’s, General when none', () => {
        const html = page(null);
        for (const g of NAV_GROUPS) {
            expect(html).toContain(`data-settings-nav-group="${g.label}"`);
            for (const i of g.items) expect(html).toMatch(new RegExp(`data-settings-nav="${i.id}"[^>]*data-nav-target="genie://settings/${i.id}"`));
        }
        expect(html).toContain('data-settings-page="general"');
        expect(html).toMatch(/data-settings-nav="general"[^>]*aria-current="page"/);
        expect(page('remote')).toContain('data-settings-page="remote"');
    });

    it('ONE page at a time: General shows its settings and not Terminals’ (COUNTED: 1 page)', () => {
        const html = page('general');
        expect(html.match(/data-settings-page=/g) ?? []).toHaveLength(1);
        expect(html).toContain('data-setting="launch_at_login"');
        expect(html).not.toContain('data-setting="track_cwd"');
        expect(page('terminals')).toContain('data-setting="track_cwd"');
    });
});

describe('nothing internal is drawn, on any page', () => {
    it('no NOT_DRAWN key appears as a setting row anywhere (COUNTED: 0)', () => {
        const all = NAV_GROUPS.flatMap((g) => g.items.map((i) => page(i.id))).join('');
        for (const k of NOT_DRAWN) expect(all, k).not.toContain(`data-setting="${k}"`);
        // The positive control: rows ARE drawn across the pages.
        expect(all).toContain('data-setting="theme"');
    });
});

describe('Accounts', () => {
    it('GitHub is the sign-in card (Genie 1’s device flow) — no checklist, no raw “authorized / installed” checkboxes', () => {
        // beta.33 item 25; the owner (2026-10-20): "functional not some dumb list".
        const html = page('github');
        expect(html).toContain('data-action="github-sign-in"');
        expect(html).not.toContain('data-github-step');
        expect(html).not.toMatch(/GitHub App authorized|GitHub App installed/);
    });

    // Changed 2026-10-21 (the owner, of the "Change Tynn host" button: "tynn is not a changeable host wtf is this?"): Genie
    // always talks to tynn.ai; testing reaches a local Tynn through the test VM's hosts file, never a product setting.
    it('Tynn is the sign-in card at tynn.ai — nothing to change the host with', () => {
        const html = page('tynn');
        expect(html).toContain('data-action="tynn-sign-in"');
        expect(html).toContain('data-tynn-host="https://tynn.ai"');
        expect(html).not.toContain('tynn-host-change');
        expect(html).not.toContain('data-form="tynn-host"');
        expect(html).not.toMatch(/Change Tynn host/);
        expect(html).not.toContain('data-setting="tynn_host"');
    });
});

describe('Fancy controls', () => {
    it('a boolean is Fancy’s Switch and an enum Fancy’s Select — no bare checkbox or select', () => {
        const html = page('general');
        expect(html).toMatch(/data-setting="launch_at_login"[\s\S]*?data-react-fancy-switch/);
        expect(html).toMatch(/data-setting="update_channel"[\s\S]*?data-react-fancy-select/);
        expect(html).not.toMatch(/<input type="checkbox"/);
    });
});
