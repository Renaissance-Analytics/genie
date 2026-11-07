import { randomUUID } from 'node:crypto';
import { splitTerminalText } from '../core/terminal-stream.js';
import { TerminalInputQueue } from './terminal-streams.js';
import type { NativeTerminalPort } from './local-terminal-native.js';

interface Slot {
    owner: string; id: string; ticket: string; active: boolean; dead: boolean; finishing: boolean; pending: Promise<void>;
    grant(ticket: string): void; refuse(error: Error): void;
}
const disconnected = () => new Error('terminal connection disconnected or closed');

/** Reserve a logical write before its first chunk: another view cannot interleave input or consume its credit. */
export class LocalTerminalInputs {
    readonly #port: Pick<NativeTerminalPort, 'invoke'>;
    readonly #queue: TerminalInputQueue;
    readonly #slots = new Map<string, Slot>();
    readonly #terminals = new Map<string, Slot[]>();
    constructor(port: Pick<NativeTerminalPort, 'invoke'>) {
        this.#port = port;
        this.#queue = new TerminalInputQueue({
            write: async (id, data) => (await port.invoke('write', [id, data])) === true,
            resize: async (id, cols, rows) => (await port.invoke('resize', [id, cols, rows])) === true,
            close: async id => (await port.invoke('close', [id])) === true,
        });
    }
    pendingBytes(id: string): number { return this.#queue.pendingBytes(id); }
    begin(owner: string, id: string): Promise<string> {
        return new Promise((grant, refuse) => {
            const slot: Slot = { owner, id, ticket: randomUUID(), active: false, dead: false, finishing: false, pending: Promise.resolve(), grant, refuse };
            const queue = this.#terminals.get(id) ?? []; this.#terminals.set(id, queue); queue.push(slot); this.#slots.set(slot.ticket, slot);
            if (queue.length === 1) { slot.active = true; grant(slot.ticket); }
        });
    }
    async chunk(owner: string, ticket: string, data: string): Promise<void> {
        const slot = this.#owned(owner, ticket);
        if (slot.finishing || typeof data !== 'string') throw disconnected();
        const chunks = splitTerminalText(data); chunks.next();
        if (!chunks.next().done) throw new Error('terminal connection closed: input chunk exceeds its frame');
        const pending = this.#queue.write(slot.id, data);
        slot.pending = Promise.all([slot.pending, pending]).then(() => {}); void slot.pending.catch(() => {});
        await pending;
    }
    async finish(owner: string, ticket: string): Promise<void> {
        const slot = this.#owned(owner, ticket); slot.finishing = true;
        try { await slot.pending; } finally { this.#release(slot); }
    }
    async run(owner: string, id: string, method: string, args: unknown[]): Promise<unknown> {
        const ticket = await this.begin(owner, id), slot = this.#owned(owner, ticket);
        const pending = (async () => {
            try {
                if (method === 'write' && typeof args[1] === 'string') { await this.#queue.write(id, args[1]); return true; }
                if (method === 'resize' && typeof args[1] === 'number' && typeof args[2] === 'number') { await this.#queue.resize(id, args[1], args[2]); return true; }
                if (method === 'close') { await this.#queue.close(id); return true; }
            } catch (error) { if (error instanceof Error && /gone or closed/.test(error.message)) return false; throw error; }
            return this.#port.invoke(method, args);
        })();
        slot.pending = pending.then(() => {}); void slot.pending.catch(() => {}); slot.finishing = true;
        try { return await pending; } finally { this.#release(slot); }
    }
    dropOwner(owner: string): void {
        for (const slot of this.#slots.values()) {
            if (slot.owner !== owner || slot.dead) continue;
            slot.dead = true;
            if (!slot.active) { slot.refuse(disconnected()); this.#release(slot); }
            else void slot.pending.then(() => this.#release(slot), () => this.#release(slot));
        }
    }
    #owned(owner: string, ticket: string): Slot {
        const slot = this.#slots.get(ticket);
        if (!slot || slot.owner !== owner || slot.dead || !slot.active) throw disconnected();
        return slot;
    }
    #release(slot: Slot): void {
        if (!this.#slots.delete(slot.ticket)) return;
        const queue = this.#terminals.get(slot.id)!; const index = queue.indexOf(slot); queue.splice(index, 1);
        if (!queue.length) this.#terminals.delete(slot.id);
        else if (index === 0) { const next = queue[0]!; next.active = true; next.grant(next.ticket); }
    }
}
