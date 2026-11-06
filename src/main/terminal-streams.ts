import { splitTerminalText, TERMINAL_CHUNK_BYTES, TERMINAL_QUEUE_BYTES, TerminalStreamReceiver, terminalDataPosition, terminalPosition } from '../core/terminal-stream.js';
import type { TerminalTextChunk, TerminalStreamSnapshot } from '../core/terminal-stream.js';

/** Account for control frames and empty writes as well as text: tiny calls cannot create an unbounded queue. */
const FRAME_BYTES = 64;
class Queue<T> {
    #items: Array<T | undefined> = [];
    #head = 0;
    get length(): number { return this.#items.length - this.#head; }
    peek(): T | undefined { return this.#items[this.#head]; }
    push(item: T): void { this.#items.push(item); }
    shift(): T | undefined {
        const index = this.#head++, item = this.#items[index];
        this.#items[index] = undefined; // Release acknowledged payloads even while later frames keep the queue nonempty.
        if (this.#head >= this.#items.length) this.clear();
        else if (this.#head >= 1024 && this.#head * 2 > this.#items.length) { this.#items = this.#items.slice(this.#head); this.#head = 0; }
        return item;
    }
    clear(): void { this.#items = []; this.#head = 0; }
}

export interface TerminalInputPorts {
    write(id: string, data: string): Promise<boolean>;
    resize(id: string, cols: number, rows: number): Promise<boolean>;
    close(id: string): Promise<boolean>;
}
type InputOperation = { kind: 'write'; chunks: Generator<TerminalTextChunk> } | { kind: 'resize'; cols: number; rows: number } | { kind: 'close' };
interface InputJob { operation: InputOperation | null; pending: number; fed: boolean; resolve(): void; reject(error: Error): void }
interface InputFrame { job: InputJob; bytes: number; run(): Promise<boolean> }
interface InputState { id: string; waiting: Queue<InputJob>; jobs: Set<InputJob>; frames: Queue<InputFrame>; bytes: number; running: boolean; error: Error | null }

/** One ordered queue per terminal. Unadmitted text stays in the caller's lazy write, with no aggregate size ceiling. */
export class TerminalInputQueue {
    readonly #ports: TerminalInputPorts;
    readonly #states = new Map<string, InputState>();
    #disconnected = false;
    constructor(ports: TerminalInputPorts) { this.#ports = ports; }
    write(id: string, data: string): Promise<void> { return this.#submit(id, { kind: 'write', chunks: splitTerminalText(data) }); }
    resize(id: string, cols: number, rows: number): Promise<void> { return this.#submit(id, { kind: 'resize', cols, rows }); }
    close(id: string): Promise<void> { return this.#submit(id, { kind: 'close' }); }
    pendingBytes(id: string): number { return this.#states.get(id)?.bytes ?? 0; }
    disconnect(): void {
        this.#disconnected = true;
        for (const state of this.#states.values()) this.#fail(state, new Error('terminal connection disconnected'));
    }
    #submit(id: string, operation: InputOperation): Promise<void> {
        if (this.#disconnected) return Promise.reject(new Error('terminal connection disconnected'));
        let state = this.#states.get(id);
        if (!state) { state = { id, waiting: new Queue(), jobs: new Set(), frames: new Queue(), bytes: 0, running: false, error: null }; this.#states.set(id, state); }
        const current = state;
        return new Promise<void>((resolve, reject) => {
            const job: InputJob = { operation, pending: 0, fed: false, resolve, reject };
            current.jobs.add(job); current.waiting.push(job); this.#fill(current);
        });
    }
    #settle(state: InputState, job: InputJob): void {
        if (job.fed && job.pending === 0 && state.jobs.delete(job)) { job.operation = null; job.resolve(); }
    }
    #fill(state: InputState): void {
        while (!state.error && state.waiting.length) {
            const job = state.waiting.peek()!, op = job.operation!;
            if (state.bytes + (op.kind === 'write' ? TERMINAL_CHUNK_BYTES : 0) + FRAME_BYTES > TERMINAL_QUEUE_BYTES) break;
            let frame: InputFrame;
            if (op.kind === 'write') {
                const next = op.chunks.next();
                if (next.done) { state.waiting.shift(); job.fed = true; this.#settle(state, job); continue; }
                const chunk = next.value;
                frame = { job, bytes: chunk.bytes + FRAME_BYTES, run: () => this.#ports.write(state.id, chunk.data) };
            } else {
                state.waiting.shift(); job.fed = true;
                frame = { job, bytes: FRAME_BYTES, run: () => op.kind === 'resize' ? this.#ports.resize(state.id, op.cols, op.rows) : this.#ports.close(state.id) };
            }
            job.pending++; state.bytes += frame.bytes; state.frames.push(frame);
        }
        void this.#run(state);
    }
    async #run(state: InputState): Promise<void> {
        if (state.running || state.error) return;
        state.running = true;
        try {
            while (!state.error && state.frames.length) {
                const frame = state.frames.shift()!;
                let accepted: boolean;
                try { accepted = await frame.run(); }
                catch { this.#fail(state, new Error(`terminal ${state.id} connection closed while sending input`)); break; }
                if (state.error) break; // A late acknowledgement after disconnect cannot restart the producer.
                if (!accepted) { this.#fail(state, new Error(`terminal ${state.id} is gone or closed`)); break; }
                const closing = frame.job.operation?.kind === 'close';
                state.bytes -= frame.bytes; frame.job.pending--; this.#settle(state, frame.job);
                if (closing) { this.#fail(state, new Error(`terminal ${state.id} is closed`)); break; }
                this.#fill(state);
            }
        } finally {
            state.running = false;
            if (state.jobs.size === 0 && this.#states.get(state.id) === state) this.#states.delete(state.id);
        }
    }
    #fail(state: InputState, error: Error): void {
        if (state.error) return;
        state.error = error;
        for (const job of state.jobs) {
            if (job.operation?.kind === 'write') job.operation.chunks.return(undefined);
            job.operation = null; job.reject(error);
        }
        state.jobs.clear(); state.waiting.clear(); state.frames.clear(); state.bytes = 0;
        if (this.#states.get(state.id) === state) this.#states.delete(state.id);
    }
}

export interface TerminalSourceData { id: string; data: string; epoch?: string | null; offset?: number | null }
export interface TerminalSourceExit { id: string; exitCode: number; epoch?: string | null; endOffset?: number | null }
export type TerminalStreamEvent =
    | { kind: 'data'; id: string; data: string; epoch: string; offset: number }
    | { kind: 'exit'; id: string; exitCode: number; epoch: string; endOffset: number }
    | { kind: 'resync'; id: string; reason: string };
export interface TerminalViewPorts {
    /** Return only a terminal this owner may attach to; null means gone or outside its window capability. */
    snapshot(id: string, owner: string): TerminalStreamSnapshot | null;
    listen(data: (event: TerminalSourceData) => void, exit: (event: TerminalSourceExit) => void): () => void;
    send(owner: string, view: string, event: TerminalStreamEvent): Promise<void>;
}
interface OutputFrame { event: TerminalStreamEvent; bytes: number }
interface ViewState {
    owner: string; view: string; id: string; receiver: TerminalStreamReceiver;
    queue: Queue<OutputFrame>; bytes: number; activeBytes: number;
    alive: boolean; ready: boolean; resync: boolean; running: boolean; scheduled: boolean;
}

/** Membership is a displayed pane, not a workspace. Cleanup removes interest and has no pty operation to call. */
export class TerminalViewStreams {
    readonly #ports: TerminalViewPorts;
    readonly #owners = new Map<string, Map<string, ViewState>>();
    #off: (() => void) | null = null;
    #disposed = false;
    constructor(ports: TerminalViewPorts) { this.#ports = ports; }
    refs(id: string): number { return [...this.#views()].filter(view => view.id === id).length; }
    bufferedBytes(owner: string, view: string): number { return this.#owners.get(owner)?.get(view)?.bytes ?? 0; }
    watch(owner: string, view: string, id: string): TerminalStreamSnapshot | null {
        if (this.#disposed) throw new Error('terminal stream connection is closed');
        this.unwatch(owner, view);
        const state: ViewState = { owner, view, id, receiver: new TerminalStreamReceiver(), queue: new Queue(), bytes: 0, activeBytes: 0, alive: true, ready: false, resync: false, running: false, scheduled: false };
        let mine = this.#owners.get(owner);
        if (!mine) { mine = new Map(); this.#owners.set(owner, mine); }
        mine.set(view, state);
        try {
            // Subscribe BEFORE reading the tail. Reentrant producer data is buffered, then reconciled with endOffset.
            this.#off ??= this.#ports.listen(event => this.#data(event), event => this.#exit(event));
            const snapshot = this.#ports.snapshot(id, owner);
            if (!snapshot || snapshot.id !== id) { this.unwatch(owner, view); return null; }
            const result = state.receiver.attach(snapshot), early = state.queue, overflowed = state.resync;
            state.queue = new Queue(); state.bytes = 0; state.ready = true; state.resync = false;
            if (result.kind === 'resync' || overflowed) this.#resync(state, 'terminal attachment requires a full resync');
            else while (early.length && !state.resync) { const frame = early.shift()!; this.#ingest(state, frame.event, frame.bytes); }
            return snapshot;
        } catch (error) { this.unwatch(owner, view); throw error; }
    }
    unwatch(owner: string, view: string): void {
        const mine = this.#owners.get(owner), state = mine?.get(view);
        if (!state) return;
        state.alive = false; state.queue.clear(); state.bytes = 0;
        mine!.delete(view); if (!mine!.size) this.#owners.delete(owner);
        if (!this.#owners.size && this.#off) { const off = this.#off; this.#off = null; off(); }
    }
    dropOwner(owner: string): void { for (const view of [...(this.#owners.get(owner)?.keys() ?? [])]) this.unwatch(owner, view); }
    dispose(): void { this.#disposed = true; for (const owner of [...this.#owners.keys()]) this.dropOwner(owner); }
    *#views(): Generator<ViewState> { for (const mine of this.#owners.values()) yield* mine.values(); }
    #data(event: TerminalSourceData): void {
        const targets = [...this.#views()].filter(view => view.id === event.id && !view.resync);
        if (!targets.length) return;
        const position = terminalDataPosition(event, event.data);
        if (!position) { for (const view of targets) this.#resync(view, 'terminal producer position is unknown'); return; }
        for (const chunk of splitTerminalText(event.data, position.offset)) {
            for (const view of targets) this.#ingest(view, { kind: 'data', id: event.id, epoch: position.epoch, offset: chunk.offset, data: chunk.data }, chunk.bytes + FRAME_BYTES);
            if (targets.every(view => view.resync || !view.alive)) break;
        }
    }
    #exit(event: TerminalSourceExit): void {
        const position = terminalPosition(event);
        for (const view of this.#views()) {
            if (view.id !== event.id) continue;
            if (!position) this.#resync(view, 'terminal exit has no producer position');
            else this.#ingest(view, { kind: 'exit', id: event.id, exitCode: event.exitCode, ...position }, FRAME_BYTES);
        }
    }
    #ingest(state: ViewState, event: TerminalStreamEvent, bytes: number): void {
        if (!state.alive || state.resync) return;
        if (state.ready) {
            const result = event.kind === 'data' ? state.receiver.data(event) : event.kind === 'exit' ? state.receiver.exit(event) : { kind: 'resync' as const };
            if (result.kind === 'resync') { this.#resync(state, 'terminal output has a gap or a different producer'); return; }
            if (result.kind === 'ignored') return;
            if (event.kind === 'data' && result.kind === 'data') event = { ...event, offset: event.offset + event.data.length - result.data.length, data: result.data };
        }
        this.#enqueue(state, { event, bytes });
    }
    #enqueue(state: ViewState, frame: OutputFrame): void {
        if (state.bytes + frame.bytes > TERMINAL_QUEUE_BYTES) { this.#resync(state, 'terminal view fell behind its bounded output queue'); return; }
        state.queue.push(frame); state.bytes += frame.bytes; this.#schedule(state);
    }
    #resync(state: ViewState, reason: string): void {
        if (!state.alive || state.resync) return;
        state.resync = true; state.queue.clear(); state.bytes = state.activeBytes;
        state.queue.push({ event: { kind: 'resync', id: state.id, reason }, bytes: FRAME_BYTES }); state.bytes += FRAME_BYTES;
        this.#schedule(state);
    }
    #schedule(state: ViewState): void {
        if (state.scheduled || state.running) return;
        state.scheduled = true;
        queueMicrotask(() => { state.scheduled = false; void this.#pump(state); });
    }
    async #pump(state: ViewState): Promise<void> {
        if (!state.alive || !state.ready || state.running) return;
        state.running = true;
        try {
            while (state.alive && state.queue.length) {
                const frame = state.queue.shift()!; state.activeBytes = frame.bytes;
                try { await this.#ports.send(state.owner, state.view, frame.event); }
                catch { if (state.alive) this.unwatch(state.owner, state.view); break; }
                if (!state.alive) break;
                state.bytes -= frame.bytes; state.activeBytes = 0;
            }
        } finally { state.running = false; }
    }
}
