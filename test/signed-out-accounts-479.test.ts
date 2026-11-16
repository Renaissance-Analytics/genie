import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/* TYNN #479: the agents a sign-in resumes are the ones signed out ON THAT ACCOUNT (fixtures, no real people). */
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
let dir: string;
let host: SessionHost;
const events = new Map<string, DriverEvents>();
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        events.set(record.name, options.events);
        return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-signed-out-479-'));
    events.clear();
    host = new SessionHost({ userData: dir, driverFor, processTree: noTree });
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});
const onAccount = (name: string, accountId: string): AgentRecord => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name }), accountId });
const signOut = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'auth', reason: 'authentication_failed' } } as never);
const bothSignedOut = () => {
    const a = onAccount('on-a', A), b = onAccount('on-b', B);
    host.start(a, dir); host.start(b, dir);
    host.prompt(a.id, 'go', 'you'); host.prompt(b.id, 'go', 'you');
    signOut('on-a'); signOut('on-b');
    return { a, b };
};

describe('signed-out agents, by account', () => {
    it('two accounts of one provider are signed out: asking for one names that account’s agent only', () => {
        const { a, b } = bothSignedOut();
        expect(host.signedOutAgents('claude', B)).toEqual([b.id]);
        expect(host.signedOutAgents('claude', A)).toEqual([a.id]);
    });
    it('CONTROL: asked for the provider alone, both are named', () => {
        const { a, b } = bothSignedOut();
        expect([...host.signedOutAgents('claude')].sort()).toEqual([a.id, b.id].sort());
    });
});
