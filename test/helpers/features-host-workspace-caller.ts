import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, vi } from 'vitest';
import type { AgentId } from '../../src/core/identity.js';
import { whatsNewFor } from '../../src/core/whats-new.js';
import type { CallContext } from '../../src/core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../../src/renderer/features.js';
import type { WindowServices } from '../../src/main/compose.js';
import { handleFeatureAction } from '../../src/main/feature-ipc.js';
import { trustSteps } from '../../src/main/hosting-trust.js';
import { writeAgentProtocol } from '../../src/main/config-sync-targets.js';
import { configWriter, writeWorkspaceConfig } from '../../src/main/workspace-config-sync.js';
import { groupThreeFixture } from './features-host-group3.js';

export const CALLER_A: CallContext = Object.freeze({ connectionId: 'workspace-caller-a', origin: 'local-window', profile: 'desktop',
    isOwner: true, workspaceId: null, readonly: false, label: 'window A' });
export const CALLER_B: CallContext = Object.freeze({ ...CALLER_A, connectionId: 'workspace-caller-b', label: 'window B' });
export const RELEASE = '2.0.0-beta.63';
export const NOTES = { [RELEASE]: '## What\'s new\n\nFixture user-facing notes.\n\n## Build\nNot for the page.' };
export const RECIPIENT = ('agent_' + 'c'.repeat(32)) as AgentId;
export const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

/** Real trust, protocol and four-target config writers over temporary files; never a window/service recomposition. */
export async function workspaceCallerFixture() {
    const f = await groupThreeFixture(), order: string[] = [];
    const faults = { docs: false, config: false };
    const fs = {
        read: async (path: string) => { try { return await readFile(path, 'utf8'); } catch { return null; } },
        write: async (path: string, text: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, 'utf8'); },
        remove: async (path: string) => { try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } },
        list: async (path: string) => { try { return await readdir(path); } catch { return []; } },
    };
    const endpoint = { url: 'http://127.0.0.1:7400/mcp', token: '' };
    const withConfig = configWriter();
    await writeFile(join(f.workspace, '.mcp.json'), JSON.stringify({ mcpServers: { other: { url: 'https://example.com/mcp' } } }));
    // These are the same owned ports used by the host and historical shared action path. The host's wrappers keep
    // their receiver; the underlying trust service and disk writers are real. Only errors are injected below.
    const docs = vi.fn(async (path: string, source?: string) => {
        order.push(`docs:${source}`);
        if (faults.docs) throw new Error('fixture protocol writer failed');
        if (!await f.hosting.trust.mayWriteInto(path)) return;
        await writeAgentProtocol({ workspacePath: path, fs, enabled: f.settings.get('mcp_sync_agents') !== false,
            tools: [{ name: 'fixture_tool', description: 'fixture tool' }], tracking: 'files' });
    });
    const config = vi.fn(async (path: string, source?: string) => {
        order.push(`config:${source}`);
        if (faults.config) throw new Error('fixture config writer failed');
        if (!await f.hosting.trust.mayWriteInto(path)) return [];
        return withConfig(path, () => writeWorkspaceConfig({ workspacePath: path, endpoint, flags: {
            mcp_sync_claude: f.settings.get('mcp_sync_claude') !== false, mcp_sync_cursor: f.settings.get('mcp_sync_cursor') !== false,
            mcp_sync_codex: f.settings.get('mcp_sync_codex') !== false, mcp_sync_hooks: f.settings.get('mcp_sync_hooks') !== false,
        } }));
    });
    const trust = vi.fn(async (id: string) => { order.push('trust'); return f.hosting.trust.trust(id); });
    const untrust = vi.fn(async (id: string) => { order.push('untrust'); return f.hosting.trust.untrust(id); });
    Object.assign(f.machine.services.workspaceTrust, { trust, untrust });
    Object.assign(f.machine.services, { syncAgentDocs: docs, syncConfig: config });
    Object.assign(f.machine.effects, { whatsNew: (shown: boolean) => whatsNewFor(RELEASE, String(f.settings.get('whats_new_seen_version') ?? ''), NOTES, shown) });
    Object.assign(f.service.ports, { resolveAddress: () => ({ kind: 'one', id: RECIPIENT }) });
    const snapshot = (context = CALLER_A) => f.api.invoke('features.snapshot', [], context).then(value => value as FeatureData);
    const act = (action: FeatureAction, context = CALLER_A) => f.api.invoke('features.act', [action], context).then(value => value as FeatureData);
    const answer = async (action: FeatureAction, context = CALLER_A) => {
        const result = await act(action, context).then(value => ({ ok: true as const, value }),
            error => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
        expect(result, result.ok ? undefined : result.reason).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('the preceding assertion failed');
        return result.value;
    };
    const legacy = (action: FeatureAction) => handleFeatureAction({ ...f.service.ports, ...f.hosting, ...f.machine.services,
        supervisor: f.supervisor, trustSteps: () => trustSteps(f.hosting.trust.entries()), workspaceVisible: () => true,
        agentAddresses: () => [], flowScheduler: { runNow: f.service.ports.runFlow }, pluginsRefresh: f.service.ports.refreshPlugins,
    } as unknown as WindowServices, action, { toolStatuses: null, knowledgeQuery: '' }, f.machine.effects);
    const read = (path: string) => readFile(join(f.workspace, path), 'utf8');
    return { ...f, inbox: f.service.ports.inbox, knowledge: f.service.ports.knowledge,
        act, answer, snapshot, legacy, order, faults, docs, config, trust, untrust, read, fs, endpoint };
}
export type WorkspaceCallerFixture = Awaited<ReturnType<typeof workspaceCallerFixture>>;
