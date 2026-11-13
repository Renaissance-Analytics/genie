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

    it('composes against genie-host\'s stores (replicas) when it runs', () => {
        expect(main).toMatch(/composeWindowServices\(\{ \.\.\.input, agentStores: engineForStores\.client\.stores\(\) \}\)/);
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
        expect(code('src/main/main.ts')).toMatch(/const drafts = agentEngineLink\.client\.stores\(\)\.drafts;/);
    });
});

describe('the registry\'s files and the mail wake are genie-host\'s (P3.2)', () => {
    it('the window\'s registry reads and writes through the host, and re-reads when another wrote', () => {
        const main = code('src/main/main.ts');
        expect(main).toMatch(/theRegistry\.useStore\(new HostRegistryStore\(engineLink\.stores\(\)\)\)/);
        // The same host replica drives the owned watcher; its behavior is exercised in registry-refresh-636.test.ts.
        expect(main).toContain("import { watchRegistryRefresh } from './registry-refresh.js';");
        expect(main).toMatch(/watchRegistryRefresh\(engineLink\.stores\(\), theRegistry, \(error\) => console\.error\('\[registry\] Background refresh failed; waiting for the next host update\.', error\)\)/);
    });

    it('the mail wake runs in the host; the window\'s own only on the emergency path', () => {
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
        expect(code('src/main/main.ts')).toMatch(/supervisor: agentEngineLink\.client\.supervisor\(\)/);
        expect(code('src/main/compose.ts')).toMatch(/if \(input\.supervisor\) supervisor = input\.supervisor;\s*else \{\s*const own = input\.alone!\.supervisor\(\)/);
    });
});

describe('the process book and its scheduler are genie-host\'s (P3.3c)', () => {
    it('the host opens the book and runs the scheduler; a window with a host uses the replica, its own only on the emergency path', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/await ProcessBook\.open\(home,/);
        expect(host).toMatch(/new ProcessScheduler\(\{/);
        expect(code('src/main/main.ts')).toMatch(/processBook = agentEngineLink\.client\.processBook\(\);/);
    });
});

describe('flows are genie-host\'s (P3.3d)', () => {
    it('the host opens the flows and runs their engine; a window with a host uses the replica, its own engine only on the emergency path', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/await FlowStore\.open\(home\)/);
        expect(host).toMatch(/startFlowsEngine\(\{/);
        expect(code('src/main/main.ts')).toMatch(/flowsEngine: \{ flows: agentEngineLink\.client\.flows\(\), scheduler: agentEngineLink\.client\.flows\(\) \}/);
        expect(code('src/main/compose.ts')).toMatch(/const ownEngine = ownFlows \? input\.alone!\.startFlows\(\{/);
    });
});

describe('the terminals are genie-host\'s (P3.3e)', () => {
    it('the host runs them on its own `terminals` child; no window sends into it; a window with a host drives them by replica', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/new TerminalHost\(terminalsClient\.ptyPort\(\)/);
        expect(host).toMatch(/send: \(profile, frame\) => \{ if \(profile === 'processes'\) relay\?\.send\('processes', frame\); \}/);
        expect(code('src/main/main.ts')).toMatch(/terminals = agentEngineLink\.client\.terminals\(\);/);
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
