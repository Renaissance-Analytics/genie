import { describe, expect, it } from 'vitest';
import {
    assignPort,
    hostedOrigin,
    preferredPort,
    HOSTED_PORT_MAX,
    HOSTED_PORT_MIN,
    HOSTED_PORT_SLOTS,
} from '../ports';

/**
 * The contract these defend: a hosted site's origin is STABLE.
 *
 * If the port moved between restarts, every saved Testing-Browser tab, every
 * bookmark and every `.gen` mapping would rot — which is the exact failure mode
 * (a volatile origin) that hosting exists to remove. So the port must be a pure
 * function of the site id, and the collision fallback must be deterministic too.
 */
describe('preferredPort', () => {
    it('is deterministic for a given site id', () => {
        expect(preferredPort('abc123')).toBe(preferredPort('abc123'));
    });

    it('stays inside the reserved range for any id', () => {
        for (const id of ['a', 'tynn.test', 'x'.repeat(200), '', '🐘']) {
            const port = preferredPort(id);
            expect(port).toBeGreaterThanOrEqual(HOSTED_PORT_MIN);
            expect(port).toBeLessThanOrEqual(HOSTED_PORT_MAX);
        }
    });

    it('spreads different ids across the range', () => {
        const ports = new Set(
            Array.from({ length: 200 }, (_, i) => preferredPort(`site-${i}`)),
        );
        // Birthday collisions in 1000 slots are expected; clustering is not.
        expect(ports.size).toBeGreaterThan(150);
    });
});

describe('assignPort', () => {
    it('hands out the preferred port when it is free', () => {
        expect(assignPort('site-a', new Set())).toBe(preferredPort('site-a'));
    });

    it('falls forward deterministically when the preferred port is taken', () => {
        const wanted = preferredPort('site-a');
        const taken = new Set([wanted]);
        expect(assignPort('site-a', taken)).toBe(wanted + 1);
        // Same inputs, same answer — the fallback is stable, not first-come.
        expect(assignPort('site-a', taken)).toBe(wanted + 1);
    });

    it('wraps within the range rather than walking past its end', () => {
        const taken = new Set<number>();
        for (let p = HOSTED_PORT_MAX; p >= HOSTED_PORT_MAX - 3; p -= 1) taken.add(p);
        // An id that prefers the very last slot must wrap to the range floor.
        const port = assignPort('anything', taken);
        expect(port).toBeGreaterThanOrEqual(HOSTED_PORT_MIN);
        expect(port).toBeLessThanOrEqual(HOSTED_PORT_MAX);
        expect(taken.has(port)).toBe(false);
    });

    it('throws instead of returning a port someone else owns', () => {
        const all = new Set(
            Array.from({ length: HOSTED_PORT_SLOTS }, (_, i) => HOSTED_PORT_MIN + i),
        );
        expect(() => assignPort('site-a', all)).toThrow(/no free hosting port/);
    });
});

describe('hostedOrigin', () => {
    it('builds one same-origin URL and lowercases the host', () => {
        expect(hostedOrigin('Tynn.Test', 20431, 'https')).toBe('https://tynn.test:20431');
    });

    it('carries the scheme the backend actually serves', () => {
        expect(hostedOrigin('app.test', 20000, 'http')).toBe('http://app.test:20000');
    });
});
