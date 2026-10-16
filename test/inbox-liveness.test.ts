import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type GenieToolsDeps } from '../src/main/mcp-tools.js';

/**
 * AGENTINBOX LIST SAYS WHO IS RUNNING (a friction report from the impactopia agent, sent for the owner, 2026-10-14:
 * asked "is your slave running?", it could not say — `reachable` is permission, no terminal showed the sidecar, and the
 * one probe, `runAgent`, STARTS it). Each peer now carries `state` (working / idle / failed / stopped) and `lastSeen`,
 * read-only: asking never starts anyone.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-liveness-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const me = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'impactium' });
const slave = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'impactium-slave' });
const busy = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'kai' });
const roster: AgentRecord[] = [me, slave, busy];

async function list(liveness: GenieToolsDeps['liveness']) {
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    const started: string[] = [];
    const tools = genieTools({
        inbox, attention, roster: () => roster,
        resolveCaller: (key) => (key === 'me' ? { agentId: me.id, agentName: me.name, workspaceId: 'ws', workspacePath: dir } : null),
        workspaceSetting: () => ({ scope: 'self' }),
        userActive: () => true, glow: () => true, thumbsUp: () => {},
        ...(liveness ? { liveness: (id: string) => { started.push(`asked ${id}`); return liveness(id); } } : {}),
    } as GenieToolsDeps);
    const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
    const r = await reg.handler({ terminalId: 'me', action: 'list' } as never, { server: 'genie', tool: 'agentinbox', headers: {} });
    return { peers: (JSON.parse(r.text) as { peers: Array<Record<string, unknown>> }).peers, started };
}

describe('agentinbox list', () => {
    it('gives each peer its state and lastSeen beside reachable — a stopped sidecar reads stopped', async () => {
        const { peers } = await list((id) => (id === busy.id ? { state: 'working', lastSeen: '2026-10-14T21:00:00.000Z' } : { state: 'stopped', lastSeen: null }));
        const by = Object.fromEntries(peers.map((p) => [p.name as string, p]));
        // COUNTED: both peers carry a state; the sidecar is stopped, kai is working.
        expect(peers.filter((p) => typeof p.state === 'string')).toHaveLength(2);
        expect(by['impactium-slave']).toMatchObject({ reachable: true, state: 'stopped', lastSeen: null });
        expect(by.kai).toMatchObject({ state: 'working', lastSeen: '2026-10-14T21:00:00.000Z' });
    });

    it('the tool says what each field means: reachable is permission, state is liveness, and asking starts nobody', async () => {
        const reg = genieTools({} as GenieToolsDeps).find((t) => t.definition.name === 'agentinbox')!;
        const description = (reg.definition as unknown as { description: string }).description;
        expect(description).toMatch(/whether each is running/);
        expect(description).toMatch(/never starts/);
    });
});

describe('main wires it', () => {
    it('the tools get the session host’s liveness', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        expect(main.match(/liveness:\s*\(id\)\s*=>\s*livenessOf\(host\?\.probe\(/g) ?? []).toHaveLength(1);
    });
});
