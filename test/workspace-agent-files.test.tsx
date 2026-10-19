import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentFilesHealth, agentFilesWhen } from '../src/core/agent-files-health.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * A WORKSPACE'S AGENT FILES ARE IN THAT WORKSPACE'S SETTINGS. The owner, on beta.20 (2026-10-13): "I just did this config
 * sync thing (not really sure why that is in workstation settings and not in a workspace settings like it should be),
 * and I chose one workspace but it updated all workspaces". Measured: Sync now wrote only the picked workspace (moic's
 * .mcp.json 12:55, every other workspace 11:54 = Genie's start). Workstation settings drew the picker directly above
 * "Agent files in each workspace" — Genie START's record, with no time and no source — so the start's record read as
 * the click's result.
 *
 * Now: each workspace's Settings has its own Agent files status, saying WHEN and BY WHOM (`at Genie start · 11:54`,
 * `by you · 12:55`), and a Sync now for that workspace alone — no picker. Workstation settings keeps the harness
 * switches and says where each workspace's status lives.
 */

const at = (h: number, m: number) => new Date(2026, 9, 13, h, m).getTime();

describe('the record says when, and who', () => {
    it('Genie’s start and your Sync now are told apart; the latest of the docs run and the config sync is the one shown', async () => {
        const health = new AgentFilesHealth();
        await health.run('/w/moic', [{ step: 'protocol', run: async () => {} }], at(11, 54), 'start');
        expect(agentFilesWhen(health.list()[0]!)).toBe('at Genie start · 11:54');
        health.config('/w/moic', [{ label: 'Claude Code', ok: true }], at(12, 55), 'you');
        expect(health.list()[0]!).toMatchObject({ at: at(12, 55), source: 'you' });
        expect(agentFilesWhen(health.list()[0]!)).toBe('by you · 12:55');
    });
});

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

describe('Sync now syncs THAT workspace — and only it', () => {
    let dir: string;
    let moic: string;
    let other: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-wssync-'));
        moic = await mkdtemp(join(tmpdir(), 'genie2-ws-moic-'));
        other = await mkdtemp(join(tmpdir(), 'genie2-ws-other-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, mcpEndpoint: () => ({ url: 'http://127.0.0.1:51717/mcp', token: 'tok' }) });
    });
    afterEach(async () => {
        await services.shutdown();
        for (const d of [dir, moic, other]) await rm(d, { recursive: true, force: true });
    });

    it('writes its agent files and its four harness configs, records "you", and leaves every other workspace alone', async () => {
        const snap = await handleFeatureAction(services, { kind: 'workspace.syncAgentFiles', workspaceId: 'moic', workspacePath: moic }, state());
        expect(snap.integrations!.lastSync).toMatchObject({ workspaceId: 'moic', results: [{ id: 'claude', ok: true }, { id: 'cursor', ok: true }, { id: 'codex', ok: true }, { id: 'hooks', ok: true }] });
        // Positive control: the picked workspace got BOTH halves — the agent files and the MCP config.
        expect(JSON.parse(await readFile(join(moic, '.mcp.json'), 'utf8')).mcpServers.genie.url).toBe('http://127.0.0.1:51717/mcp');
        expect(await readFile(join(moic, 'CLAUDE.md'), 'utf8')).not.toBe('');
        // The other workspace: nothing written.
        await expect(stat(join(other, '.mcp.json'))).rejects.toThrow();
        await expect(stat(join(other, 'CLAUDE.md'))).rejects.toThrow();
        const reports = (await featureSnapshot(services, state())).integrations!.agentFiles!;
        expect(reports.map((r) => [r.workspacePath, r.source])).toEqual([[moic, 'you']]);
    });
});

