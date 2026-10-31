import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, DEVICE_EXPIRY_DAYS, DEVICE_EXPIRY_WARNING_DAYS, deviceExpiryAlert, deviceExpiryText } from '../src/core/device-expiry.js';
import { DEVICE_IDLE_MS, DeviceStore } from '../src/main/remote-devices.js';

/**
 * A PAIRING LASTS 90 DAYS WITHOUT A CONNECTION, AND SAYS SO BEFORE IT ENDS (the owner, 2026-10-31, q_8c07b142).
 *
 * genie#1349 expired a device after 30 idle days, silently: the phone just landed on the PIN form one day. Now:
 * - 90 days, sliding: every connection from the device renews it;
 * - within DEVICE_EXPIRY_WARNING_DAYS (14) of the end, a yellow ! on the Settings row and on the device's row, its
 *   tooltip naming the device and the date ("start showing a notice in the form of a yellow ! mark in the Setting menu
 *   row with a tool tip saying when a paired device key is about to expire so users can renew the pairing");
 * - the mark goes away once nothing is close to expiring.
 * The clock is injected throughout.
 */

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0); // 2026-10-31 12:00 UTC

describe('the constants', () => {
    it('a pairing lasts 90 days idle, and the warning starts 14 days before', () => {
        expect(DEVICE_EXPIRY_DAYS).toBe(90);
        expect(DEVICE_EXPIRY_WARNING_DAYS).toBe(14);
        expect(DEVICE_IDLE_MS).toBe(90 * DAY_MS);
        expect(DAY_MS).toBe(86_400_000);
    });
});

describe('DeviceStore — the 90-day boundary', () => {
    let dir: string;
    let now: number;
    let store: DeviceStore;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-device-expiry-'));
        now = T0;
        let n = 0;
        store = await DeviceStore.open(dir, { now: () => now, random: () => `tok${n++}` });
    });

    afterEach(async () => {
        await store.flushed();
        await rm(dir, { recursive: true, force: true });
    });

    it('a device says when it expires: 90 days after it was last seen', () => {
        const { device } = store.pair('Pixel 7');
        expect(device.expiresAt).toBe(new Date(T0 + 90 * DAY_MS).toISOString());
    });

    it('exactly 90 days after the last connection it still works; one millisecond later it is refused and must pair again', () => {
        store.pair('Pixel 7');
        now = T0 + 90 * DAY_MS;
        expect(store.check('tok0')).toMatchObject({ ok: true, device: { label: 'Pixel 7' } });
        // That connection renewed it: another 90 days from now.
        now += 90 * DAY_MS + 1;
        expect(store.check('tok0')).toEqual({ ok: false, expired: true });
        expect(store.list()).toEqual([]);
    });

    it('day 89 still works; day 90 + 1 ms without a connection does not (no renewal in between)', async () => {
        store.pair('Pixel 7');
        now = T0 + 89 * DAY_MS;
        expect(store.list()).toHaveLength(1);
        now = T0 + 90 * DAY_MS + 1;
        expect(store.check('tok0')).toEqual({ ok: false, expired: true });
    });

    it('a token that was never paired is not "expired" — the phone is told the truth either way', () => {
        expect(store.check('nope')).toEqual({ ok: false, expired: false });
    });

    it('CONNECTING RENEWS: a device seen on day 80 now expires 90 days after day 80', () => {
        store.pair('Pixel 7');
        now = T0 + 80 * DAY_MS;
        const seen = store.check('tok0');
        expect(seen.ok && seen.device.expiresAt).toBe(new Date(T0 + 170 * DAY_MS).toISOString());
    });
});

describe('the warning — a yellow ! when a pairing is close to its end', () => {
    const device = (label: string, expiresInMs: number, id = `dev_${label}`) => ({ id, label, expiresAt: new Date(T0 + expiresInMs).toISOString() });

    it('nothing within 14 days: no mark at all', () => {
        expect(deviceExpiryAlert([device('Pixel 7', 14 * DAY_MS + 1)], T0, { timeZone: 'UTC' })).toBeNull();
        expect(deviceExpiryAlert([], T0)).toBeNull();
    });

    it('AT exactly 14 days it appears, naming the device and the date it expires', () => {
        const alert = deviceExpiryAlert([device('Pixel 7', 14 * DAY_MS)], T0, { timeZone: 'UTC' });
        expect(alert).toEqual({
            label: 'The pairing for Pixel 7 expires on Nov 14, 2026. Connect from that device to renew it, or Re-pair it in Settings → Remote access.',
            devices: [{ id: 'dev_Pixel 7', label: 'Pixel 7', expiresAt: new Date(T0 + 14 * DAY_MS).toISOString(), text: 'The pairing for Pixel 7 expires on Nov 14, 2026. Connect from that device to renew it, or Re-pair it in Settings → Remote access.' }],
        });
    });

    it('the tooltip text for one device — the words the person reads on hover', () => {
        expect(deviceExpiryText('iPad', new Date(Date.UTC(2027, 0, 3, 9)).toISOString(), { timeZone: 'UTC' })).toBe('The pairing for iPad expires on Jan 3, 2027. Connect from that device to renew it, or Re-pair it in Settings → Remote access.');
    });

    it('two devices close to their end: both named, soonest first; a device far from its end is left out', () => {
        const alert = deviceExpiryAlert([device('iPad', 10 * DAY_MS), device('Desk laptop', 60 * DAY_MS), device('Pixel 7', 2 * DAY_MS)], T0, { timeZone: 'UTC' });
        expect(alert!.devices.map((d) => d.label)).toEqual(['Pixel 7', 'iPad']);
        expect(alert!.label).toBe(
            'The pairing for Pixel 7 expires on Nov 2, 2026. The pairing for iPad expires on Nov 10, 2026. Connect from each device to renew it, or Re-pair it in Settings → Remote access.',
        );
    });

    it('CLEARS AFTER RENEWAL: the device connects, its 90 days start again, and the mark goes away', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie2-device-renew-'));
        let now = T0;
        const store = await DeviceStore.open(dir, { now: () => now, random: () => 'tok' });
        try {
            store.pair('Pixel 7');
            now = T0 + 80 * DAY_MS; // 10 days left
            expect(deviceExpiryAlert(store.list(), now, { timeZone: 'UTC' })!.devices.map((d) => d.label)).toEqual(['Pixel 7']);
            expect(store.check('tok').ok).toBe(true); // the phone connects
            expect(deviceExpiryAlert(store.list(), now, { timeZone: 'UTC' })).toBeNull();
        } finally {
            await store.flushed();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
