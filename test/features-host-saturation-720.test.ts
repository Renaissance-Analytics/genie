import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_FEATURE_CALLER_LIMIT } from '../src/main/features-host.js';
import { CALLER_A, CALLER_B, deferred, presentationFixture, type PresentationFixture } from './helpers/features-host-presentation.js';

let f: PresentationFixture;
beforeEach(async () => { f = await presentationFixture(); });
afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });

describe('feature queues refuse overflow and dispose work that has not started (Tynn #720)', () => {
    it('CONTROL: one caller permits exactly 32 unfinished actions and refuses the next before it can run', async () => {
        const held = f.holdSetting(), pending = [held.start()]; await held.entered;
        for (let i = 1; i < 32; i++) pending.push(f.invoke({ kind: 'knowledge.search', query: `queued-${i}` }));
        let overflow: unknown = null;
        const extra = f.invoke({ kind: 'knowledge.search', query: 'must not run' }).then(result => { overflow = result; return result; });
        await f.settle();
        try { expect(overflow).toMatchObject({ ok: false, reason: expect.stringContaining('too many pending actions') }); }
        finally { held.release(); await Promise.all([...pending, extra]); }
        expect((await f.snapshot()).knowledge.query).toBe('queued-31');
        expect((await f.invoke({ kind: 'knowledge.search', query: 'slot recovered' })).ok).toBe(true);
    });
    it('CONTROL: a full caller queue never blocks a second caller', async () => {
        const held = f.holdSetting(), pending = [held.start()]; await held.entered;
        for (let i = 1; i < 32; i++) pending.push(f.invoke({ kind: 'knowledge.search', query: `queued-${i}` }));
        try { await f.answer({ kind: 'knowledge.search', query: 'other caller' }, CALLER_B);
            expect((await f.snapshot(CALLER_B)).knowledge.query).toBe('other caller'); }
        finally { held.release(); await Promise.all(pending); }
    });
    it('CONTROL: all 64 busy caller slots refuse a new caller instead of evicting live work', async () => {
        const finish = deferred(); f.holds.push(() => finish.resolve());
        const original = f.settings.set.bind(f.settings); let entered = 0;
        vi.spyOn(f.settings, 'set').mockImplementation(async (key, value) => { entered++; await finish.promise; return original(key, value); });
        const pending = Array.from({ length: HOST_FEATURE_CALLER_LIMIT }, (_, i) => f.invoke(
            { kind: 'settings.set', key: 'publisher_checks_off', value: false }, { ...CALLER_A, connectionId: `busy-${i}` }));
        await f.settle();
        try {
            expect(entered).toBe(64);
            expect(await f.invoke({ kind: 'knowledge.search', query: 'overflow' }, { ...CALLER_A, connectionId: 'busy-overflow' }))
                .toMatchObject({ ok: false, reason: expect.stringContaining('callers are busy') });
        } finally { finish.resolve(); await Promise.all(pending); }
        expect((await f.invoke({ kind: 'knowledge.search', query: 'recovered' }, { ...CALLER_A, connectionId: 'busy-overflow' })).ok).toBe(true);
    });
    it('CONTROL: retention evicts an idle slot while the oldest busy caller keeps its state', async () => {
        await f.answer({ kind: 'knowledge.search', query: 'busy caller retained' });
        const held = f.holdSetting(), pending = held.start(); await held.entered;
        try {
            for (let i = 1; i < HOST_FEATURE_CALLER_LIMIT; i++) await f.answer({ kind: 'knowledge.search', query: `idle-${i}` }, { ...CALLER_A, connectionId: `idle-${i}` });
            await f.answer({ kind: 'knowledge.search', query: 'new' }, { ...CALLER_A, connectionId: 'new-idle' });
            expect((await f.snapshot()).knowledge.query).toBe('busy caller retained');
            expect((await f.snapshot({ ...CALLER_A, connectionId: 'idle-1' })).knowledge.query).toBe('');
        } finally { held.release(); await pending; }
    });
    it('CONTROL: disconnect refuses queued mutations before their business operation begins', async () => {
        const held = f.holdSetting(), first = held.start(); await held.entered;
        const second = f.invoke({ kind: 'settings.set', key: 'publisher_checks_off', value: true });
        f.service.releaseCaller(CALLER_A); held.release(); expect((await first).ok).toBe(true);
        expect(await second).toMatchObject({ ok: false, reason: expect.stringContaining('disconnected before its action began') });
        expect(f.settings.get('publisher_checks_off')).toBe(false);
    });
    it('CONTROL: reconnecting with a fresh cell cannot release an old queued mutation', async () => {
        const held = f.holdSetting(), first = held.start(); await held.entered;
        const old = f.invoke({ kind: 'knowledge.search', query: 'old queued caller' });
        f.service.releaseCaller(CALLER_A);
        try { await f.answer({ kind: 'knowledge.search', query: 'new caller' }); }
        finally { held.release(); await first; }
        expect((await old).ok).toBe(false); expect((await f.snapshot()).knowledge.query).toBe('new caller');
    });
    it('CONTROL: service close refuses queued mutations and the active late answer', async () => {
        const held = f.holdSetting(), first = held.start(); await held.entered;
        const queued = f.invoke({ kind: 'settings.set', key: 'publisher_checks_off', value: true });
        f.service.close(); held.release();
        expect(await first).toMatchObject({ ok: false, reason: expect.stringContaining('feature service is closed') });
        expect(await queued).toMatchObject({ ok: false, reason: expect.stringContaining('feature service is closed') });
        expect(f.settings.get('publisher_checks_off')).toBe(false);
    });
});
