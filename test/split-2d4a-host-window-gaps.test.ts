import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { ACCOUNT_BACK } from '../src/core/provider-login.js';
import { LOCAL_EVENTS } from '../src/core/remote-protocol.js';
import { retryPausedAgents } from '../src/main/agent-ops-host.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostLocalPorts, type HostLocalSources } from '../src/main/host-local-ports.js';
import type { InboxMessage } from '../src/main/inbox-store.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * CLIENT/HOST SPLIT STEP 2d-4a (Tynn #898): THE LAST THREE ANSWERS ONLY WINDOW MAIN GAVE ITS WINDOW.
 *
 * At 2d-4 this machine's window is served by genie-host's RemoteHost. Three things main's host API gave it that genie-host's
 * answers did not:
 *   - the GApp book's change signal (`local-gapps`): the Apps list follows installs and removals;
 *   - Try again for a paused account (`accountRetry`): genie-host answered { ok: true } and restarted nothing;
 *   - a chat refreshing when mail or a read receipt arrives (`subscribeAgentChat`).
 * Each is genie-host's now, from its own GApp book, session host and inbox.
 */

let dir = '';
let registry: Registry;
let atlas: AgentRecord;

function engine(over: Record<string, unknown> = {}): HostAloneEngine {
    return { probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true, ...over } as unknown as HostAloneEngine;
}

function ports(over: Record<string, unknown> = {}, e: HostAloneEngine = engine()): HostAlonePorts {
    return {
        hostName: 'alphar', registry, engine: () => e, cwdFor: () => '/w', startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true,
        attention: { finished: () => [], answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] },
        deliverToAgent: async () => true,
        files: { children: async () => [], open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        terminals: { open: () => null, list: () => [], attach: () => null, write: () => true, resize: () => true, close: () => true, onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        headroom: { view: () => ({}), subscribe: () => () => {} },
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {}, onChange: () => () => {} },
        serviceEnvFor: () => ({}),
        uploads: { sendFile: async () => ({ ok: true, messageId: 'msg_1' }) },
        workspaceLifecycle: { terminals: () => null, supervisor: () => null, engines: () => null, reverifyTrust: async () => {}, github: () => null, tynn: () => null, defaultEnvFile: () => '', stagingDirectory: () => '' },
        colors: { set: async () => ({ ok: true }) },
        tynnTab: { board: async () => ({ signedIn: () => true, projectFor: () => null, request: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), readPage: async () => ({ ok: true }) },
        ...over,
    } as unknown as HostAlonePorts;
}

/** genie-host's own parts for its local ports; only the GApp book's change signal matters here. */
function sources(changed: Set<() => void>): HostLocalSources {
    return {
        workspaces: () => [], workspacePath: () => null, files: () => null, plugins: { dump: () => ({ entries: [], panels: [], editors: [], manifests: {} }) as never },
        sendFromPerson: async () => {}, drafts: null as never, terminals: () => null, trackCwd: () => false, terminalEnv: () => ({}),
        marketplace: () => null, gapps: () => null,
        onGappsChanged: (listener) => { changed.add(listener); return () => { changed.delete(listener); }; },
        say: () => {},
    };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-split-2d4a-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await mkdir(join(dir, 'tynn'));
    await writeFile(join(dir, 'tynn', 'project.json'), JSON.stringify({ name: 'tynn' }));
    await registry.addWorkspace({ id: 'tynn', path: join(dir, 'tynn') });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the GApp book\'s changes', () => {
    it('genie-host\'s local ports carry the book\'s change signal', () => {
        const changed = new Set<() => void>();
        const local = hostLocalPorts(sources(changed));
        let told = 0;
        const off = local.gappsChanged.subscribe(() => { told++; });
        expect(changed.size).toBe(1);
        for (const l of [...changed]) l();
        off();
        expect(told).toBe(1);
        expect(changed.size).toBe(0);
    });

    it('a change reaches genie-host\'s answers\' listeners as the local GApps signal', () => {
        const changed = new Set<() => void>();
        const api = hostAloneApi(ports({ local: hostLocalPorts(sources(changed)) }));
        const heard: string[] = [];
        const off = api.onEvent((channel) => { heard.push(channel); });
        for (const l of [...changed]) l();
        off();
        expect(heard).toContain(LOCAL_EVENTS.gapps);
    });
});

describe('Try again for a paused account', () => {
    it('every agent the provider paused restarts, and each that comes back is told its account is back', async () => {
        const said: unknown[][] = [];
        let touched = 0;
        await retryPausedAgents({
            paused: (provider) => (provider === 'claude' ? ['a1', 'a2'] : ['other']),
            restart: async (id) => ({ ok: id === 'a1' }),
            prompt: (id, text) => { said.push([id, text]); },
            touch: () => { touched++; },
        }, 'claude');
        expect(said).toEqual([['a1', ACCOUNT_BACK]]);
        expect(touched).toBe(2);
    });

    it('genie-host asks its own session host which agents the provider paused', async () => {
        const asked: string[] = [];
        const api = hostAloneApi(ports({}, engine({ pausedAgents: (provider: string) => { asked.push(provider); return []; } })));
        expect(await api.invoke('accountRetry', [atlas.id])).toEqual({ ok: true });
        expect(asked).toEqual(['claude']);
    });
});

describe('a chat follows its mail', () => {
    it('a message to or from an agent refreshes it for genie-host\'s watchers', () => {
        const mail = new Set<(messages: readonly InboxMessage[]) => void>();
        const inbox = { unread: () => [], receive: async () => [], involving: () => [], onMessagesChanged: (l: (m: readonly InboxMessage[]) => void) => { mail.add(l); return () => { mail.delete(l); }; } };
        const api = hostAloneApi(ports({ inbox }));
        const changed: string[] = [];
        const off = api.localAgents!.onChanged((id) => { changed.push(id); });
        for (const l of [...mail]) l([{ from: 'human', to: atlas.id } as unknown as InboxMessage]);
        off();
        expect(changed).toEqual([atlas.id]);
        expect(mail.size).toBe(0);
    });
});

describe('the wiring', () => {
    it('genie-host retries a paused account; the window’s tray asks it (accountRetry, Tynn #896 2b-3)', () => {
        expect(readFileSync('src/main/host-alone-api.ts', 'utf8')).toMatch(/retryPausedAgents\(/);
        expect(readFileSync('src/main/main.ts', 'utf8')).not.toMatch(/retryPausedAgents\(/);
        expect(readFileSync('src/main/main.ts', 'utf8')).toMatch(/ownProtocol\.call\('accountRetry'/);
    });
});
