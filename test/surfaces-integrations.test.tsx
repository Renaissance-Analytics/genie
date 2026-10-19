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
    tynn: { host: 'https://tynn.ai', user: null, signInUrl: null, message: null },
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
        expect(html).toContain('data-action="tynn-sign-in"');
        expect(html).toContain('data-gated="tynn-sync"');
        expect(html).toMatch(/Sign in to Tynn to use this/);
        expect(html).not.toMatch(/>Sign out</);
    });

    it('signed in: Sign out, and the gated row enabled with no annotation', () => {
        const html = render({ ...integrations, tynnSignedIn: true, tynn: { ...integrations.tynn, user: { name: 'Ada', email: 'ada@example.com' } }, gated: [{ ...integrations.gated[0]!, enabled: true, note: null, route: null }] });
        expect(html).toMatch(/>Sign out</);
        expect(html).not.toMatch(/Sign in to Tynn to use this/);
        expect(html).toContain('data-gated-enabled="true"');
    });

    it('Tynn signs in the way Genie 1 did: a browser button, the host shown, a code to paste — and NO token field', () => {
        const html = render(integrations);
        // Fancy's Button wraps its label in a span: the label is inside THAT button, nested tags between.
        expect(html).toMatch(/data-action="tynn-sign-in"[^>]*>(?:<[^>]+>)*Open Tynn in your browser</);
        expect(html).toContain('data-tynn-host="https://tynn.ai"');
        expect(html).toContain('data-form="tynn-code"');
        expect(html).toMatch(/placeholder="Paste sign-in code from Tynn"/);
        expect(html).not.toMatch(/type="password"/);
        expect(html).not.toMatch(/Tynn API token|Tynn token/);
        // Nothing pending: no link to copy, no message.
        expect(html).not.toContain('data-tynn-sign-in-url');
        expect(html).not.toContain('data-tynn-message');
    });

    it('after Sign in: the link stays on screen for a machine without a browser; Tynn’s refusal is shown in its words', () => {
        const url = 'https://tynn.ai/genie/callback?return=genie%3A%2F%2Foauth%2Fcallback';
        const html = render({ ...integrations, tynn: { ...integrations.tynn, signInUrl: url, message: 'Tynn answered 422: That sign-in code is not valid.' } });
        expect(html).toContain(`data-tynn-sign-in-url="${url.replace(/&/g, '&amp;')}"`);
        expect(html).toMatch(/No browser on this machine\?/);
        expect(html).toMatch(/data-tynn-message[^>]*>Tynn answered 422: That sign-in code is not valid\.</);
    });

    it('signed in: who, where, and Sign out — no sign-in button and no code form', () => {
        const html = render({ ...integrations, tynnSignedIn: true, tynn: { ...integrations.tynn, user: { name: 'Ada', email: 'ada@example.com' } } });
        expect(html).toMatch(/Signed in as <strong>Ada<\/strong>/);
        expect(html).toContain('ada@example.com');
        expect(html).toContain('data-action="tynn-sign-out"');
        expect(html).not.toContain('data-action="tynn-sign-in"');
        expect(html).not.toContain('data-form="tynn-code"');
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
