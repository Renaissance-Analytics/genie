import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { serviceEnvDriverOptions, SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * AN AGENT STARTS WITH ITS WORKSPACE'S SERVICE VARIABLES — AND NOTHING ELSE GENIE HOLDS (the owner, 2026-10-16: "env +
 * services exec … ONLY let through Genie-managed service. DO NOT EXPOSE KEYS and other data agents should not be
 * reading"). moic's own shell had no DB_*; terminals and sites did. Now the session is started with the workspace's
 * managed-service variables, passed to the provider through prism-acp's ALLOW-LIST (parentEnv + allowEnv →
 * `childEnv`): exactly those names reach the agent, so a token in Genie's own environment never does. A change after
 * the start reaches the agent through `services exec` (the current values) or its next start. Values invented.
 */

const SERVICE_ENV = { DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: '4120', DB_DATABASE: 'example', DB_USERNAME: 'genie', DB_PASSWORD: 'pw-example-123' };

describe('the provider options', () => {
    it('pass the service variables and allow exactly their names; no service env, no options', () => {
        const options = serviceEnvDriverOptions(SERVICE_ENV);
        expect([...(options.allowEnv ?? [])].sort()).toEqual(Object.keys(SERVICE_ENV).sort());
        expect(options.parentEnv).toMatchObject(SERVICE_ENV);
        expect(serviceEnvDriverOptions({})).toEqual({});
    });

    it("through prism-acp's own allow-list the agent gets those variables — and no token Genie's environment holds (CONTROL: a base variable still passes)", () => {
        const options = serviceEnvDriverOptions(SERVICE_ENV);
        const parent = { ...options.parentEnv, GENIE_TYNN_TOKEN: 'tynn-secret-example', GITHUB_TOKEN: 'gh-secret-example', GENIE_RELEASE_TOKEN: 'rel-secret-example', PATH: '/usr/bin' };
        const { env } = childEnv(parent, { allow: options.allowEnv ?? [] });
        expect(env).toMatchObject(SERVICE_ENV);
        expect(Object.keys(env).filter((k) => /TOKEN/.test(k))).toEqual([]);
        expect(env.PATH).toBe('/usr/bin');
    });
});

describe('SessionHost', () => {
    const noProcessTree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-agent-env-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it("starts an agent with ITS workspace's current service variables (CONTROL: another workspace's agent gets its own, none)", () => {
        const seen: Record<string, Readonly<Record<string, string>> | undefined> = {};
        const driverFor: DriverFor = (record, _cwd, _resume, extras) => {
            seen[record.workspaceId] = extras?.serviceEnv;
            const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null }) as never;
            return factory;
        };
        const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree, serviceEnvFor: (ws) => (ws === 'example' ? SERVICE_ENV : {}) });
        expect(host.start(agentRecord({ id: mintAgentId(), workspaceId: 'example', provider: 'claude', name: 'atlas' }), dir)).toEqual({ ok: true });
        expect(host.start(agentRecord({ id: mintAgentId(), workspaceId: 'example-other', provider: 'claude', name: 'vega' }), dir)).toEqual({ ok: true });
        expect(seen.example).toEqual(SERVICE_ENV);
        expect(seen['example-other']).toEqual({});
        host.stopAll();
    });
});
