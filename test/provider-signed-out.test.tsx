import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnoseAgent } from '../src/core/workspace-model.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { composeServices } from './helpers/compose-alone.js';
import type { ComposedServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/*
 * Tynn #698 story 1, the coordinator's ruling: SIGNED OUT IS NOT BROKEN. "Broken" is only for a CLI that cannot run. A CLI
 * that runs but reports signed out reads "Not signed in" with the existing Log in (the provider's own login, LoginHost), and
 * an agent of that provider offers Log in beside Start, never a refusal.
 */
const toolchain = async () => { const path: string = '../src/core/toolchain.js'; return import(path) as Promise<any>; };
const agentView = async () => { const path: string = '../src/core/agent-view.js'; return import(path) as Promise<any>; };
const detail = async () => { const path: string = '../src/main/agent-detail.js'; return import(path) as Promise<any>; };
const featureIpc = async () => { const path: string = '../src/main/feature-ipc.js'; return import(path) as Promise<any>; };

const CODEX = { tool: 'codex', installed: '0.167.1', latest: '0.167.1', tone: 'up-to-date', source: 'npm' };
const signedOut = { provider: 'codex', ok: false, installed: true, signedIn: false, fault: 'signed-out', words: 'Codex is not signed in on this machine', version: '0.167.1', program: 'x', checkedAt: 1 };

describe('an agent of a signed-out provider', () => {
    it('is diagnosed signed out with Log in as the repair, never broken; a CLI that cannot run stays broken', () => {
        const out = diagnoseAgent({ threadId: 't', lastUsedAt: 'x', session: null, providerInstalled: true, signedIn: false, provider: 'codex' });
        expect(out.state).not.toBe('broken');
        expect(out).toMatchObject({ state: 'signed-out', cause: 'codex is not signed in', repair: { action: 'sign-in' } });
        expect(diagnoseAgent({ threadId: 't', lastUsedAt: 'x', session: null, providerInstalled: false, signedIn: false, provider: 'codex' })).toMatchObject({ state: 'broken', repair: { action: 'install-provider' } });
    });

    it('offers Log in beside Start when it is not running; a signed-in provider offers Start alone', async () => {
        const { headerActions } = await agentView();
        expect(headerActions(null, 'declared', true)).toMatchObject({ start: true, login: true });
        expect(headerActions(null, 'declared', false)).toMatchObject({ start: true, login: false });
        expect(headerActions(null, 'declared')).toMatchObject({ start: true, login: false });
    });

    it('its detail says the provider is signed out, from the health book', async () => {
        const { agentDetailFor } = await detail();
        const record = { id: 'agent_a', workspaceId: 'ws', name: 'atlas', provider: 'codex', threadId: null, lastUsedAt: null, mode: 'automated', accessScope: 'self' };
        const engine = { probe: () => null, ledgerFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], rowsFor: () => [], refusals: new Map() };
        const ports = (signedIn: boolean) => ({ registry: { find: () => record, listAgents: () => [record], defaultAgentOf: () => null }, engine, cwdFor: () => '/w', providerSignedIn: () => signedIn });
        expect(agentDetailFor(ports(false), 'agent_a')).toMatchObject({ providerSignedOut: true });
        expect(agentDetailFor(ports(true), 'agent_a').providerSignedOut).toBeFalsy();
    });

    it('the Agent view hands that to its header actions', () => {
        const src = readFileSync(new URL('../src/renderer/components/AgentView.tsx', import.meta.url), 'utf8');
        expect(src).toMatch(/headerActions\(session, agent\.fidelity, providerSignedOut === true\)/);
        expect(readFileSync(new URL('../src/renderer/Shell.tsx', import.meta.url), 'utf8')).toMatch(/providerSignedOut=\{agentDetail\.providerSignedOut === true\}/);
    });
});

describe('a signed-out agent CLI on the Toolchain', () => {
    it('reads Not signed in with a Log in button, not Broken', async () => {
        const { withProviderHealth } = await toolchain();
        const [codex] = withProviderHealth([CODEX], [signedOut]);
        expect(codex).toMatchObject({ tone: 'up-to-date', signedOut: true });
        const html = renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain: { tools: [codex], checkedAt: 1 } as FeatureData['toolchain'] }} onAction={() => {}} onNavigate={() => {}} />);
        const row = html.slice(html.indexOf('data-tool="codex"'), html.indexOf('</li>', html.indexOf('data-tool="codex"')));
        expect(row).toContain('Not signed in');
        expect(row).toContain('data-action="toolchain-login"');
        expect(row).not.toContain('Broken');
    });

    describe('its Log in', () => {
        const pty: PtyPort = { open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
        let dir: string;
        let services: ComposedServices;
        beforeEach(async () => {
            dir = await mkdtemp(join(tmpdir(), 'genie2-provider-signed-out-'));
            services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
        });
        afterEach(async () => {
            await services.shutdown();
            await rm(dir, { recursive: true, force: true });
        });

        it('opens the provider\'s own login (LoginHost), for the row\'s provider; a failure is said on the row', async () => {
            const { handleFeatureAction } = await featureIpc();
            const logins: string[] = [];
            const ports = (ok: boolean) => ({ toolchain: { probe: async () => [CODEX], update: async () => ({ kind: 'refused', reason: 'no' }), now: () => 1, login: (provider: string) => { logins.push(provider); return ok ? { ok: true } : { ok: false, reason: 'no terminal here' }; } } });
            const state = { toolStatuses: [CODEX], knowledgeQuery: '', toolchainCheckedAt: 1 };
            const done = await handleFeatureAction(services, { kind: 'toolchain.login', tool: 'codex' }, state, ports(true));
            expect(logins).toEqual(['codex']);
            expect(done.toolchain?.refusals).toBeUndefined();
            const failed = await handleFeatureAction(services, { kind: 'toolchain.login', tool: 'claude-code' }, state, ports(false));
            expect(logins).toEqual(['codex', 'claude']);
            expect(failed.toolchain?.refusals).toEqual([{ tool: 'claude-code', reason: 'no terminal here' }]);
        });
    });
});
