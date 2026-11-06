import { isCookieMessage, type CookieMessage } from '../core/cookie-sync.js';

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
    /** Each site's workspace: its logins are in that workspace's store. */
    readonly workspaceOf: Readonly<Record<string, string>>;
    /** How to start the browser's process: the window knows the install; the host may run from a copy of it (P6). */
    readonly launch: { readonly file: string; readonly args: readonly string[] };
}

export type { SyncedCookie } from '../core/cookie-sync.js';

/** A page in the browser's process, as the `pages` tool needs to read it. */
export interface BrowserPage {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly revision: number;
}

export type BrowserActivation = 'user-gesture' | 'background';

export type BrowserEvent =
    | { readonly kind: 'facts'; readonly facts: BrowserFacts }
    /** Whether a window holds the front door. With none, `.gen` pages cannot load until P5 moves the door to the host. */
    | { readonly kind: 'door'; readonly up: boolean }
    /** `url` null: the browser with its first site. */
    | { readonly kind: 'open'; readonly url: string | null; readonly activation: BrowserActivation }
    | { readonly kind: 'pages'; readonly pages: readonly BrowserPage[] }
    /** A panel's site, alone in its own window (the owner: "a single site ux"). */
    | { readonly kind: 'openSingle'; readonly panelKey: string; readonly url: string }
    | { readonly kind: 'closeSingle'; readonly panelKey: string }
    | { readonly kind: 'poppedBack'; readonly panelKey: string }
    /** One workspace's cookie, between its two stores. Relayed, never kept. */
    | { readonly kind: 'cookies'; readonly from: string; readonly workspaceId: string; readonly message: CookieMessage }
    | { readonly kind: 'cookiesWanted'; readonly from: string; readonly workspaceId: string }
    | { readonly kind: 'browserUp'; readonly up: boolean }
    /** A call into a page, for the browser to run and answer with `pageReply`. */
    | { readonly kind: 'pageCall'; readonly requestId: string; readonly pageId: string; readonly method: string; readonly args: readonly unknown[] }
    /** The host is ending on purpose, and the browser ends with it: an installer needs the binary free. */
    | { readonly kind: 'quit' };

const HELD_LIMIT = 20;
/** A browser started and not linked by then is started again. */
const START_PATIENCE_MS = 20_000;
const PAGE_CALL_LIMIT_MS = 30_000;

function isFacts(value: unknown): value is BrowserFacts {
    if (typeof value !== 'object' || value === null) return false;
    const f = value as Partial<BrowserFacts>;
    return Number.isInteger(f.frontDoorPort) && (f.caPem === null || typeof f.caPem === 'string') && Array.isArray(f.hosts) && f.hosts.every((h) => typeof h === 'string') && typeof f.workspaceOf === 'object' && f.workspaceOf !== null && typeof f.launch?.file === 'string' && Array.isArray(f.launch.args) && f.launch.args.every((a) => typeof a === 'string');
}

export interface BrowserServicePorts {
    readonly startBrowser?: (launch: BrowserFacts['launch']) => void;
    /** Why this host has no Genie browser (P10.1d: plain Node, no Electron to start it with). Absent = it has one. */
    readonly unavailable?: string;
    readonly now?: () => number;
}

export class BrowserService {
    readonly #ports: BrowserServicePorts;
    #startedAt: number | null = null;
    readonly #listeners = new Set<(event: BrowserEvent) => void>();
    #facts: BrowserFacts | null = null;
    #publisher: string | null = null;
    #browser: string | null = null;
    #held: Array<Extract<BrowserEvent, { kind: 'open' | 'openSingle' }>> = [];
    readonly #popped = new Map<string, string>();
    #pages: readonly BrowserPage[] = [];
    readonly #calls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    #nextCall = 1;

    constructor(ports: BrowserServicePorts = {}) {
        this.#ports = ports;
    }

