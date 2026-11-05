/**
 * THE GENIE BROWSER'S PROCESS, AS THE HOST SEES IT (the host split, P2b; decision 5). The window and the browser never talk
 * directly: each is a client of the host, so either can go without the other. The window says what the browser needs (the
 * front door's port and Genie's CA, which are the window's until P5) and what to open; what comes before a browser has
 * linked is held here, bounded. Nothing here is secret: a CA certificate, a port and site names.
 */

export interface BrowserFacts {
    readonly frontDoorPort: number;
    readonly caPem: string | null;
    readonly hosts: readonly string[];
}

export type BrowserActivation = 'user-gesture' | 'background';

export type BrowserEvent =
    | { readonly kind: 'facts'; readonly facts: BrowserFacts }
    /** Whether a window holds the front door. With none, `.gen` pages cannot load until P5 moves the door to the host. */
    | { readonly kind: 'door'; readonly up: boolean }
    | { readonly kind: 'open'; readonly url: string; readonly activation: BrowserActivation };

const HELD_LIMIT = 20;

function isFacts(value: unknown): value is BrowserFacts {
    if (typeof value !== 'object' || value === null) return false;
    const f = value as Partial<BrowserFacts>;
    return Number.isInteger(f.frontDoorPort) && (f.caPem === null || typeof f.caPem === 'string') && Array.isArray(f.hosts) && f.hosts.every((h) => typeof h === 'string');
}

export class BrowserService {
    readonly #listeners = new Set<(event: BrowserEvent) => void>();
    #facts: BrowserFacts | null = null;
    #publisher: string | null = null;
    #browser: string | null = null;
    #held: Array<Extract<BrowserEvent, { kind: 'open' }>> = [];

    onEvent(listener: (event: BrowserEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #emit(event: BrowserEvent): void {
        for (const listener of [...this.#listeners]) listener(event);
    }

    /** `from`: the connection that asked, so the browser's going can be told from a window's. */
    async call(method: string, args: readonly unknown[], from: string): Promise<unknown> {
        switch (method) {
            case 'publish': {
                if (!isFacts(args[0])) throw new Error('those are not the facts a browser needs');
                this.#facts = args[0];
                const wasDown = this.#publisher === null;
                this.#publisher = from;
                this.#emit({ kind: 'facts', facts: this.#facts });
                if (wasDown) this.#emit({ kind: 'door', up: true });
                return null;
            }
            case 'open': {
                if (typeof args[0] !== 'string') throw new Error('an address to open has to be text');
                const event = { kind: 'open' as const, url: args[0], activation: args[1] === 'user-gesture' ? 'user-gesture' as const : 'background' as const };
                if (this.#browser === null) {
                    this.#held.push(event);
                    if (this.#held.length > HELD_LIMIT) this.#held.shift();
                    return { browserUp: false };
                }
                this.#emit(event);
                return { browserUp: true };
            }
            case 'register': {
                this.#browser = from;
                const held = this.#held;
                this.#held = [];
                for (const event of held) this.#emit(event);
                return { facts: this.#facts, doorUp: this.#publisher !== null };
            }
            default:
                throw new Error(`the browser service has no ${method}`);
        }
    }

    /** A connection went. Only the browser's own going means there is no browser. */
    dropped(connection: string): void {
        if (this.#browser === connection) this.#browser = null;
        if (this.#publisher === connection) {
            this.#publisher = null;
            this.#emit({ kind: 'door', up: false });
        }
    }
}
