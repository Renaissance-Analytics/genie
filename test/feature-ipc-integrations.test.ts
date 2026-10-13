import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * TYNN, GITHUB, CONFIG SYNC IN THE SNAPSHOT (§6.9). Tynn is the OPTIONAL identity layer: a token makes
 * Genie signed in; signed out, Tynn-gated rows are annotated with the route to sign in, never dropped.
 * The GitHub App is two distinct steps (authorize, then install) with the status derived from what
 * the person has confirmed. Config sync writes the four targets of a workspace and reports each.
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
    it('signed out of Tynn by default, GitHub blocked by authorize, no sync yet; gated rows are ANNOTATED, never dropped', async () => {
        const snap = await featureSnapshot(services, state());
        expect(snap.integrations).toEqual({
            tynnSignedIn: false,
            github: { steps: [{ id: 'authorize', done: false }, { id: 'install', done: false }], blocking: true, blockedBy: 'authorize', missingRepos: ['this workstation'], signal: { label: 'GitHub permissions are blocking features', route: 'genie://settings/github' } },
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

    it('integrations.tynnToken signs in (and an empty token signs out); integrations.githubConfirm marks each step done in order', async () => {
        const signedIn = await handleFeatureAction(services, { kind: 'integrations.tynnToken', token: 'tynn_abc' }, state());
        expect(signedIn.integrations!.tynnSignedIn).toBe(true);
        expect(signedIn.integrations!.gated[0]).toMatchObject({ enabled: true, note: null });
        expect((await handleFeatureAction(services, { kind: 'integrations.tynnToken', token: '' }, state())).integrations!.tynnSignedIn).toBe(false);

        await expect(handleFeatureAction(services, { kind: 'integrations.githubConfirm', step: 'install' }, state())).rejects.toThrow(/authorize first/);
        const authorized = await handleFeatureAction(services, { kind: 'integrations.githubConfirm', step: 'authorize' }, state());
        expect(authorized.integrations!.github).toMatchObject({ blockedBy: 'install', steps: [{ id: 'authorize', done: true }, { id: 'install', done: false }] });
        const installed = await handleFeatureAction(services, { kind: 'integrations.githubConfirm', step: 'install' }, state());
        expect(installed.integrations!.github).toMatchObject({ blocking: false, blockedBy: null, signal: null });
    });

    it('workspace.syncAgentFiles writes the four targets into the workspace and reports each; the snapshot carries the last sync', async () => {
        const snap = await handleFeatureAction(services, { kind: 'workspace.syncAgentFiles', workspaceId: 'tynn', workspacePath: ws }, state());
        expect(snap.integrations!.lastSync).toMatchObject({ workspaceId: 'tynn', results: [{ id: 'claude', ok: true }, { id: 'cursor', ok: true }, { id: 'codex', ok: true }, { id: 'hooks', ok: true }] });
        const mcp = JSON.parse(await readFile(join(ws, '.mcp.json'), 'utf8'));
        expect(mcp.mcpServers.genie.url).toBe('http://127.0.0.1:51717/mcp/abc');
        expect(await readFile(join(ws, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.genie]');
    });
});
