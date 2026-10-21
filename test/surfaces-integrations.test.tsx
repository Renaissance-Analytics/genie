import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SectionId } from '../src/core/settings-nav.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { githubCapabilities, signedOutGithubView, type GithubInstallation, type GithubView } from '../src/core/github.js';

/**
 * INTEGRATIONS IN SETTINGS → WORKSTATION (§6.9). Tynn is optional: signed out shows the sign-in with
 * every gated row still listed and annotated; signed in shows Sign out. GitHub is Genie 1's sign-in and the REAL status
 * GitHub reports (beta.33 item 25) — no longer two steps the person ticks. A workspace's
 * config sync lives in that workspace's Settings (test/workspace-agent-files.test.tsx); this section points there.
 */

const integrations: NonNullable<FeatureData['integrations']> = {
    tynnSignedIn: false,
    tynn: { host: 'https://tynn.ai', user: null, signInUrl: null, message: null },
    github: signedOutGithubView(null),
    gated: [{ id: 'tynn-sync', label: 'Sync work items with Tynn', tynn: true, enabled: false, note: 'Sign in to Tynn to use this', route: 'genie://settings/tynn' }],
    lastSync: null,
    mcp: { url: null, verified: null },
};
// Genie 1's sidebar (core/settings-nav.ts): Tynn and GitHub are pages of their own (Accounts); the agent files are on Agent MCP.
const render = (i: FeatureData['integrations'], section: SectionId = 'tynn') =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote: null, integrations: i }} onAction={() => {}} onNavigate={() => {}} section={section} workspaces={[{ id: 'tynn', path: '/w/tynn' }]} />);

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

    it('the hand-ticked GitHub checklist is gone: no steps, no “I did this”, no “done” chips', () => {
        // The owner (2026-10-20), on this page: "functional not some dumb list".
        const html = render(integrations, 'github');
        expect(html).not.toContain('data-github-step');
        expect(html).not.toContain('github-confirm');
        expect(html).not.toMatch(/I did this/);
    });

    it('config sync is not here: no Sync now and no results even after a sync — the note says each workspace’s Settings has it', () => {
        const html = render({ ...integrations, lastSync: { workspaceId: 'tynn', results: [{ id: 'claude', label: 'Claude Code (.mcp.json)', ok: true }, { id: 'cursor', label: 'Cursor (.cursor/mcp.json)', ok: false, error: 'EACCES' }, { id: 'codex', label: 'Codex (.codex/config.toml)', ok: true }, { id: 'hooks', label: 'Claude Code Stop hook (.claude/settings.local.json)', ok: true }] } }, 'agent-mcp');
        expect(html).not.toContain('data-action="sync-config"');
        expect(html).not.toContain('data-sync-result=');
        expect(html).toContain('data-workspace-files-note');
    });
});

/**
 * SETTINGS → GITHUB, FOR REAL (beta.33 item 25; Genie 1's GitHub card). The owner (2026-10-20): "our Github integration
 * and login needs to be way easier than this and it needs to be functional not some dumb list". Signed out: ONE button.
 * Signing in: GitHub's code, large, with Copy, and the page to type it on — Genie waits for GitHub by itself. Signed in:
 * who, where the App is installed (each account, its repositories, the permissions GitHub GRANTED, its own Configure),
 * Install on more repositories, what each permission lets Genie do, Check again, and Sign out.
 */
