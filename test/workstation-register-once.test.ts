import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateHostKeypair, workstationKeyStore } from '../src/main/workstation-identity.js';
import { WorkstationService } from '../src/main/workstation-service.js';
import { fakeKeychain } from './helpers/tynn-storage.js';

/*
 * A PROOF IS NEVER SENT TWICE, AND EACH REGISTRATION IS SAID (beta.61.1). Tynn takes a re-attach proof once: a second request
 * carrying the same signature is not proved, and the same machine registering unproven is made a drone. The proof signs the
 * workstation and a time in whole seconds, so two registrations in one second were the same proof. Registrations run one at
 * a time, no two proofs share a timestamp, and genie-host's lifecycle log says what each one sent and what Tynn answered.
 */
const HOST = 'https://tynn.test';
let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ws-once-')); file = join(dir, 'workstation.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

type Body = { proof?: { ts: number; sig: string } };
function rig(selfRegister: (body: Body) => { status: number; body: unknown }, stored = true) {
    const pair = generateHostKeypair();
    const order: string[] = [];
    const bodies: Body[] = [];
    const lines: string[] = [];
    const request = (async (path: string, init: { body?: unknown }) => {
        const answer = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
        order.push(`start ${path}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${path}`);
        if (path === '/api/v1/workstations/me') return answer(200, { workstation: null });
        if (path === '/api/v1/workstations/self-register') { bodies.push(init.body as Body); const a = selfRegister(init.body as Body); return answer(a.status, a.body); }
        if (path.endsWith('/enroll')) return answer(200, { enrolled: true });
        return answer(404, {});
    }) as never;
    const make = async () => {
        if (stored) await writeFile(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1' } }));
        const store = workstationKeyStore(file, fakeKeychain(stored ? { [`workstation/${HOST}`]: pair.privateKeyPem } : {}));
        return new (WorkstationService as unknown as new (o: object) => WorkstationService)({ store, request, host: () => HOST, hostname: () => 'box', machineKey: async () => null, now: () => 1_800_000_000_123, log: (line: string) => lines.push(line) });
    };
    return { make, order, bodies, lines };
}
const kept = () => ({ status: 200, body: { workstation: { id: 'ws_1' }, enrollment: null } });

describe('registrations run one at a time, and no two proofs are the same', () => {
    it('two at the same instant: the second starts after the first ended, and their proofs differ', async () => {
        const r = rig(kept);
        const service = await r.make();
        await Promise.all([service.ensure({ host: HOST }), service.ensure({ host: HOST })]);
        expect(r.bodies).toHaveLength(2);
        expect(r.bodies[0]!.proof!.ts).not.toBe(r.bodies[1]!.proof!.ts);
        expect(r.bodies[0]!.proof!.sig).not.toBe(r.bodies[1]!.proof!.sig);
        // One at a time: the first's self-register ends before the second's first request starts.
        const firstEnd = r.order.indexOf('end /api/v1/workstations/self-register');
        const secondStart = r.order.indexOf('start /api/v1/workstations/me', 1);
        expect(firstEnd).toBeGreaterThan(-1);
        expect(secondStart).toBeGreaterThan(firstEnd);
    });
});

describe('each registration is said', () => {
    it('proved: sent with its proof, and Tynn kept the record', async () => {
        const r = rig(kept);
        await (await r.make()).ensure({ host: HOST });
        expect(r.lines).toEqual([expect.stringMatching(/^tynn registration: proved \(ws_1\); Tynn answered HTTP 200, workstation ws_1, no new enrollment$/)]);
    });
    it('refused: Tynn\'s answer', async () => {
        const r = rig(() => ({ status: 422, body: { message: 'no' } }));
        await (await r.make()).ensure({ host: HOST }).catch(() => {});
        expect(r.lines).toEqual([expect.stringMatching(/^tynn registration: proved \(ws_1\); Tynn refused it, HTTP 422$/)]);
    });
    // tynn.ai#450: a proof that fails against a record the owner has is refused with 422 `proof_rejected` and a `reason`.
    it('a rejected proof: the log carries Tynn\'s code and reason, and the caller still gets Tynn\'s words', async () => {
        const r = rig(() => ({ status: 422, body: { message: 'This proof was not accepted.', code: 'proof_rejected', reason: 'replayed' } }));
        const result = await (await r.make()).ensure({ host: HOST }).catch((e: unknown) => ({ ok: false, reason: String(e) }));
        expect(r.lines).toEqual([expect.stringMatching(/^tynn registration: proved [(]ws_1[)]; Tynn refused it, HTTP 422 proof_rejected: replayed$/)]);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('This proof was not accepted.') });
    });
    it('unproven: only a machine with nothing on record, and it says so', async () => {
        const r = rig(() => ({ status: 201, body: { workstation: { id: 'ws_new' }, enrollment: { workstation_id: 'ws_new', secret: 's' } } }), false);
        await (await r.make()).ensure({ host: HOST });
        expect(r.lines).toEqual([expect.stringMatching(/^tynn registration: unproven \(nothing on record\); Tynn answered HTTP 201, workstation ws_new, a new enrollment$/)]);
    });
    it('genie-host writes them to its lifecycle log', () => {
        expect(readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8')).toMatch(/log: \(line\) => say\(line\)/);
    });
});
