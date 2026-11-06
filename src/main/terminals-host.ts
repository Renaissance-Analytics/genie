import { randomUUID } from 'node:crypto';
import { limitRefusal } from '../core/shell-limits.js';
import type { PtyOpened, Terminal, TerminalHost, TerminalOptions } from './terminal-host.js';
import { terminalPosition, terminalDataPosition } from '../core/terminal-stream.js';
import type { TerminalPosition, TerminalDataPosition, TerminalStreamSnapshot } from '../core/terminal-stream.js';

/**
 * THE TERMINALS, GENIE-HOST'S (the host split, P3.3e: plan §11e). Their shells run under the host's own `terminals` spawn
 * host, so a terminal — and what it printed — outlives the window, and an agent's `manageTerminals` works with no window.
 * A window drives them through `TerminalsReplica`: it mints a terminal's id itself, so a pane opens the moment it asks;
 * its list, scrollback and working directory read synchronously; its output streams as it comes.
 */

export interface TerminalsDump {
    readonly terminals: readonly Terminal[];
    /** Each live terminal's output so far (its scrollback). */
    readonly tails: Readonly<Record<string, string>>;
    /** Only producer-authoritative positions. Missing means resync, including dumps from an older engine. */
    readonly positions?: Readonly<Record<string, TerminalPosition>>;
    /** Each listed workspace's terminal limit, so a window refuses the next one by name before it asks. */
    readonly limits: Readonly<Record<string, number>>;
}

/**
 * `owner`: the window connection a DISPOSABLE terminal's output and end go to, and only that one (Tynn story #378) — no
 * other window keeps any of it. Absent = every window.
 */
export type TerminalsEvent =
    | { readonly kind: 'list'; readonly terminals: readonly Terminal[]; readonly limits: Readonly<Record<string, number>> }
    | ({ readonly kind: 'data'; readonly id: string; readonly data: string; readonly owner?: string } & Partial<TerminalDataPosition>)
    | ({ readonly kind: 'exit'; readonly id: string; readonly code: number; readonly owner?: string } & Partial<TerminalPosition>);

const WINDOW_CALLS = new Set(['open', 'openReady', 'write', 'resize', 'close']);
/** How much of a terminal's output a window keeps for a pane that joins it. */
const TAIL_MAX = 262_144;

export class TerminalsService {
    readonly #terminals: TerminalHost;
    readonly #listeners = new Set<(event: TerminalsEvent) => void>();
    /** Each live DISPOSABLE terminal's window connection (Tynn story #378): it ends when that connection goes. */
    readonly #owners = new Map<string, string>();

