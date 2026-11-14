import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProviderGauge, providerTickLine, providerTicks, type ProviderTick } from '../scripts/provider-ticks.mjs';

const old: ProviderTick = { pid: 2560, generation: '00000000-0000-4000-8000-000000000001', bornAt: 100, tick: 99 };
const fresh: ProviderTick = { pid: 2560, generation: '00000000-0000-4000-8000-000000000002', bornAt: 1100, tick: 1 };
const reading = (ticks: readonly ProviderTick[], running = true) => ({ ticks, running });
const make = () => freshProviderGauge({ startedAt: 1000, before: [old] });

describe('a fresh provider stream uses its generation and advancing ticks (Tynn #720)', () => {
    it('CONTROL: the ticker prefix stays compatible and two generations on one PID remain distinct', () => {
        expect(providerTickLine(1, fresh)).toMatch(/^tick 1 pid 2560 generation /);
        expect(providerTicks([{ text: providerTickLine(old.tick, old) + providerTickLine(1, fresh) }])).toEqual([old, fresh]);
    });
    it('CONTROL: old generation ticks do not become fresh by increasing their counter', () => {
        const gauge = make();
        expect(gauge.observe(reading([old]), () => true)).toBeNull();
        expect(gauge.observe(reading([{ ...old, tick: 100 }]), () => true)).toBeNull();
    });
    it('a reused PID with a new generation born after Start proves streaming when its own ticks advance', () => {
        const gauge = make();
        expect(gauge.observe(reading([old, fresh]), () => true)).toBeNull();
        expect(gauge.observe(reading([old, { ...fresh, tick: 2 }]), () => true)).toEqual({ ...fresh, tick: 2 });
    });
    it('a never-seen PID must also show advancement after the first observation', () => {
        const gauge = make(), tick = { ...fresh, pid: 9000 };
        expect(gauge.observe(reading([tick]), () => true)).toBeNull();
        expect(gauge.observe(reading([{ ...tick, tick: 2 }]), () => true)).toEqual({ ...tick, tick: 2 });
    });
    it('stale history from a previously unseen generation stays refused even if its PID is alive and more history arrives', () => {
        const gauge = make(), stale = { ...fresh, pid: 9000, bornAt: 900 };
        expect(gauge.observe(reading([stale]), () => true)).toBeNull();
        expect(gauge.observe(reading([{ ...stale, tick: 2 }]), () => true)).toBeNull();
    });
    it('repeated copies of the same tick do not prove a stream', () => {
        const gauge = make(), tick = { ...fresh, pid: 9000 };
        expect(gauge.observe(reading([tick]), () => true)).toBeNull();
        expect(gauge.observe(reading([tick, tick]), () => true)).toBeNull();
    });
    it('advancement belongs to the same generation, not the next process using its PID', () => {
        const gauge = make(), a = { ...fresh, pid: 9000 }, b = { ...a, generation: '00000000-0000-4000-8000-000000000003', bornAt: 1200, tick: 2 };
        expect(gauge.observe(reading([a]), () => true)).toBeNull();
        expect(gauge.observe(reading([a, b]), () => true)).toBeNull();
        expect(gauge.observe(reading([a, { ...b, tick: 3 }]), () => true)).toEqual({ ...b, tick: 3 });
    });
    it('CONTROL: a stopped session or a dead provider never passes', () => {
        const gauge = make();
        expect(gauge.observe(reading([fresh], false), () => true)).toBeNull();
        expect(gauge.observe(reading([{ ...fresh, tick: 2 }]), () => false)).toBeNull();
    });
    it('the rejection report includes the rejected generation, tick and Start boundary', () => {
        const gauge = make(); gauge.observe(reading([fresh]), () => true);
        expect(gauge.diagnostics()).toMatchObject({ startedAt: 1000, ticks: [fresh], reason: expect.any(String) });
    });
    it('the real ticker stamps once per process and E3 uses this gauge with its original bound and failure diagnostics', () => {
        const stub = readFileSync('scripts/stub-codex.mjs', 'utf8');
        expect(stub).toContain('const TICKER_PROCESS = TICKER ? { pid: process.pid, generation: randomUUID(), bornAt: Date.now() } : null;');
        expect(stub).toContain('delta(providerTickLine(tick, TICKER_PROCESS))');
        const row = readFileSync('scripts/safe-mode-cdp.mjs', 'utf8');
        expect(row).toContain('const startedAt = Date.now();');
        expect(row).toContain('const gauge = freshProviderGauge({ startedAt, before: ticksAtStart.ticks });');
        expect(row).toMatch(/gauge\.observe\(x, alive\)[\s\S]{0,250}?\}, 45_000\)/);
        expect(row).toContain('E3 rejected ticks:');
        expect(row).not.toContain('!providersBefore.has(x.last)');
    });
});
