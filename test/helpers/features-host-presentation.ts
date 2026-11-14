import { expect, vi } from 'vitest';
import type { DeckItem } from '../../src/core/deck.js';
import type { CallContext } from '../../src/core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../../src/renderer/features.js';
import type { AttentionStore } from '../../src/main/attention-store.js';
import { runCliRepair } from '../../src/main/cli-repair.js';
import type { HostFeatureDeckPorts, HostFeaturePresentation } from '../../src/main/features-host.js';
import { installTailscale } from '../../src/main/tailscale-cli.js';
import { CALLER_A, CALLER_B, RECIPIENT, deferred, workspaceCallerFixture } from './features-host-workspace-caller.js';

export { CALLER_A, CALLER_B, deferred };
export const item = (over: Partial<DeckItem> = {}): DeckItem => ({ id: 'q_fixture', source: 'agent-question',
    agentId: RECIPIENT, agentName: 'fixture', workspaceId: 'work', title: 'Fixture question', blocking: true, priority: 'normal',
    at: 1, answer: { kind: 'inline', options: [{ id: 'yes', label: 'Yes', tone: 'neutral' }] }, forwardedFrom: null, ...over });
export const resultOf = <T>(work: Promise<T>) => work.then(value => ({ ok: true as const, value }),
    error => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));

/** Real host owners and CLI/installer planners. Every OS/UI boundary is inert and records which caller it served. */
export async function presentationFixture() {
    const f = await workspaceCallerFixture();
    const calls: Array<{ owner: string; effect: string; value?: unknown }> = [];
    const holds: Array<() => void> = [];
    const windows = new Map<string, HostFeaturePresentation>();
    const history = new Map<string, { url: string | null; canGoBack: boolean; canGoForward: boolean }>();
    const record = (owner: string, effect: string, value?: unknown) => { calls.push({ owner, effect, ...(value === undefined ? {} : { value }) }); };
    const addWindow = (context: CallContext) => {
        const owner = context.connectionId, view = { url: null as string | null, canGoBack: false, canGoForward: false };
        history.set(owner, view);
        const ports: HostFeaturePresentation = {
            openFlowEditor: async route => { record(owner, 'flow', route); },
            openInBrowser: async url => { record(owner, 'site', url); view.url = url; return { ok: true }; },
            browser: { snapshot: () => ({ ...view }), navigate: async url => { record(owner, 'navigate', url); view.url = url; },
                back: async () => { record(owner, 'back'); view.url = 'https://previous.gen/'; view.canGoForward = true; },
                forward: async () => { record(owner, 'forward'); view.url = 'https://next.gen/'; view.canGoBack = true; },
                reload: async () => { record(owner, 'reload'); } },
            rendererNotice: { dismiss: async () => { record(owner, 'renderer-notice'); return { ok: true }; } },
            login: async provider => { record(owner, 'login', provider); return { ok: true }; },
            githubOpen: async target => { record(owner, 'github', target); },
            tailscaleInstall: async () => {
                const result = await installTailscale({ platform: 'linux', installed: () => null,
                    download: async () => { throw new Error('Linux never downloads the Windows installer'); } });
                if (result.url) record(owner, 'external', result.url);
                return result;
            },
            mainErrors: { dismiss: id => { record(owner, 'error-dismiss', id); return true; },
                retryHostCopy: async id => { record(owner, 'host-copy', id); return { ok: true }; },
                openLog: async id => { record(owner, 'log', id); return null; },
                report: async id => { record(owner, 'report', id); return null; } },
        };
        windows.set(owner, ports); return ports;
    };
    const a = addWindow(CALLER_A), b = addWindow(CALLER_B);
    const resolve = vi.fn((context: CallContext) => windows.get(context.connectionId) ?? null);
    const systemCalls: string[] = [], systemFailure = { reason: null as string | null };
    const systemResult = async (effect: string) => { systemCalls.push(effect);
        return systemFailure.reason ? { ok: false as const, reason: systemFailure.reason } : { ok: true as const }; };
    const system = { safeMode: { leave: () => systemResult('safe-mode') },
        hangNotice: { dismiss: () => systemResult('hang-dismiss'), stopAll: () => systemResult('hang-stop') } };
    const attention = f.service.ports.attention as AttentionStore;
    const deckItems: DeckItem[] = [], approvalIds = new Set(['appr_fixture']), deliveries: Array<readonly string[]> = [];
    const deck: HostFeatureDeckPorts = { attention, inbox: f.inbox,
        approvals: { resolve: (id, choice) => { if (!approvalIds.delete(id)) return false; record('host', 'approval', [id, choice]); return true; } },
        deliverToAgent: async (id, text) => { deliveries.push([id, text]); return true; },
        trustCertificate: async () => { record('host', 'trust-certificate'); return { ok: true }; },
        deferTrustCertificate: () => { record('host', 'defer-certificate'); }, syncHosts: () => f.hosting.syncHosts(),
        deckItems: () => deckItems,
    };
    Object.assign(f.service.ports, { presentation: resolve, system, deck });
    const invoke = (action: FeatureAction, context = CALLER_A) => resultOf(f.act(action, context));
    const answer = async (action: FeatureAction, context = CALLER_A): Promise<FeatureData> => {
        const result = await invoke(action, context); expect(result, result.ok ? undefined : result.reason).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('the preceding assertion failed'); return result.value;
    };
    const health = (installed: boolean) => ({ provider: 'claude', ok: installed, installed, signedIn: installed ? true : null,
        version: installed ? '2.1.0' : null, program: null, fault: installed ? null : 'missing' as const, words: 'fixture health', checkedAt: 1 });
    const cli = { calls: 0, steps: [] as string[], fail: false, throw: false, hold: false, entered: deferred(), finish: deferred() };
    holds.push(() => cli.finish.resolve());
    let installed = false;
    Object.assign(f.toolchain, { repairCli: (provider: string, progress: (step: string | null) => void) => runCliRepair(provider, {
        platform: 'linux', env: { get: name => name === 'HOME' ? '/home/someone' : '/fixture', set: () => {} },
        isFile: () => true, refreshPath: async () => {}, check: async () => health(installed), progress,
        run: async (_binary, _args, options) => {
            cli.calls++; cli.steps.push(String(options.timeoutMs)); cli.entered.resolve();
            // Only the first run is held. A duplicate run must be observable as an assertion failure, not a deadlock.
            if (cli.hold && cli.calls === 1) await cli.finish.promise;
            if (cli.throw) throw new Error('fixture runner disconnected');
            if (!cli.fail) installed = true;
            return { exitCode: cli.fail ? 3 : 0, stdout: cli.fail ? 'fixture repair refused' : '' };
        },
    }) });
    const holdSetting = (context = CALLER_A) => {
        const entered = deferred(), finish = deferred(), original = f.settings.set.bind(f.settings);
        holds.push(() => finish.resolve());
        vi.spyOn(f.settings, 'set').mockImplementationOnce(async (key, value) => { entered.resolve(); await finish.promise; return original(key, value); });
        return { entered: entered.promise, release: () => finish.resolve(), start: () => invoke({ kind: 'settings.set', key: 'publisher_checks_off', value: false }, context) };
    };
    const close = async () => { for (const release of holds.splice(0)) release(); await f.settle(); await f.close(); };
    return { ...f, answer, invoke, calls, windows, history, a, b, resolve, record, system, systemCalls, systemFailure,
        attention, deck, deckItems, deliveries, cli, holds, holdSetting, addWindow, close };
}
export type PresentationFixture = Awaited<ReturnType<typeof presentationFixture>>;