    constructor(terminals: TerminalHost) {
        this.#terminals = terminals;
        terminals.onChange(() => this.#emit({ kind: 'list', terminals: terminals.list(), limits: this.#limits() }));
        terminals.onData((id, data, position) => { const owner = this.#owners.get(id); this.#emit({ kind: 'data', id, data, ...position, ...(owner === undefined ? {} : { owner }) }); });
        terminals.onExit((id, code, position) => {
            const owner = this.#owners.get(id);
            this.#owners.delete(id);
            this.#emit({ kind: 'exit', id, code, ...position, ...(owner === undefined ? {} : { owner }) });
        });
    }

    /**
     * A window's connection closed: every disposable terminal it opened is closed with it — the window that was its only
     * way in is gone, and nothing re-attaches one (Tynn story #378). Answers how many.
     */
    dropped(owner: string): number {
        const mine = [...this.#owners].filter(([, o]) => o === owner).map(([id]) => id);
        for (const id of mine) { this.#owners.delete(id); this.#terminals.close(id); }
        return mine.length;
    }

    get terminals(): TerminalHost {
        return this.#terminals;
    }

    dump(): TerminalsDump {
        const list = this.#terminals.list();
        const positions: Record<string, TerminalPosition> = Object.create(null) as Record<string, TerminalPosition>;
        for (const t of list) { const position = terminalPosition(this.#terminals.streamSnapshot(t.id)); if (position) positions[t.id] = position; }
        return { terminals: list, tails: Object.fromEntries(list.map((t) => [t.id, this.#terminals.scrollback(t.id) ?? ''])), positions, limits: this.#limits() };
    }

    onEvent(listener: (event: TerminalsEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A window's call; `owner` is its connection, which a disposable terminal it opens belongs to. */
    async call(method: string, args: readonly unknown[], owner?: string): Promise<unknown> {
        if (!WINDOW_CALLS.has(method)) throw new Error(`a window cannot call terminals.${method}`);
        const t = this.#terminals;
        switch (method) {
            case 'open':
            case 'openReady': {
                const options = args[0] as TerminalOptions;
                // Owned BEFORE it opens, so its first output already goes to its window alone.
                if (options.disposable && owner !== undefined && typeof options.id === 'string') this.#owners.set(options.id, owner);
                try {
                    return method === 'open' ? t.open(options) : await t.openReady(options);
                } catch (error) {
                    if (typeof options.id === 'string') this.#owners.delete(options.id);
                    throw error;
                }
            }
            case 'write': return t.write(String(args[0]), String(args[1]));
            case 'resize': return t.resize(String(args[0]), Number(args[1]), Number(args[2]));
            default: return t.close(String(args[0]));
        }
    }

    #limits(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const t of this.#terminals.list()) {
            if (t.workspaceId in out) continue;
            const limit = this.#terminals.limitFor(t.workspaceId);
            if (limit !== null) out[t.workspaceId] = limit;
        }
        return out;
    }

    #emit(event: TerminalsEvent): void {
        for (const l of [...this.#listeners]) {
            try { l(event); } catch { /* one window's listener never costs another's */ }
        }
    }
}

/** The terminals as a window and its features use them: genie-host's through the replica, or a TerminalHost of its own on the emergency path. */
export type TerminalsApi = Pick<TerminalsReplica, 'open' | 'openReady' | 'write' | 'resize' | 'close' | 'list' | 'scrollback' | 'attach' | 'lastCwd' | 'refusal' | 'onData' | 'onExit' | 'count' | 'closeAll'> & { finished(id: string): { workspaceId: string; exitCode: number } | null };

/** genie-host's terminals, as a window drives them (P3.3e). */
export class TerminalsReplica {
    #list: readonly Terminal[] = [];
    #limits: Readonly<Record<string, number>> = {};
    readonly #tails = new Map<string, string>();
    readonly #positions = new Map<string, TerminalPosition | null>();
    /** Opened here and not listed by the host yet: typed into already (the pane opened at once). */
    readonly #pending = new Set<string>();
    /** This window's live DISPOSABLE terminals (never listed), id to workspace: forgotten, output and all, when they go. */
    readonly #disposable = new Map<string, string>();
    readonly #dataListeners = new Set<(id: string, data: string, position?: TerminalDataPosition) => void>();
    readonly #exitListeners = new Set<(id: string, code: number, position?: TerminalPosition) => void>();
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) {
        this.#call = call;
    }

    rebase(dump: TerminalsDump): void {
        this.#list = dump.terminals;
        this.#limits = dump.limits;
        this.#tails.clear();
        for (const [id, text] of Object.entries(dump.tails)) this.#tails.set(id, text);
        this.#positions.clear();
        for (const [id, value] of Object.entries(dump.positions ?? {})) {
            const position = terminalPosition(value);
            if (position && position.endOffset >= (dump.tails[id]?.length ?? 0)) this.#positions.set(id, position);
        }
    }

    apply(event: TerminalsEvent): void {
        if (event.kind === 'list') {
            this.#list = event.terminals;
            this.#limits = event.limits;
            for (const t of event.terminals) this.#pending.delete(t.id);
            for (const id of this.#positions.keys()) if (!this.#pending.has(id) && !this.#disposable.has(id) && !event.terminals.some(t => t.id === id)) this.#positions.delete(id);
            return;
        }
        if (event.kind === 'data') {
            const before = this.#tails.get(event.id) ?? '', tail = before + event.data;
            const position = terminalDataPosition(event, event.data), held = this.#positions.get(event.id);
            this.#positions.set(event.id, position && ((held === undefined && before.length === 0 && position.offset === 0) || (held?.epoch === position.epoch && held.endOffset === position.offset))
                ? { epoch: position.epoch, endOffset: position.endOffset } : null);
            this.#tails.set(event.id, tail.length > TAIL_MAX ? tail.slice(-TAIL_MAX) : tail);
            for (const l of [...this.#dataListeners]) { if (position) l(event.id, event.data, position); else l(event.id, event.data); }
            return;
        }
        this.#list = this.#list.filter((t) => t.id !== event.id);
        this.#pending.delete(event.id);
        this.#positions.delete(event.id);
        if (this.#disposable.delete(event.id)) this.#tails.delete(event.id);
        const position = terminalPosition(event);
        for (const l of [...this.#exitListeners]) { if (position) l(event.id, event.code, position); else l(event.id, event.code); }
    }

    get count(): number { return this.#list.length; }
    list(): readonly Terminal[] { return this.#list; }

    /** Why one more terminal would be refused here (its limit and what is running), or null — before anyone is asked. */
    refusal(workspaceId: string): string | null {
        const limit = this.#limits[workspaceId];
        if (limit === undefined) return null;
        const running = this.#list.filter((t) => t.workspaceId === workspaceId && !t.unlimited);
        return limitRefusal('terminals', limit, running.map((t) => `${t.shell.split(/[\\/]/).pop() || t.shell} (pid ${t.pid})`));
    }

    /** Opened in the host; answered at once with the id minted here, so a pane opens without waiting. */
    open(options: TerminalOptions): PtyOpened {
        if (options.limited !== false) {
            const refused = this.refusal(options.workspaceId);
            if (refused) throw new Error(refused);
        }
        const id = options.id ?? `term_${randomUUID()}`;
        this.#pending.add(id);
        if (options.disposable) this.#disposable.set(id, options.workspaceId);
        void this.#call('open', [{ ...options, id }]).catch((error: unknown) => {
            this.#pending.delete(id);
            if (this.#disposable.delete(id)) this.#tails.delete(id);
            // Refused in the host (its limit, a shell that cannot start): said in the pane, and the pane ends.
            const why = error instanceof Error ? error.message : String(error);
            for (const l of [...this.#dataListeners]) l(id, `[genie] the terminal did not open: ${why}\r\n`);
            for (const l of [...this.#exitListeners]) l(id, -1);
        });
        return { id, pid: 0, shell: options.command ?? '', scrollback: '' };
    }

    /** Opened in the host, answered once its pid and shell are known. */
    async openReady(options: TerminalOptions): Promise<PtyOpened> {
        if (options.limited !== false) {
            const refused = this.refusal(options.workspaceId);
            if (refused) throw new Error(refused);
        }
        const id = options.id ?? `term_${randomUUID()}`;
        if (!options.disposable) return (await this.#call('openReady', [{ ...options, id }])) as PtyOpened;
        // Known here before it opens: never listed, its output is joined by its own window alone.
        this.#pending.add(id);
        this.#disposable.set(id, options.workspaceId);
        try {
            return (await this.#call('openReady', [{ ...options, id }])) as PtyOpened;
        } catch (error) {
            this.#pending.delete(id);
            this.#disposable.delete(id);
            this.#tails.delete(id);
            throw error;
        }
    }

    #known(id: string): boolean {
        return this.#pending.has(id) || this.#list.some((t) => t.id === id);
    }

    write(id: string, data: string): boolean {
        if (!this.#known(id)) return false;
        void this.#call('write', [id, data]).catch(() => {});
        return true;
    }

    resize(id: string, cols: number, rows: number): boolean {
        if (!this.#known(id)) return false;
        void this.#call('resize', [id, cols, rows]).catch(() => {});
        return true;
    }

    close(id: string): boolean {
        if (!this.#known(id)) return false;
        this.#list = this.#list.filter((t) => t.id !== id);
        this.#pending.delete(id);
        if (this.#disposable.delete(id)) this.#tails.delete(id);
        void this.#call('close', [id]).catch(() => {});
        return true;
    }

    scrollback(id: string): string | undefined {
        return this.#list.some((t) => t.id === id) || this.#disposable.has(id) ? this.#tails.get(id) ?? '' : undefined;
    }

    attach(id: string): { id: string; pid: number; shell: string; workspaceId: string; scrollback: string } | null {
        // This window's own disposable terminal: its window joins it (and nothing else lists it).
        const scratch = this.#disposable.get(id);
        if (scratch !== undefined) return { id, pid: 0, shell: '', workspaceId: scratch, scrollback: this.#tails.get(id) ?? '' };
        const t = this.#list.find((x) => x.id === id);
        return t ? { id: t.id, pid: t.pid, shell: t.shell, workspaceId: t.workspaceId, scrollback: this.#tails.get(id) ?? '' } : null;
    }

    streamSnapshot(id: string): TerminalStreamSnapshot | null {
        const attached = this.attach(id);
        return attached ? { id, tail: attached.scrollback, ...(this.#positions.get(id) ?? { epoch: null, endOffset: null }) } : null;
    }

    /** An ended terminal's record is the host's (the agents' \`manageTerminals read\`); the window keeps none. */
    finished(): null { return null; }

    lastCwd(workspaceId: string): string | null {
        const reported = this.#list.filter((t) => t.workspaceId === workspaceId && t.cwd !== undefined);
        if (reported.length === 0) return null;
        return reported.reduce((a, b) => ((a.cwdAt ?? 0) >= (b.cwdAt ?? 0) ? a : b)).cwd ?? null;
    }

    /** Every terminal ended (a full quit, §7.1): each is closed in the host. Answers how many. */
    closeAll(): number {
        const ids = [...this.#list.map((t) => t.id), ...this.#pending];
        for (const id of ids) this.close(id);
        return ids.length;
    }

    /** What a previous window left running is the host's own since P3.3e: nothing to take back. */
    adopt(): void {}

    onData(listener: (id: string, data: string, position?: TerminalDataPosition) => void): () => void {
        this.#dataListeners.add(listener);
        return () => { this.#dataListeners.delete(listener); };
    }

    onExit(listener: (id: string, code: number, position?: TerminalPosition) => void): () => void {
        this.#exitListeners.add(listener);
        return () => { this.#exitListeners.delete(listener); };
    }
}
