import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { TynnAccountPort } from '../src/main/tynn-account.js';
import type { GithubAccountPort } from '../src/main/github-account.js';
import type { GithubView } from '../src/core/github.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * TYNN, GITHUB, CONFIG SYNC IN THE SNAPSHOT (§6.9). Tynn is the OPTIONAL identity layer: a token makes
 * Genie signed in; signed out, Tynn-gated rows are annotated with the route to sign in, never dropped.
 * GitHub is the account's REAL status (main/github-account.ts: Genie 1's device-flow sign-in, its login carried over) —
 * no longer two steps the person ticked (the owner, 2026-10-20: "functional not some dumb list"). Config sync writes the
 * four targets of a workspace and reports each.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

let dir: string;
let ws: string;
let services: ComposedServices;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-integrations-'));
    ws = await mkdtemp(join(tmpdir(), 'genie2-ws-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, mcpEndpoint: () => ({ url: 'http://127.0.0.1:51717/mcp/abc', token: 'tok' }) });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
});

describe('integrations in the snapshot', () => {
    it('signed out of Tynn and GitHub by default (no account wired: doctor mode), no sync yet; gated rows are ANNOTATED, never dropped', async () => {
        const snap = await featureSnapshot(services, state());
        expect(snap.integrations).toEqual({
            tynnSignedIn: false,
            // No account port wired (doctor mode, these tests): signed out, nothing pending, the default host.
            tynn: { host: 'https://tynn.ai', user: null, signInUrl: null, message: null },
            // No GitHub account port: signed out, saying why, and NOT blocking (GitHub is optional; signed out is not a fault).
            github: expect.objectContaining({ status: 'signed-out', user: null, device: null, installations: null, signal: null, message: expect.stringMatching(/cannot sign in to GitHub here/) }),
            gated: [{ id: 'tynn-sync', label: 'Sync work items with Tynn', tynn: true, enabled: false, note: 'Sign in to Tynn to use this', route: 'genie://settings/tynn' }],
            lastSync: null,
            // The endpoint composeServices was given flows into the section; nothing has probed it in this test.
            mcp: { url: 'http://127.0.0.1:51717/mcp/abc', verified: null, tools: [] },
            // No workspace synced yet: nothing to report, not "current".
            agentFiles: [],
        });
    });

    it('a workspace’s agent-files sync reaches Settings: what it wrote, from the real files, and no failure', async () => {
        await services.syncAgentDocs(ws);
        const rows = (await featureSnapshot(services, state())).integrations!.agentFiles!;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.workspacePath).toBe(ws);
        expect(rows[0]!.failed).toEqual([]);
        expect(rows[0]!.changed).toEqual(expect.arrayContaining(['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'RULES.md', '.claude/skills/genie/SKILL.md']));
        expect(await readFile(join(ws, '.gitignore'), 'utf8')).toContain('.mcp.json');
        // A second sync of the same workspace changes nothing, and says so.
        await services.syncAgentDocs(ws);
        expect((await featureSnapshot(services, state())).integrations!.agentFiles![0]!.changed).toEqual([]);
    });

    it('the hand-ticked GitHub steps are gone: integrations.githubConfirm is not an action, and its two booleans are not settings', async () => {
        // The owner (2026-10-20): "functional not some dumb list". The two booleans it set no longer exist (core/settings.ts).
        // An old window sending it changes nothing: no flag is written, GitHub stays what the account says.
        const after = await handleFeatureAction(services, { kind: 'integrations.githubConfirm', step: 'authorize' } as never, state());
        expect(after.settings!.values).not.toHaveProperty('github_authorized');
        expect(after.integrations!.github).toMatchObject({ status: 'signed-out' });
        await expect(services.settings.set('github_authorized', true)).rejects.toThrow(/not a setting/);
        await expect(services.settings.set('github_installed', true)).rejects.toThrow(/not a setting/);
    });

    it('workspace.syncAgentFiles writes the four targets into the workspace and reports each; the snapshot carries the last sync', async () => {
        const snap = await handleFeatureAction(services, { kind: 'workspace.syncAgentFiles', workspaceId: 'tynn', workspacePath: ws }, state());
        expect(snap.integrations!.lastSync).toMatchObject({ workspaceId: 'tynn', results: [{ id: 'claude', ok: true }, { id: 'cursor', ok: true }, { id: 'codex', ok: true }, { id: 'hooks', ok: true }] });
        const mcp = JSON.parse(await readFile(join(ws, '.mcp.json'), 'utf8'));
        expect(mcp.mcpServers.genie.url).toBe('http://127.0.0.1:51717/mcp/abc');
        expect(await readFile(join(ws, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.genie]');
    });
});

/**
 * SIGN IN TO TYNN THE WAY GENIE 1 DID (the owner, 2026-10-19). Sign in opens Tynn in the browser and keeps its link on
 * screen for a machine without one; the code comes back by itself (genie://) or is pasted; Sign out revokes the key.
 * There is no token to type — the account (main/tynn-account.ts) is a port here, faked.
 */
describe('Tynn sign-in through the account', () => {
    function fakeAccount() {
        let user: { name: string; email: string } | null = null;
        const calls: string[] = [];
        const account: TynnAccountPort = {
            status: () => (user ? { signedIn: true, host: 'https://tynn.ai', user } : { signedIn: false }),
            host: () => 'https://tynn.ai',
            startSignIn: async () => { calls.push('open'); return { url: 'https://tynn.ai/genie/callback?return=genie%3A%2F%2Foauth%2Fcallback' }; },
            signIn: async (code) => {
                calls.push(`code:${code}`);
                if (code !== 'good') return { ok: false, reason: 'Tynn answered 422: That sign-in code is not valid.' };
                user = { name: 'Ada', email: 'ada@example.com' };
                return { ok: true, user };
            },
            signOut: async () => { calls.push('out'); user = null; return { ok: true, revoked: true }; },
            onChange: () => () => {},
        };
        return { account, calls };
    }

    it('Sign in opens Tynn and keeps the link on screen; a bad code says why; a good one signs in and clears both', async () => {
        const { account, calls } = fakeAccount();
        const ports: FeaturePorts = { tynnAccount: account };
        let s = state();
        const opened = await handleFeatureAction(services, { kind: 'integrations.tynnSignIn' }, s, ports);
        expect(opened.integrations!.tynn).toEqual({ host: 'https://tynn.ai', user: null, signInUrl: 'https://tynn.ai/genie/callback?return=genie%3A%2F%2Foauth%2Fcallback', message: null });
        s = { ...s, tynnSignInUrl: opened.integrations!.tynn.signInUrl, tynnMessage: opened.integrations!.tynn.message };

        const bad = await handleFeatureAction(services, { kind: 'integrations.tynnCode', code: 'stale' }, s, ports);
        expect(bad.integrations!.tynnSignedIn).toBe(false);
        expect(bad.integrations!.tynn.message).toBe('Tynn answered 422: That sign-in code is not valid.');
        expect(bad.integrations!.tynn.signInUrl).not.toBeNull();
        s = { ...s, tynnSignInUrl: bad.integrations!.tynn.signInUrl, tynnMessage: bad.integrations!.tynn.message };

        const good = await handleFeatureAction(services, { kind: 'integrations.tynnCode', code: 'good' }, s, ports);
        expect(good.integrations!.tynnSignedIn).toBe(true);
        expect(good.integrations!.tynn).toEqual({ host: 'https://tynn.ai', user: { name: 'Ada', email: 'ada@example.com' }, signInUrl: null, message: null });
        expect(good.integrations!.gated[0]).toMatchObject({ enabled: true, note: null });
        expect(calls).toEqual(['open', 'code:stale', 'code:good']);
    });

    it('Sign out goes through the account; a key Tynn could not revoke is said, not swallowed', async () => {
        const { account, calls } = fakeAccount();
        await account.signIn('good');
        const out = await handleFeatureAction(services, { kind: 'integrations.tynnSignOut' }, state(), { tynnAccount: account });
        expect(out.integrations!.tynnSignedIn).toBe(false);
        expect(out.integrations!.tynn.message).toBeNull();
        expect(calls).toEqual(['code:good', 'out']);

        await account.signIn('good');
        const unreachable: TynnAccountPort = { ...account, signOut: async () => ({ ok: true, revoked: false, reason: 'Tynn could not be reached — revoke it there.' }) };
        expect((await handleFeatureAction(services, { kind: 'integrations.tynnSignOut' }, state(), { tynnAccount: unreachable })).integrations!.tynn.message).toBe('Tynn could not be reached — revoke it there.');
    });

    it('CONTROL: without an account port the actions refuse in words — nothing pretends to sign in', async () => {
        await expect(handleFeatureAction(services, { kind: 'integrations.tynnCode', code: 'good' }, state())).rejects.toThrow(/cannot sign in to Tynn/);
    });
});

/**
 * GITHUB THROUGH THE ACCOUNT (beta.33 item 25). Each GitHub action reaches the account (main/github-account.ts, faked
 * here); the snapshot carries the account's view as it is — the real status read from GitHub — never a value the
 * window sent. Opening a page names WHICH page; the URL is the account's own.
 */
describe('GitHub through the account', () => {
    function fakeGithubAccount() {
        const calls: string[] = [];
        let view: GithubView = { status: 'signed-out', user: null, carriedFromGenie1: false, device: null, installations: null, capabilities: [], checking: false, signal: null, message: null };
        const account: GithubAccountPort = {
            view: () => view,
            startSignIn: async () => { calls.push('sign-in'); view = { ...view, status: 'signing-in', device: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: 0 } }; },
            cancelSignIn: () => { calls.push('cancel'); view = { ...view, status: 'signed-out', device: null }; },
            signOut: async () => { calls.push('sign-out'); view = { ...view, status: 'signed-out', user: null }; },
            refresh: async () => { calls.push('refresh'); },
            openPage: async (target) => { calls.push(`open:${target.page}${target.page === 'installation' ? `:${target.installationId}` : ''}`); },
            onChange: () => () => {},
        };
        return { account, calls };
    }

    it('sign in, cancel, check again, the pages, sign out — each through the account; the snapshot is its view', async () => {
        const { account, calls } = fakeGithubAccount();
        const ports: FeaturePorts = { githubAccount: account };
        const signingIn = await handleFeatureAction(services, { kind: 'integrations.githubSignIn' }, state(), ports);
        expect(signingIn.integrations!.github).toMatchObject({ status: 'signing-in', device: { userCode: 'WDJB-MJHT' } });
        expect((await handleFeatureAction(services, { kind: 'integrations.githubCancelSignIn' }, state(), ports)).integrations!.github.status).toBe('signed-out');
        await handleFeatureAction(services, { kind: 'integrations.githubRefresh' }, state(), ports);
        await handleFeatureAction(services, { kind: 'integrations.githubOpen', target: { page: 'install' } }, state(), ports);
        await handleFeatureAction(services, { kind: 'integrations.githubOpen', target: { page: 'installation', installationId: 22 } }, state(), ports);
        await handleFeatureAction(services, { kind: 'integrations.githubSignOut' }, state(), ports);
        expect(calls).toEqual(['sign-in', 'cancel', 'refresh', 'open:install', 'open:installation:22', 'sign-out']);
    });

    it('CONTROL: without an account port the GitHub actions refuse in words', async () => {
        await expect(handleFeatureAction(services, { kind: 'integrations.githubSignIn' }, state())).rejects.toThrow(/cannot sign in to GitHub here/);
    });
});
