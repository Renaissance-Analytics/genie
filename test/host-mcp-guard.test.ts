import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * GENIE'S MCP SERVER AND ITS STORES ARE GENIE-HOST'S (the host split, P3.1: plan §11d), held by the source. The behaviour
 * is proven by agent-stores-contract, mcp-host-tools and the real-host test in genie-host-process; these hold the wiring
 * so a window cannot quietly go back to owning them.
 */

const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('the window', () => {
    const main = code('src/main/main.ts');

    it('builds no MCP server of its own: genie-host serves it (Tynn #415)', () => {
        expect(main).not.toMatch(/genieMcpServer\(/);
        expect(main).toMatch(/hostMcpEndpoint = status\?\.endpoint \?\? null/);
    });

    it('never reaches the stores agents write to when genie-host owns them: its tools get hostOnly stand-ins', () => {
        expect(main).toMatch(/inbox: hostOnly</);
        expect(main).toMatch(/attention: hostOnly</);
        expect(main).toMatch(/knowledge: hostOnly</);
    });

    it('composes nothing: the stores, flows, supervisor and sites are genie-host\'s, read over the protocol (Tynn #955)', () => {
        expect(main).not.toContain('composeWindowServices');
        expect(main).not.toMatch(/engineForStores|agentStores:/);
        // The workspace agent files are genie-host's to keep (Tynn #898 step 2e-2): main sends it nothing for them.
        expect(main).not.toContain("'engine.features'");
    });
});

describe('compose', () => {
    it('opens the stores only when it was given none', () => {
        const compose = code('src/main/compose.ts');
        expect(compose).toMatch(/if \(!input\.agentStores\) \{\s*ownStores = await input\.alone!\.openStores\(/);
        expect(compose).not.toMatch(/InboxStore\.open\(/);
    });
});

describe('the settings and the chat drafts are genie-host\'s (P3.2)', () => {
    it('compose opens the settings only when it was given none; genie-host opens them and the drafts; the window\'s drafts are the host\'s', () => {
        expect(code('src/main/compose.ts')).toMatch(/if \(!input\.agentStores\?\.settings\) \{\s*ownSettings = await input\.alone!\.openSettings\(/);
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/await SettingsStore\.open\(home\)/);
        expect(host).toMatch(/await ChatDraftStore\.open\(home\)/);
        expect(code('src/main/main.ts')).not.toMatch(/stores\(\)\.drafts/);
    });
});

describe('the registry\'s files and the mail wake are genie-host\'s (P3.2)', () => {
    it('the window\'s registry reads and writes through the host, and re-reads when another wrote', () => {
        const main = code('src/main/main.ts');
        // Over the one protocol since 2g-4e (Tynn #1007; test/split-2g4e-registry.test.ts), not the engine link's replicas.
        expect(main).toMatch(/theRegistry\.useStore\(await openWindowRegistryStore\(ownProtocol\)\)/);
        // The registry's own watch drives the owned watcher; its behavior is exercised in registry-refresh-636.test.ts.
        expect(main).toContain("import { watchRegistryRefresh } from './registry-refresh.js';");
        expect(main).toMatch(/watchRegistryRefresh\(registryChanges\(ownProtocol\), theRegistry, \(error\) => console\.error\('\[registry\] Background refresh failed; waiting for the next host update\.', error\)\)/);
    });

    it('the mail wake runs in the host; the window has none (its own was deleted in P6-4, Tynn #1036)', () => {
        expect(code('src/main/genie-host.ts')).toMatch(/wireHostMailWake\(\{/);
        expect(code('src/main/main.ts')).not.toMatch(/wireInboxPush\(/);
    });
});

describe('the process supervisor is genie-host\'s (P3.3b)', () => {
    it('the host runs it on its own `supervised` child; a window drives it through its replica; compose builds one only with none given', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/new ProcessSupervisor\(\s*supervisedClient\.ptyPort\(\)/);
        // No window sends into the host's own children: a window's engine.spawn reaches `processes` only (since P3.3e).
        expect(host).toMatch(/if \(profile === 'processes'\) relay\?\.send\('processes', frame\);/);
        // A window drives it over the protocol (features.act); main hands compose no supervisor, and composes nothing (Tynn #955).
        expect(code('src/main/main.ts')).not.toMatch(/supervisor: agentEngineLink|\.supervisor\(\)/);
        // It adopts no pty a window listed (Tynn #1043): a composition that runs alone builds its own, and that is all.
        expect(code('src/main/compose.ts')).toMatch(/if \(input\.supervisor\) supervisor = input\.supervisor;\s*else supervisor = input\.alone!\.supervisor\(\);/);
    });
});

describe('the process book and its scheduler are genie-host\'s (P3.3c)', () => {
    it('the host opens the book and runs the scheduler; the window holds no replica of it (Tynn #953, 2g-2)', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/await ProcessBook\.open\(home,/);
        expect(host).toMatch(/new ProcessScheduler\(\{/);
        expect(code('src/main/main.ts')).not.toMatch(/client\.processBook\(\)/);
    });
});

describe('flows are genie-host\'s (P3.3d)', () => {
    it('the host opens the flows and runs their engine; a window has none, and compose starts its own only for the tests\' composition', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/await FlowStore\.open\(home\)/);
        expect(host).toMatch(/startFlowsEngine\(\{/);
        // The window has no flows of its own to hand, and composes nothing (Tynn #955).
        expect(code('src/main/main.ts')).not.toMatch(/flowsEngine:/);
        expect(code('src/main/compose.ts')).toMatch(/const ownEngine = ownFlows \? input\.alone!\.startFlows\(\{/);
    });
});

describe('the terminals are genie-host\'s (P3.3e)', () => {
    it('the host runs them on its own `terminals` child; no window sends into it; main holds no replica (Tynn #953, 2g-2)', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/new TerminalHost\(terminalsClient\.ptyPort\(\)/);
        expect(host).toMatch(/send: \(profile, frame\) => \{ if \(profile === 'processes'\) relay\?\.send\('processes', frame\); \}/);
        expect(code('src/main/main.ts')).not.toMatch(/client\.terminals\(\)/);
    });
});

describe('genie-host', () => {
    it('opens the stores, serves them, and starts Genie\'s MCP server', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/await openAgentStores\(home/);
        expect(host).toMatch(/new AgentStoresService\(/);
        expect(host).toMatch(/startHostMcp\(\{/);
    });
});
