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
        const gates = [...code('main.ts').matchAll(/approvals\.gate\(([^)]*)\)/g)].map((m) => m[1]!.split(',').map((a) => a.trim()));
        expect(gates.length).toBeGreaterThan(0);
        for (const args of gates) expect(args).toHaveLength(4);
        expect(code('main.ts')).toMatch(/approve: \(caller, action, detail, call\) => composed\.approvals\.gate\(caller, action, detail, call\)/);
    });
});
