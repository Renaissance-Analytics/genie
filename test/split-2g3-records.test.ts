import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-3, RECORDS (Tynn #898, story #954; part of #913). genie-host's SessionHost read each agent's
 * record per call (genie#1188) from what main pushed over its engine link (`engine.records`, `recordsChanged`). The records
 * are genie-host's own: its registry is the roster. So the host reads its registry, the engine link carries no records, and
 * main pushes nothing.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

describe('genie-host reads its own registry for an agent’s record', () => {
    it('its SessionHost’s currentRecord is the host registry’s', () => {
        expect(code(src('src/main/genie-host.ts'))).toMatch(/currentRecord: \(id\) => hostRegistry\.find\(id as AgentId\) \?\? null,/);
    });

    it('the engine server offers no pushed record: no currentRecord among its host options, no records() view', () => {
        const server = new SessionEngineServer({ token: 'a'.repeat(64), build: 'test' });
        expect(Object.keys(server.hostOptions())).not.toContain('currentRecord');
        expect((server as unknown as { records?: unknown }).records).toBeUndefined();
    });

    it('the engine link carries no records: no engine.records, no recordsChanged', () => {
        expect(ENGINE_METHODS as readonly string[]).not.toContain('engine.records');
        expect(code(src('src/main/session-engine-server.ts'))).not.toContain("'engine.records'");
        expect(code(src('src/main/session-engine-client.ts'))).not.toMatch(/recordsChanged|'engine\.records'/);
    });

    it('main pushes nothing: no recordsChanged, no records port on its engine link, and the row leaves both lists', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).not.toMatch(/recordsChanged/);
        expect(main).not.toMatch(/records: \(\) => registry\?\.listAgents\(\)/);
        expect(code(src('src/main/agent-engine.ts'))).not.toMatch(/readonly records:/);
        expect(WINDOW_ENGINE_INVENTORY.map(([u]) => u)).not.toContain('recordsChanged');
        expect(src('test/split-2e-window-guard.test.ts')).not.toMatch(/recordsChanged: '2g'/);
    });
});
