import { randomUUID } from 'node:crypto';
import { limitRefusal } from '../core/shell-limits.js';
import type { PtyOpened, Terminal, TerminalHost, TerminalOptions } from './terminal-host.js';

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
    /** Each listed workspace's terminal limit, so a window refuses the next one by name before it asks. */
    readonly limits: Readonly<Record<string, number>>;
}

export type TerminalsEvent =
    | { readonly kind: 'list'; readonly terminals: readonly Terminal[]; readonly limits: Readonly<Record<string, number>> }
    | { readonly kind: 'data'; readonly id: string; readonly data: string }
    | { readonly kind: 'exit'; readonly id: string; readonly code: number };

const WINDOW_CALLS = new Set(['open', 'openReady', 'write', 'resize', 'close']);
/** How much of a terminal's output a window keeps for a pane that joins it. */
const TAIL_MAX = 262_144;

export class TerminalsService {
    readonly #terminals: TerminalHost;
    readonly #listeners = new Set<(event: TerminalsEvent) => void>();

    constructor(terminals: TerminalHost) {
        this.#terminals = terminals;
        terminals.onChange(() => this.#emit({ kind: 'list', terminals: terminals.list(), limits: this.#limits() }));
        terminals.onData((id, data) => this.#emit({ kind: 'data', id, data }));
        terminals.onExit((id, code) => this.#emit({ kind: 'exit', id, code }));
    }

    get terminals(): TerminalHost {
        return this.#terminals;
    }

    dump(): TerminalsDump {
        const list = this.#terminals.list();
        return { terminals: list, tails: Object.fromEntries(list.map((t) => [t.id, this.#terminals.scrollback(t.id) ?? ''])), limits: this.#limits() };
    }

    onEvent(listener: (event: TerminalsEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        if (!WINDOW_CALLS.has(method)) throw new Error(`a window cannot call terminals.${method}`);
        const t = this.#terminals;
        switch (method) {
            case 'open': return t.open(args[0] as TerminalOptions);
            case 'openReady': return t.openReady(args[0] as TerminalOptions);
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
    /** Opened here and not listed by the host yet: typed into already (the pane opened at once). */
    readonly #pending = new Set<string>();
    readonly #dataListeners = new Set<(id: string, data: string) => void>();
    readonly #exitListeners = new Set<(id: string, code: number) => void>();
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) {
        this.#call = call;
    }

    rebase(dump: TerminalsDump): void {
        this.#list = dump.terminals;
        this.#limits = dump.limits;
        this.#tails.clear();
        for (const [id, text] of Object.entries(dump.tails)) this.#tails.set(id, text);
    }

    apply(event: TerminalsEvent): void {
        if (event.kind === 'list') {
            this.#list = event.terminals;
            this.#limits = event.limits;
            for (const t of event.terminals) this.#pending.delete(t.id);
            return;
        }
        if (event.kind === 'data') {
            const tail = (this.#tails.get(event.id) ?? '') + event.data;
            this.#tails.set(event.id, tail.length > TAIL_MAX ? tail.slice(-TAIL_MAX) : tail);
            for (const l of [...this.#dataListeners]) l(event.id, event.data);
            return;
        }
        this.#list = this.#list.filter((t) => t.id !== event.id);
        this.#pending.delete(event.id);
        for (const l of [...this.#exitListeners]) l(event.id, event.code);
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
        void this.#call('open', [{ ...options, id }]).catch((error: unknown) => {
            this.#pending.delete(id);
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
        return (await this.#call('openReady', [{ ...options, id: options.id ?? `term_${randomUUID()}` }])) as PtyOpened;
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
        void this.#call('close', [id]).catch(() => {});
        return true;
    }

    scrollback(id: string): string | undefined {
        return this.#list.some((t) => t.id === id) ? this.#tails.get(id) ?? '' : undefined;
    }

    attach(id: string): { id: string; pid: number; shell: string; workspaceId: string; scrollback: string } | null {
        const t = this.#list.find((x) => x.id === id);
        return t ? { id: t.id, pid: t.pid, shell: t.shell, workspaceId: t.workspaceId, scrollback: this.#tails.get(id) ?? '' } : null;
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

    onData(listener: (id: string, data: string) => void): () => void {
        this.#dataListeners.add(listener);
        return () => { this.#dataListeners.delete(listener); };
    }

    onExit(listener: (id: string, code: number) => void): () => void {
        this.#exitListeners.add(listener);
        return () => { this.#exitListeners.delete(listener); };
    }
}
