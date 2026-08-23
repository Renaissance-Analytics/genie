import { describe, expect, it } from 'vitest';
import {
    SERVICE_PORT_RANGE,
    preferredServicePort,
    planServicePorts,
} from '../service-ports';

/**
 * A workspace's database must answer on the SAME port tomorrow.
 *
 * Genie asked the runtime for `HostPort: ""` — "anything free" — so Docker picked
 * a new number every time the container was created, and a Genie restart is one of
 * the things that creates one. The `.env` writer (genie#242) then chased that
 * moving number, which is treating the symptom: five agents in one week still hit
 * `.env` saying 51157 while Postgres answered on 58377, because between the move
 * and the rewrite everything pointed at a dead socket.
 *
 * The fix is for the number not to move. These are the rules it moves by.
 */
const free = async () => true;
const taken = async () => false;

describe('preferredServicePort', () => {
    it('is DERIVED — the same engine and surface always want the same port', () => {
        const a = preferredServicePort('postgres-16', 'sql');
        const b = preferredServicePort('postgres-16', 'sql');
        expect(a).toBe(b);
        // Nothing is stored to make that true, so it survives a reinstall.
        expect(a).toBeGreaterThanOrEqual(SERVICE_PORT_RANGE.min);
        expect(a).toBeLessThanOrEqual(SERVICE_PORT_RANGE.max);
    });

    it('separates engines, versions, owners and surfaces', () => {
        const ports = new Set([
            preferredServicePort('postgres-16', 'sql'),
            preferredServicePort('postgres-17', 'sql'),
            preferredServicePort('postgres-16@ws-a', 'sql'),
            preferredServicePort('postgres-16@ws-b', 'sql'),
            preferredServicePort('minio-latest', 'api'),
            preferredServicePort('minio-latest', 'console'),
        ]);
        expect(ports.size).toBe(6);
    });

    it('stays OUT of the ephemeral range the OS hands to outbound connections', () => {
        // A fixed port up there gets stolen by an unrelated process and the failure
        // looks like Genie's. Same reasoning as the site forwards in exposure.ts.
        expect(SERVICE_PORT_RANGE.min).toBeGreaterThanOrEqual(30000);
        expect(SERVICE_PORT_RANGE.max).toBeLessThan(49152);
    });

    it('does not overlap the site-forward range', () => {
        expect(SERVICE_PORT_RANGE.min).toBeGreaterThan(29999);
    });
});

describe('planServicePorts', () => {
    const sql = [{ name: 'sql', container: 5432 }];

    it('asks for the DERIVED port when nothing is reserved yet', async () => {
        const plan = await planServicePorts({
            recordKey: 'postgres-16',
            ports: sql,
            reserved: {},
            isFree: free,
        });
        expect(plan.assignments).toEqual([
            { name: 'sql', container: 5432, host: preferredServicePort('postgres-16', 'sql') },
        ]);
        expect(plan.notes).toEqual([]);
    });

    it('RE-REQUESTS the port it was given last time, even if the derivation moved', async () => {
        // The whole point: allocate once, then keep asking for the same number.
        const plan = await planServicePorts({
            recordKey: 'postgres-16',
            ports: sql,
            reserved: { sql: 34567 },
            isFree: free,
        });
        expect(plan.assignments[0].host).toBe(34567);
    });

    it('is STABLE across repeated planning — the same input, the same answer', async () => {
        const once = await planServicePorts({ recordKey: 'r', ports: sql, reserved: {}, isFree: free });
        const twice = await planServicePorts({
            recordKey: 'r',
            ports: sql,
            reserved: Object.fromEntries(once.assignments.map((a) => [a.name, a.host as number])),
            isFree: free,
        });
        expect(twice.assignments).toEqual(once.assignments);
        expect(twice.notes).toEqual([]);
    });

    it('falls back to a DIFFERENT port when the one it wants is genuinely taken', async () => {
        const want = preferredServicePort('postgres-16', 'sql');
        const plan = await planServicePorts({
            recordKey: 'postgres-16',
            ports: sql,
            reserved: {},
            isFree: async (p) => p !== want,
        });
        expect(plan.assignments[0].host).not.toBe(want);
        expect(plan.assignments[0].host).toBeGreaterThanOrEqual(SERVICE_PORT_RANGE.min);
    });

    it('says so OUT LOUD when it had to move', async () => {
        // A silent fallback is how a stable port quietly stops being stable.
        const want = preferredServicePort('postgres-16', 'sql');
        const plan = await planServicePorts({
            recordKey: 'postgres-16',
            ports: sql,
            reserved: {},
            isFree: async (p) => p !== want,
        });
        expect(plan.notes).toHaveLength(1);
        expect(plan.notes[0]).toContain(String(want));
        expect(plan.notes[0]).toContain(String(plan.assignments[0].host));
    });

    it('picks the SAME fallback each time the same port is blocked', async () => {
        const want = preferredServicePort('postgres-16', 'sql');
        const isFree = async (p: number) => p !== want;
        const a = await planServicePorts({ recordKey: 'postgres-16', ports: sql, reserved: {}, isFree });
        const b = await planServicePorts({ recordKey: 'postgres-16', ports: sql, reserved: {}, isFree });
        expect(b.assignments[0].host).toBe(a.assignments[0].host);
    });

    it('never hands the same host port to two surfaces of one engine', async () => {
        const plan = await planServicePorts({
            recordKey: 'minio-latest',
            ports: [
                { name: 'api', container: 9000 },
                { name: 'console', container: 9001 },
            ],
            // Everything free, but both surfaces reserved onto ONE number.
            reserved: { api: 34000, console: 34000 },
            isFree: free,
        });
        const hosts = plan.assignments.map((a) => a.host);
        expect(new Set(hosts).size).toBe(2);
    });

    it('gives up gracefully — ephemeral, and LOUDLY — when nothing in the range is free', async () => {
        const plan = await planServicePorts({
            recordKey: 'postgres-16',
            ports: sql,
            reserved: {},
            isFree: taken,
        });
        // `host` absent means "let the runtime choose": the engine still comes up.
        expect(plan.assignments[0].host).toBeUndefined();
        expect(plan.notes.join(' ')).toMatch(/ephemeral|move/i);
    });

    it('probes a BOUNDED number of ports rather than sweeping ten thousand', async () => {
        let asked = 0;
        await planServicePorts({
            recordKey: 'postgres-16',
            ports: sql,
            reserved: {},
            isFree: async () => {
                asked += 1;
                return false;
            },
        });
        expect(asked).toBeLessThanOrEqual(64);
    });

    it('plans nothing for an engine that publishes nothing', async () => {
        const plan = await planServicePorts({ recordKey: 'r', ports: [], reserved: {}, isFree: free });
        expect(plan.assignments).toEqual([]);
        expect(plan.notes).toEqual([]);
    });
});