describe('Settings → GitHub', () => {
    const page = (github: GithubView) => render({ ...integrations, github }, 'github');
    const installs: GithubInstallation[] = [
        { id: 11, account: 'ada', isOrg: false, selection: 'all', repoCount: 40, repos: null, permissions: { metadata: 'read', contents: 'write', issues: 'read' }, settingsUrl: 'https://github.com/settings/installations/11' },
        { id: 22, account: 'Example-Org', isOrg: true, selection: 'selected', repoCount: 2, repos: ['Example-Org/site', 'Example-Org/api'], permissions: { metadata: 'read', issues: 'read' }, settingsUrl: 'https://github.com/organizations/Example-Org/settings/installations/22' },
    ];
    const signedIn = (over: Partial<GithubView> = {}): GithubView => ({
        status: 'signed-in', user: { login: 'ada', name: 'Ada' }, device: null, installations: installs,
        capabilities: githubCapabilities({ signedIn: true, installations: installs }), checking: false, signal: null, message: null, ...over,
    });

    it('signed out: one button to sign in with GitHub — no steps, no token field', () => {
        const html = page(signedOutGithubView(null));
        expect(html).toContain('data-github-status="signed-out"');
        expect(html).toMatch(/data-action="github-sign-in"[^>]*>(?:<[^>]+>)*Sign in with GitHub</);
        expect(html).not.toMatch(/type="password"/);
        expect(html).not.toContain('data-action="github-sign-out"');
    });

    it('signed out with a reason (Genie 1’s login could not be decrypted, a denial): the reason is on screen', () => {
        const html = page(signedOutGithubView('Genie 1’s GitHub sign-in is on this machine, but this Genie cannot decrypt it.'));
        expect(html).toMatch(/data-github-message[^>]*>Genie 1’s GitHub sign-in is on this machine, but this Genie cannot decrypt it\.</);
    });

    it('signing in: GitHub’s code large with Copy, the page to enter it, Cancel — and it says Genie is waiting, nothing to press', () => {
        const html = page({ ...signedOutGithubView(null), status: 'signing-in', device: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: 0 } });
        expect(html).toContain('data-github-status="signing-in"');
        expect(html).toMatch(/data-github-code="WDJB-MJHT"[^>]*>WDJB-MJHT</);
        expect(html).toContain('data-action="github-copy-code"');
        expect(html).toContain('data-action="github-open-device"');
        expect(html).toContain('github.com/login/device');
        expect(html).toContain('data-action="github-cancel"');
        expect(html).toMatch(/Waiting for GitHub/);
        expect(html).not.toContain('data-action="github-sign-in"');
    });

    // Changed 2026-10-21 (the owner, 2026-10-21, of the GitHub card's "Carried over from Genie 1": "this is not needed … it should be the same"): a login carried over from Genie 1 looks exactly like a sign-in made here.
    it('signed in: who, Check again and Sign out — and nothing says where the login came from', () => {
        const html = page(signedIn());
        expect(html).toContain('data-github-status="signed-in"');
        expect(html).toMatch(/Signed in as <strong>ada<\/strong>/);
        expect(html).not.toContain('data-github-carried');
        expect(html).not.toContain('Genie 1');
        expect(html).toContain('data-action="github-refresh"');
        expect(html).toContain('data-action="github-sign-out"');
        expect(html).not.toContain('data-action="github-sign-in"');
    });

    it('every installation: the account, personal or org, its repositories (listed when selected, counted when all), the permissions granted, and its own Configure', () => {
        const html = page(signedIn());
        expect(html).toContain('data-github-installation="ada"');
        expect(html).toContain('data-github-installation="Example-Org"');
        expect(html).toMatch(/All repositories \(40\)/);
        expect(html).toContain('Example-Org/site');
        expect(html).toContain('Example-Org/api');
        expect(html).toContain('data-github-permission="contents:write"');
        expect(html).toContain('data-github-permission="issues:read"');
        expect(html).toContain('data-action="github-configure-11"');
        expect(html).toContain('data-action="github-configure-22"');
        expect(html).toMatch(/data-action="github-install"[^>]*>(?:<[^>]+>)*Install on more repositories</);
    });

    it('what the permissions let Genie do, each row enabled or saying why not', () => {
        const html = page(signedIn());
        expect(html).toMatch(/data-github-capability="clone-private"[^>]*data-enabled="true"/);
        const noContents = page(signedIn({ installations: [installs[1]!], capabilities: githubCapabilities({ signedIn: true, installations: [installs[1]!] }) }));
        expect(noContents).toMatch(/data-github-capability="clone-private"[^>]*data-enabled="false"/);
        expect(noContents).toMatch(/Contents/);
    });

    it('GitHub not read yet: a skeleton, not an empty list; installed nowhere: says so and offers the install', () => {
        expect(page(signedIn({ installations: null, checking: true }))).toContain('data-github-installations="reading"');
        const none = page(signedIn({ installations: [], capabilities: githubCapabilities({ signedIn: true, installations: [] }) }));
        expect(none).toMatch(/not installed on any account/i);
        expect(none).toContain('data-action="github-install"');
    });

    it('a sign-in GitHub no longer accepts: said plainly, with Sign in again', () => {
        const html = page(signedIn({ status: 'expired', installations: null, message: 'GitHub no longer accepts this sign-in (revoked or expired). Sign in again.' }));
        expect(html).toContain('data-github-status="expired"');
        expect(html).toMatch(/no longer accepts/);
        expect(html).toMatch(/data-action="github-sign-in"[^>]*>(?:<[^>]+>)*Sign in again</);
    });
});
