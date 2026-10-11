import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runtimeDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

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
}

interface DeviceRecord extends Device {
    readonly tokenHash: string;
}

interface DevicesFile {
    devices: DeviceRecord[];
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

export class DeviceStore {
    readonly #file: string;
    readonly #now: () => number;
    readonly #random: () => string;
    #data: DevicesFile;
    /** Writes are serialized and awaitable: a caller that is about to leave (or a test about to delete the dir) awaits `flushed()`. */
    #pending: Promise<void> = Promise.resolve();

    private constructor(file: string, deps: { now: () => number; random: () => string }, data: DevicesFile) {
        this.#file = file;
        this.#now = deps.now;
        this.#random = deps.random;
        this.#data = data;
    }

    static async open(userData: string, deps: { now: () => number; random: () => string }): Promise<DeviceStore> {
        const file = join(runtimeDir(userData), 'remote-devices.json');
        return new DeviceStore(file, deps, await readJson<DevicesFile>(file, { devices: [] }));
    }

    /** Mint a token for a device that just proved it read the PIN. The token is returned ONCE; only its hash is kept. */
    pair(label: string): { device: Device; token: string } {
        const token = this.#random();
        const at = new Date(this.#now()).toISOString();
        const record: DeviceRecord = { id: `dev_${hash(token).slice(0, 12)}`, label, pairedAt: at, lastSeenAt: at, tokenHash: hash(token) };
        this.#data.devices.push(record);
        void this.#flush();
        return { device: publicView(record), token };
    }

    byToken(token: string): Device | null {
        const h = hash(token);
        const record = this.#data.devices.find((d) => d.tokenHash === h);
        if (!record) return null;
        const seen = { ...record, lastSeenAt: new Date(this.#now()).toISOString() };
        this.#data.devices = this.#data.devices.map((d) => (d.id === record.id ? seen : d));
        void this.#flush();
        return publicView(seen);
    }

    list(): Device[] {
        return this.#data.devices.map(publicView);
    }

    revoke(id: string): boolean {
        const before = this.#data.devices.length;
        this.#data.devices = this.#data.devices.filter((d) => d.id !== id);
        if (this.#data.devices.length === before) return false;
        void this.#flush();
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

function publicView(r: DeviceRecord): Device {
    return { id: r.id, label: r.label, pairedAt: r.pairedAt, lastSeenAt: r.lastSeenAt };
}