const ops = (agentFiles: WorkspaceOpsProps['agentFiles']): WorkspaceOpsProps => ({
    asleep: false, agentCount: 1, removePreview: false, lastOutcome: null,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    agentFiles,
});
const renderWs = (o: WorkspaceOpsProps) =>
    renderToStaticMarkup(<Workspace view="settings" workspace={{ id: 'moic', name: 'Moic Suite', path: '/w/moic' }} terminals={NO_TERMINALS} ops={o} />);

describe('the workspace’s Settings', () => {
    it('shows this workspace’s status with when and who, and a Sync now with no picker', () => {
        const html = renderWs(ops({ report: { workspacePath: '/w/moic', at: at(11, 54), source: 'start', changed: ['CLAUDE.md'], failed: [] }, results: null, onSync: () => {} }));
        expect(html).toContain('data-ws-agent-files');
        expect(html).toContain('upgraded: CLAUDE.md');
        expect(html).toContain('at Genie start · 11:54');
        expect(html).toContain('data-action="ws-sync-agent-files"');
        expect(html).not.toContain('<select');
        expect(html).not.toContain('data-sync-result=');
    });

    it('after Sync now: its four results, one line each; before any sync it says so — not "current"', () => {
        const results = [
            { id: 'claude', label: 'Claude Code (.mcp.json)', ok: true },
            { id: 'cursor', label: 'Cursor (.cursor/mcp.json)', ok: false, error: 'EACCES' },
            { id: 'codex', label: 'Codex (.codex/config.toml)', ok: true },
            { id: 'hooks', label: 'Claude Code Stop hook (.claude/settings.local.json)', ok: true },
        ];
        const html = renderWs(ops({ report: { workspacePath: '/w/moic', at: at(12, 55), source: 'you', changed: [], failed: [{ step: 'Cursor (.cursor/mcp.json)', error: 'EACCES' }] }, results, onSync: () => {} }));
        expect((html.match(/data-sync-result="/g) ?? []).length).toBe(4);
        expect(html).toContain('data-sync-result="cursor" data-ok="false"');
        expect(html).toContain('by you · 12:55');
        const none = renderWs(ops({ report: null, results: null, onSync: () => {} }));
        expect(none).toContain('data-ws-agent-files-state="none"');
        expect(none).not.toMatch(/>current</);
    });
});

describe('Workstation settings', () => {
    const integrations: NonNullable<FeatureData['integrations']> = {
        tynnSignedIn: false,
        tynn: { host: 'https://tynn.ai', user: null, signInUrl: null, message: null },
        github: { steps: [{ id: 'authorize', done: true }, { id: 'install', done: true }], blocking: false, blockedBy: null, missingRepos: [], signal: null },
        gated: [],
        lastSync: { workspaceId: 'moic', results: [{ id: 'claude', label: 'Claude Code (.mcp.json)', ok: true }] },
        mcp: { url: null, verified: null },
        agentFiles: [
            { workspacePath: '/w/moic', at: at(12, 55), source: 'you', changed: [], failed: [] },
            { workspacePath: '/w/fancy', at: at(11, 54), source: 'start', changed: ['CLAUDE.md'], failed: [] },
        ],
    };
    const html = renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote: null, integrations }} onAction={() => {}} onNavigate={() => {}} section="agent-mcp" workspaces={[{ id: 'moic', path: '/w/moic' }, { id: 'fancy', path: '/w/fancy' }]} />);

    it('has no workspace picker, no Sync now and no per-workspace list — it says where each workspace’s status is', () => {
        expect(html).toContain('data-integrations'); // positive control: the section rendered
        expect(html).not.toContain('data-action="sync-config"');
        expect(html).not.toContain('data-agent-files-row=');
        expect(html).not.toContain('data-sync-result=');
        expect(html).toContain('data-workspace-files-note');
        expect(html).toMatch(/each workspace’s own Settings/);
    });

    it('keeps the four harness switches', () => {
        for (const key of ['mcp_sync_claude', 'mcp_sync_cursor', 'mcp_sync_codex', 'mcp_sync_hooks']) expect(html).toContain(key);
    });
});
