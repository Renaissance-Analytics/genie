import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/*
 * TYNN #479, corrected by #751 (Accounts R1): every agent of a provider runs on its ONE active account, so the agents a
 * sign-in resumes are the signed-out agents of the ACTIVE account; signing another account in resumes nobody (nothing runs on
 * it). Fixtures, no real people.
 */
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const active: AccountRecord = { id: A, provider: 'claude', legacy: false, labelEdited: false, label: 'Account A', home: '/genie/accounts/claude/a',
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-16T00:00:00Z' };
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
    host = new SessionHost({ userData: dir, driverFor, processTree: noTree, activeAccount: () => active });
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});
const agent = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name });
const signOut = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'auth', reason: 'authentication_failed' } } as never);
const bothSignedOut = () => {
    const one = agent('one'), two = agent('two');
    host.start(one, dir); host.start(two, dir);
    host.prompt(one.id, 'go', 'you'); host.prompt(two.id, 'go', 'you');
    signOut('one'); signOut('two');
    return { one, two };
};

describe('signed-out agents, by the active account', () => {
    it('the active account’s sign-in names every signed-out agent of the provider', () => {
        const { one, two } = bothSignedOut();
        expect([...host.signedOutAgents('claude', A)].sort()).toEqual([one.id, two.id].sort());
    });
    it('another account’s sign-in names nobody: no agent runs on it', () => {
        bothSignedOut();
        expect(host.signedOutAgents('claude', B)).toEqual([]);
    });
    it('CONTROL: asked for the provider alone, both are named', () => {
        const { one, two } = bothSignedOut();
        expect([...host.signedOutAgents('claude')].sort()).toEqual([one.id, two.id].sort());
    });
});
