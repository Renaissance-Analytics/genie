import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DAY_MS, DEVICE_EXPIRY_DAYS } from '../core/device-expiry.js';
import { runtimeDir } from './paths.js';
import { readJson, reportFlush, writeJsonAtomic } from './store.js';

/**
 * PAIRED DEVICES (§6.8) — the phones and laptops that read a PIN off this screen once. Each holds a
 * token; the host stores only its hash, so the file on disk is not a key ring. Pairing is the
 * OWNER's act (the PIN is on the host's own screen), so a paired device is the owner's device.
 */

export interface Device {
    readonly id: string;
    readonly label: string;
    readonly pairedAt: string;
    readonly lastSeenAt: string;
    /** When this pairing lapses unless the device connects first (lastSeenAt + the idle limit). */
    readonly expiresAt: string;
}

interface DeviceRecord {
    readonly id: string;
    readonly label: string;
    readonly pairedAt: string;
    readonly lastSeenAt: string;
    readonly tokenHash: string;
}

interface DevicesFile {
    devices: DeviceRecord[];
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * A paired device that has not connected for this long is no longer paired: its token is refused and Settings stops
 * listing it. Sliding — every connection renews it — so a phone in use never re-pairs; a lost one stops working on its
 * own. 90 days since the owner's 2026-10-31 decision (q_8c07b142); genie#1349 had 30. Genie 1's tokens never expired.
 */
export const DEVICE_IDLE_MS = DEVICE_EXPIRY_DAYS * DAY_MS;

/** What a token is: a paired device (now renewed), a pairing that lapsed, or nothing this host ever paired. */
export type TokenCheck = { ok: true; device: Device } | { ok: false; expired: boolean };

export class DeviceStore {
    readonly #file: string;
    readonly #now: () => number;
    readonly #random: () => string;
    readonly #idleMs: number;
    #data: DevicesFile;
    /** Token hashes whose pairing lapsed while this process ran — so the device is told it EXPIRED, not that it is unknown. */
    readonly #lapsed = new Set<string>();
    /** Writes are serialized and awaitable: a caller that is about to leave (or a test about to delete the dir) awaits `flushed()`. */
    #pending: Promise<void> = Promise.resolve();

    private constructor(file: string, deps: { now: () => number; random: () => string; idleMs?: number }, data: DevicesFile) {
        this.#file = file;
        this.#now = deps.now;
        this.#random = deps.random;
        this.#idleMs = deps.idleMs ?? DEVICE_IDLE_MS;
        this.#data = data;
    }

    static async open(userData: string, deps: { now: () => number; random: () => string; idleMs?: number }): Promise<DeviceStore> {
        const file = join(runtimeDir(userData), 'remote-devices.json');
        return new DeviceStore(file, deps, await readJson<DevicesFile>(file, { devices: [] }));
    }

    /** Mint a token for a device that just proved it read the PIN. The token is returned ONCE; only its hash is kept. */
    pair(label: string): { device: Device; token: string } {
        const token = this.#random();
        const at = new Date(this.#now()).toISOString();
        const record: DeviceRecord = { id: `dev_${hash(token).slice(0, 12)}`, label, pairedAt: at, lastSeenAt: at, tokenHash: hash(token) };
        this.#data.devices.push(record);
        reportFlush(this.#flush(), 'the remote devices store');
        return { device: this.#view(record), token };
    }

    /** A connection presenting a token: the device it pairs, renewed for another idle period — or why not. */
    check(token: string): TokenCheck {
        this.#expire();
        const h = hash(token);
        const record = this.#data.devices.find((d) => d.tokenHash === h);
        if (!record) return { ok: false, expired: this.#lapsed.has(h) };
        const seen = { ...record, lastSeenAt: new Date(this.#now()).toISOString() };
        this.#data.devices = this.#data.devices.map((d) => (d.id === record.id ? seen : d));
        reportFlush(this.#flush(), 'the remote devices store');
        return { ok: true, device: this.#view(seen) };
    }

    byToken(token: string): Device | null {
        const r = this.check(token);
        return r.ok ? r.device : null;
    }

    list(): Device[] {
        this.#expire();
        return this.#data.devices.map((d) => this.#view(d));
    }

    #view(r: DeviceRecord): Device {
        return { id: r.id, label: r.label, pairedAt: r.pairedAt, lastSeenAt: r.lastSeenAt, expiresAt: new Date(Date.parse(r.lastSeenAt) + this.#idleMs).toISOString() };
    }

    /** Drop every device unseen for longer than the idle limit, and write that down. */
    #expire(): void {
        const now = this.#now();
        const kept = this.#data.devices.filter((d) => now - Date.parse(d.lastSeenAt) <= this.#idleMs);
        if (kept.length === this.#data.devices.length) return;
        for (const d of this.#data.devices) if (!kept.includes(d)) this.#lapsed.add(d.tokenHash);
        this.#data.devices = kept;
        reportFlush(this.#flush(), 'the remote devices store');
    }

    revoke(id: string): boolean {
        const before = this.#data.devices.length;
        this.#data.devices = this.#data.devices.filter((d) => d.id !== id);
        if (this.#data.devices.length === before) return false;
        reportFlush(this.#flush(), 'the remote devices store');
        return true;
    }

    /** Resolves once every write so far has landed. */
    flushed(): Promise<void> {
        return this.#pending;
    }

    #flush(): Promise<void> {
        const snapshot: DevicesFile = { devices: [...this.#data.devices] };
        this.#pending = this.#pending.then(() => writeJsonAtomic(this.#file, snapshot));
        return this.#pending;
    }
}
