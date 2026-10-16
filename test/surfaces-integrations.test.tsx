import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * INTEGRATIONS IN SETTINGS → WORKSTATION (§6.9). Tynn is optional: signed out shows the sign-in with
 * every gated row still listed and annotated; signed in shows Sign out. The GitHub App is TWO steps,
 * each with its own confirm, the app's own URL in plain text to open; done steps are marked. A workspace's
 * config sync lives in that workspace's Settings (test/workspace-agent-files.test.tsx); this section points there.
 */

const integrations: NonNullable<FeatureData['integrations']> = {
    tynnSignedIn: false,
    github: { steps: [{ id: 'authorize', done: false }, { id: 'install', done: false }], blocking: true, blockedBy: 'authorize', missingRepos: ['this workstation'], signal: { label: 'GitHub permissions are blocking features', route: 'genie://settings/github' } },
    gated: [{ id: 'tynn-sync', label: 'Sync work items with Tynn', tynn: true, enabled: false, note: 'Sign in to Tynn to use this', route: 'genie://settings/tynn' }],
    lastSync: null,
    mcp: { url: null, verified: null },
};
const render = (i: FeatureData['integrations']) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote: null, integrations: i }} onAction={() => {}} onNavigate={() => {}} group="workstation" workspaces={[{ id: 'tynn', path: '/w/tynn' }]} />);

describe('Integrations', () => {
    it('null draws a skeleton; signed out of Tynn shows the sign-in and the gated row ANNOTATED, not dropped', () => {
        expect(render(null)).toContain('data-integrations');
        const html = render(integrations);
        expect(html).toContain('data-form="tynn-sign-in"');
        expect(html).toContain('data-gated="tynn-sync"');
        expect(html).toMatch(/Sign in to Tynn to use this/);
        expect(html).not.toMatch(/>Sign out</);
    });

    it('signed in: Sign out, and the gated row enabled with no annotation', () => {
        const html = render({ ...integrations, tynnSignedIn: true, gated: [{ ...integrations.gated[0]!, enabled: true, note: null, route: null }] });
        expect(html).toMatch(/>Sign out</);
        expect(html).not.toMatch(/Sign in to Tynn to use this/);
        expect(html).toContain('data-gated-enabled="true"');
    });

    it('GitHub: two steps, the app URL in plain text, a confirm per step; a done step is marked and the next is the one offered', () => {
        const html = render(integrations);
        expect(html).toContain('data-github-step="authorize"');
        expect(html).toContain('data-github-step="install"');
        expect(html).toMatch(/github\.com\/apps\/genie-aos/);
        expect(html).toContain('data-action="github-confirm-authorize"');
        expect(html).not.toContain('data-action="github-confirm-install"');
        const authorized = render({ ...integrations, github: { ...integrations.github, blockedBy: 'install', steps: [{ id: 'authorize', done: true }, { id: 'install', done: false }] } });
        expect(authorized).toContain('data-github-done="authorize"');
        expect(authorized).toContain('data-action="github-confirm-install"');
    });

    it('config sync is not here: no Sync now and no results even after a sync — the note says each workspace’s Settings has it', () => {
        const html = render({ ...integrations, lastSync: { workspaceId: 'tynn', results: [{ id: 'claude', label: 'Claude Code (.mcp.json)', ok: true }, { id: 'cursor', label: 'Cursor (.cursor/mcp.json)', ok: false, error: 'EACCES' }, { id: 'codex', label: 'Codex (.codex/config.toml)', ok: true }, { id: 'hooks', label: 'Claude Code Stop hook (.claude/settings.local.json)', ok: true }] } });
        expect(html).not.toContain('data-action="sync-config"');
        expect(html).not.toContain('data-sync-result=');
        expect(html).toContain('data-workspace-files-note');
    });
});