    /** Something is waiting for a browser and none is linked: start one, not twice while one is on its way. */
    #startIfWanted(): void {
        if (this.#ports.unavailable !== undefined || this.#browser !== null || this.#held.length === 0 || this.#facts === null || !this.#ports.startBrowser) return;
        const now = (this.#ports.now ?? Date.now)();
        if (this.#startedAt !== null && now - this.#startedAt < START_PATIENCE_MS) return;
        this.#startedAt = now;
        this.#ports.startBrowser(this.#facts.launch);
    }

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
                this.#startIfWanted();
                return null;
            }
            case 'open': {
                if (this.#ports.unavailable !== undefined) throw new Error(this.#ports.unavailable);
                if (typeof args[0] !== 'string' && args[0] !== null && args[0] !== undefined) throw new Error('an address to open has to be text');
                const event = { kind: 'open' as const, url: args[0] ?? null, activation: args[1] === 'user-gesture' ? 'user-gesture' as const : 'background' as const };
                if (this.#browser === null) {
                    this.#held.push(event);
                    if (this.#held.length > HELD_LIMIT) this.#held.shift();
                    this.#startIfWanted();
                    return { browserUp: false };
                }
                this.#emit(event);
                return { browserUp: true };
            }
            case 'register': {
                if (this.#browser === null) this.#emit({ kind: 'browserUp', up: true });
                this.#browser = from;
                this.#startedAt = null;
                const held = this.#held;
                this.#held = [];
                for (const event of held) this.#emit(event);
                return { facts: this.#facts, doorUp: this.#publisher !== null };
            }
            case 'cookies': {
                if (!isCookieMessage(args[1])) throw new Error('only a .gen cookie crosses');
                this.#emit({ kind: 'cookies', from, workspaceId: String(args[0]), message: args[1] });
                return null;
            }
            case 'browserUp':
                return this.#browser !== null;
            case 'whoami':
                return from;
            case 'cookiesWanted':
                this.#emit({ kind: 'cookiesWanted', from, workspaceId: String(args[0]) });
                return null;
            case 'popOut': {
                if (this.#ports.unavailable !== undefined) throw new Error(this.#ports.unavailable);
                const [panelKey, host] = [String(args[0]), String(args[1]).toLowerCase()];
                if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.gen$/.test(host)) throw new Error('that is not a Genie site');
                this.#popped.set(panelKey, host);
                const event = { kind: 'openSingle' as const, panelKey, url: `https://${host}/` };
                if (this.#browser === null) {
                    this.#held.push(event);
                    if (this.#held.length > HELD_LIMIT) this.#held.shift();
                    this.#startIfWanted();
                    return { browserUp: false };
                }
                this.#emit(event);
                return { browserUp: true };
            }
            case 'popBack': {
                const panelKey = String(args[0]);
                if (!this.#popped.delete(panelKey)) return null;
                this.#held = this.#held.filter((e) => !(e.kind === 'openSingle' && e.panelKey === panelKey));
                this.#emit({ kind: 'closeSingle', panelKey });
                this.#emit({ kind: 'poppedBack', panelKey });
                return null;
            }
            case 'popped':
                return [...this.#popped].map(([panelKey, host]) => ({ panelKey, host }));
            case 'pages': {
                if (from !== this.#browser) throw new Error('only the linked browser says what its pages are');
                this.#pages = Array.isArray(args[0]) ? args[0] as BrowserPage[] : [];
                this.#emit({ kind: 'pages', pages: this.#pages });
                return null;
            }
            case 'pagesNow':
                return this.#pages;
            case 'pageCall': {
                if (this.#ports.unavailable !== undefined) throw new Error(this.#ports.unavailable);
                if (this.#browser === null) throw new Error('the Genie browser is not running');
                const requestId = String(this.#nextCall++);
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { this.#calls.delete(requestId); reject(new Error('the Genie browser did not answer')); }, PAGE_CALL_LIMIT_MS);
                    timer.unref?.();
                    this.#calls.set(requestId, { resolve, reject, timer });
                    this.#emit({ kind: 'pageCall', requestId, pageId: String(args[0]), method: String(args[1]), args: Array.isArray(args[2]) ? args[2] : [] });
                });
            }
            case 'pageReply': {
                if (from !== this.#browser) throw new Error('only the linked browser answers a page call');
                const call = this.#calls.get(String(args[0]));
                if (!call) return null;
                this.#calls.delete(String(args[0]));
                clearTimeout(call.timer);
                if (args[1] === true) call.resolve(args[2]);
                else call.reject(new Error(typeof args[2] === 'string' ? args[2] : 'the page call failed'));
                return null;
            }
            default:
                throw new Error(`the browser service has no ${method}`);
        }
    }

    /** The host is ending. */
    quit(): void {
        this.#emit({ kind: 'quit' });
    }

    /** A connection went. Only the browser's own going means there is no browser. */
    dropped(connection: string): void {
        if (this.#browser === connection) {
            this.#browser = null;
            this.#emit({ kind: 'browserUp', up: false });
            for (const call of this.#calls.values()) { clearTimeout(call.timer); call.reject(new Error('the Genie browser went away')); }
            this.#calls.clear();
            this.#pages = [];
            this.#emit({ kind: 'pages', pages: [] });
            for (const panelKey of [...this.#popped.keys()]) { this.#popped.delete(panelKey); this.#emit({ kind: 'poppedBack', panelKey }); }
        }
        if (this.#publisher === connection) {
            this.#publisher = null;
            this.#emit({ kind: 'door', up: false });
        }
    }
}
