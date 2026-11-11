import { describe, expect, it } from 'vitest';
import { RelayHostService, type RelayHostServicePorts } from '../src/main/relay-host-service.js';
import * as reader from '../src/main/workstation-role-reader.js';

/*
 * TYNN ANSWERED, AND THIS SIGN-IN IS NOT BOUND TO THE WORKSTATION (beta.61.1). Tynn's `/workstations/me` answers
 * `role: null` when the calling sign-in is not bound to a workstation: the machine is still a Pilot in Tynn, and Genie,
 * failing closed, showed and treated it as a drone for good. With a workstation on record that answer means "attach
 * again": Genie registers again (with its proof) and reads the role again, and the log says which answer came.
 */
type Outcome = { role: 'pilot' | 'drone' | null; words: string };
const read = (request: unknown) => (reader as unknown as { readWorkstationRoleOutcome(r: unknown): Promise<Outcome> }).readWorkstationRoleOutcome(request);

describe('the role read says which answer came', () => {
    it('null from Tynn is "not bound", told apart from no role in the answer', async () => {
        const answers = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
        expect(await read(answers({ workstation: null, role: null }))).toEqual({ role: null, words: 'null (this sign-in is not bound to a workstation)' });
        expect(await read(answers({ role: 'captain' }))).toEqual({ role: null, words: 'no answer (HTTP 200, no role in it)' });
    });
});

describe('not bound, with a workstation on record', () => {
    it('it registers again by itself, then reads the role again, and is a pilot', async () => {
        let bound = false, ensures = 0;
        let fire: (() => void) | null = null;
        const ports = {
            account: () => ({ host: () => 'https://tynn.test', status: () => ({ signedIn: true }), request: async () => ({}) as never }),
            workstation: {
                identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }),
                // The first registration leaves the sign-in unbound (Tynn kept the identity and said nothing new); the next binds it.
                ensure: async () => { ensures += 1; if (ensures >= 2) bound = true; return { ok: true, status: 'exists', workstationId: 'ws_me' } as never; },
                legacyDone: async () => null,
            },
            enabled: () => false,
            readRole: async () => (bound ? 'pilot' : null),
            start: () => { throw new Error('not started here'); },
            onChange: () => {},
            schedule: (_ms: number, fn: () => void) => { fire = fn; return () => { fire = null; }; },
        } as unknown as RelayHostServicePorts;
        const service = new RelayHostService(ports);
        await service.register();
        expect(service.status().role).toBe('drone');
        expect(ensures).toBe(1);
        const f = fire as (() => void) | null;
        expect(f).not.toBeNull();
        f!();
        for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
        expect(ensures).toBe(2);
        expect(service.status()).toMatchObject({ role: 'pilot', workstation: { registered: true, role: 'pilot' } });
    });
});
