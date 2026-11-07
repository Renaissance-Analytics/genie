import type { AgentSecrets } from './tynn-agent-identities.js';
import type { Comparison, HostVault } from './keychain-migration.js';
import type { KeychainRead, KeychainResult } from './keychain.js';
import type { SessionEngineClient } from './session-engine-client.js';

/**
 * THE HOST'S KEYCHAIN, FROM THE WINDOW (P3.4, genie#1457). The host holds an agent's key, the window mints it until cut c
 * gives the host the account. A link that is down answers `unavailable`, the same as a keychain that does not answer: it is
 * never "this agent has no key", which would read as a reason to mint another.
 */
type Link = Pick<SessionEngineClient, 'call'>;

export function linkedAgentSecrets(client: Link): AgentSecrets {
    return {
        probe: async () => {
            const reply = await client.call('engine.secretProbe', []);
            return reply.ok ? (reply.value as KeychainResult) : { ok: false, reason: reply.reason };
        },
        get: async (name) => {
            const reply = await client.call('engine.secretRead', [name]);
            return reply.ok ? (reply.value as KeychainRead) : { kind: 'unavailable', reason: reply.reason };
        },
        set: async (name, value) => {
            const reply = await client.call('engine.secretStore', [name, value]);
            return reply.ok ? (reply.value as KeychainResult) : { ok: false, reason: reply.reason };
        },
    };
}

/** The migration's half of the same link: the host reads back and answers in one word. */
export function linkedVault(client: Link): HostVault {
    const secrets = linkedAgentSecrets(client);
    return {
        store: (name, value) => secrets.set(name, value),
        compare: async (name, value) => {
            const reply = await client.call('engine.secretCompare', [name, value]);
            return reply.ok ? (reply.value as Comparison) : 'unavailable';
        },
    };
}
