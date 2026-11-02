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

    it('builds its own MCP server ONLY when there is no genie-host (the emergency path)', () => {
        expect(main).toMatch(/if \(!engineLink\) mcp = genieMcpServer\(/);
        expect(main.match(/genieMcpServer\(/g)).toHaveLength(1);
    });

    it('never reaches the stores agents write to when genie-host owns them: its tools get hostOnly stand-ins', () => {
        expect(main).toMatch(/inbox: own\?\.inbox \?\? hostOnly</);
        expect(main).toMatch(/attention: own\?\.attention \?\? hostOnly</);
        expect(main).toMatch(/knowledge: own\?\.knowledge \?\? hostOnly</);
    });

    it('composes against genie-host\'s stores (replicas) when it runs', () => {
        expect(main).toMatch(/composeWindowServices\(\{ \.\.\.input, agentStores: engineForStores\.client\.stores\(\) \}\)/);
    });
});

describe('compose', () => {
    it('opens the stores only when it was given none', () => {
        const compose = code('src/main/compose.ts');
        expect(compose).toMatch(/if \(!input\.agentStores\) \{\s*ownStores = await openAgentStores\(/);
        expect(compose).not.toMatch(/InboxStore\.open\(/);
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
