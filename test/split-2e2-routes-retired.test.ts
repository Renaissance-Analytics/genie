import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

/**
 * CLIENT/HOST SPLIT STEP 2e-2 (Tynn #898, story #914): THE ENGINE SERVER'S FEATURE AND DRAFT-FILE ROUTES ARE RETIRED.
 * Since genie#2077 every client reaches features and chat drafts over the one protocol, served by genie-host's RemoteHost;
 * engine.features (snapshot/act/picked/soundData/releaseCaller/invalidate/syncAgentDocs/syncConfig) and
 * engine.drafts.fileOpen/fileRead/fileClose were left for tests only (the coordinator's decision). What main still sent
 * there goes where it belongs: genie-host keeps the workspace agent files itself (host-workspace-files.ts), and invalidates
 * its features on its own sources (the tunnel's browser op among them), so main's 'invalidate' and its
 * `features.invalidated` event go too. engine.featureQuestion stays until 2f (#912).
 */

const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const RETIRED = ['engine.features', 'engine.drafts.fileOpen', 'engine.drafts.fileRead', 'engine.drafts.fileClose'];

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

async function localWindow() {
    const features = { call: vi.fn(async () => ({ answered: true })), presentation: () => null, dropOwner: () => {} };
    const stores = { call: vi.fn(), dump: () => ({}), onEvent: () => () => {}, dropDraftFiles: vi.fn(async () => {}),
        draftFileOpen: vi.fn(async () => null), draftFileRead: vi.fn(async () => ({ base64: '' })), draftFileClose: vi.fn(async () => ({ closed: true })) };
    const server = new SessionEngineServer({ token: 'fixture', build: 'fixture', features: features as never, stores: stores as never });
    const [host, window] = memoryPair();
    server.accept(host, { local: true });
    const client = new SessionEngineClient();
    closers.push(() => window.close());
    expect(await client.connect(window, 'fixture')).toMatchObject({ ok: true });
    return { client, features, stores };
}

describe('the engine server\'s feature and draft-file routes are retired (step 2e-2)', () => {
    it('they are no engine methods', () => {
        expect(RETIRED.filter((m) => (ENGINE_METHODS as readonly string[]).includes(m))).toEqual([]);
    });

    it('a local window that asks for one is answered no, and neither the features nor the stores are asked', async () => {
        const { client, features, stores } = await localWindow();
        for (const method of RETIRED) {
            const answer = await client.call(method as never, method === 'engine.features' ? ['snapshot', [], null, null] : ['ref']);
            expect(answer, method).toMatchObject({ ok: false });
        }
        expect(features.call).not.toHaveBeenCalled();
        expect(stores.draftFileOpen).not.toHaveBeenCalled();
        expect(stores.draftFileRead).not.toHaveBeenCalled();
        expect(stores.draftFileClose).not.toHaveBeenCalled();
    });

    it('CONTROL: the same window\'s question answer still reaches the features (engine.featureQuestion, until 2f)', async () => {
        const { client, features } = await localWindow();
        expect(await client.call('engine.featureQuestion', [{ kind: 'deck.dismiss', id: 'q_1' }])).toMatchObject({ ok: true });
        expect(features.call).toHaveBeenCalledTimes(1);
    });

    it('nothing is left behind them: the server, the stores and the features say none of it', () => {
        const server = code('src/main/session-engine-server.ts');
        expect(server).not.toMatch(/'engine\.features'/);
        expect(server).not.toMatch(/engine\.drafts\.file/);
        expect(server).not.toMatch(/featuresChanged|'features\.invalidated'/);
        expect(code('src/main/session-engine-client.ts')).not.toMatch(/'features\.invalidated'|onFeatureInvalidated/);
        expect(server).not.toMatch(/dropDraftFiles/);
        expect(code('src/main/agent-stores-host.ts')).not.toMatch(/draftFile(Open|Read|Close)|dropDraftFiles/);
        expect(code('src/main/feature-callers.ts')).not.toMatch(/'invalidate'|'soundData'|'syncAgentDocs'|'syncConfig'|'snapshot'|'picked'|'releaseCaller'/);
        expect(code('src/main/genie-host.ts')).not.toMatch(/engine\.featuresChanged\(/);
    });
});

describe('the window sends genie-host nothing for its features (step 2e-2)', () => {
    it('main neither invalidates genie-host\'s features nor writes a workspace\'s agent files', () => {
        const main = code('src/main/main.ts');
        expect(main).not.toMatch(/'engine\.features'/);
        expect(main).not.toMatch(/hostFeatureFiles/);
        expect(main).not.toMatch(/composed\.(syncAgentDocs|syncConfig)\(/);
        expect(code('src/main/compose.ts')).not.toMatch(/hostFeatureFiles/);
        // What stays: the window's browser pane is said down the tunnel, where genie-host invalidates its own features.
        expect(main).toMatch(/windowTunnel\.refreshWindow\(\)/);
        expect(code('src/main/genie-host.ts')).toMatch(/onBrowser: \(connectionId, browser\) => \{ featureCallers\.connectionBrowser\(connectionId, browser\); hostFeatures\?\.invalidate\(\); \}/);
    });

    it('genie-host keeps the workspace agent files itself, once its MCP server has started', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/import \{ syncWorkspaceFiles \} from '\.\/host-workspace-files\.js';/);
        expect(host).toMatch(/mcp\.ready\(\)\.then\(/);
        expect(host).toMatch(/syncWorkspaceFiles\(\{/);
        expect(host).toMatch(/syncAgentDocs: \(path\) => featureFiles\.syncAgentDocs\(path\)/);
        expect(host).toMatch(/syncConfig: \(path\) => featureConfig\(path\)/);
        // One registry for the list, the follow and the Tynn link: phoneRegistry.
        expect(host).toMatch(/workspaces: \(\) => phoneRegistry\.listWorkspaces\(\)/);
        expect(host).toMatch(/tynnProject: \(workspaceId\) => \{ const w = phoneRegistry\.workspace\(workspaceId\); return w \? tynnProjectOf\(w\.path\) : null; \}/);
    });
});
