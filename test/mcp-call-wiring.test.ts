import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CALL REACHES THE REAL QUEUE (genie#1360). Every tool hands its MCP call to `approve`, and the type makes that
 * argument required at every call site — but a lambda with FEWER parameters still satisfies the type, so the one that
 * matters, main.ts's binding of `approve` to the real approval queue, could drop the call and every approval would
 * outlive its disconnected client again while every unit test stayed green. A source guard, comment lines stripped.
 */
const code = (file: string): string => readFileSync(join(__dirname, '..', 'src', 'main', file), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('the MCP call reaches the approval queue (genie#1360)', () => {
    it('main.ts binds approve to the queue WITH the call', () => {
        // The window's gate is approvalsNow's since Tynn #1006 (2g-4b2): genie-host's queue over main's own client.
        const gates = [...code('main.ts').matchAll(/approvalsNow\.gate\(([^)]*)\)/g)].map((m) => m[1]!.split(',').map((a) => a.trim()));
        expect(gates.length).toBeGreaterThan(0);
        for (const args of gates) expect(args).toHaveLength(4);
        // genie-host's queue, through the replica, ties it to the agent's real call by its forwarded id (the host split, P3.1).
        // Since Tynn #1006 (2g-4b2) over main's own client, to genie-host's one queue, still WITH the call (approvals-gate-protocol.ts).
        expect(code('main.ts')).toMatch(/approve: \(caller, action, detail, call\) => approvalsNow\.gate\(caller, action, detail, call\)/);
    });
});
