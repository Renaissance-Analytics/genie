import { describe, expect, it } from 'vitest';
import { RelayHostService, type RelayHostServicePorts } from '../src/main/relay-host-service.js';
import { readWorkstationRoleOutcome } from '../src/main/workstation-role-reader.js';

/*
 * THE ROLE READ CALLS THE ACCOUNT AS AN OBJECT (beta.61.2). The real Tynn account keeps its credential in a private field
 * and its `request` is a class method. genie-host handed `account.request` on by itself, so every role read threw
 * "Cannot read properties of undefined (reading '#credential')" (the owner's genie-host.log, 2026-11-12), was taken as
 * "no answer", and a Pilot read as a drone. The tests before this used plain objects with arrow functions, which have
 * no `this` to lose. This account is shaped like the real one.
 */

class PrivateFieldAccount {
    readonly #credential = 'token';
    host(): string { return 'https://tynn.test'; }
    status(): { signedIn: boolean } { return { signedIn: true }; }
    async request(path: string, _init: { method: 'GET' | 'POST'; body?: unknown }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
        if (!this.#credential) throw new Error('no credential');
        return { ok: true, status: 200, json: async () => (path === '/api/v1/workstations/me' ? { role: 'pilot', workstation: { id: 'ws_me' } } : {}) };
    }
}

function ports(account: PrivateFieldAccount): RelayHostServicePorts {
    return {
        account: () => account as never,
        workstation: {
            identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }),
            ensure: async () => ({ ok: true, workstationId: 'ws_me' }) as never,
            legacyDone: async () => null,
        },
        enabled: () => false,
        readRole: async (request) => (await readWorkstationRoleOutcome(request)).role,
        start: () => ({ status: () => ({ state: 'off' }) as never, stop: () => {}, revalidate: async () => {} }),
        onChange: () => {},
    };
}

describe('the role read, against an account whose request is a class method with a private credential', () => {
    it('reads Tynn\'s answer: a Pilot is a pilot, never a drone for a lost `this`', async () => {
        const service = new RelayHostService(ports(new PrivateFieldAccount()));
        await service.readRole();
        expect(service.said()).toBe('pilot');
        expect(service.role()).toBe('pilot');
    });

    it('CONTROL: the same account\'s request, detached from it, fails the way the owner\'s log shows', async () => {
        const account = new PrivateFieldAccount();
        const detached = account.request;
        await expect(detached('/api/v1/workstations/me', { method: 'GET' })).rejects.toThrow(/credential/);
    });
});
