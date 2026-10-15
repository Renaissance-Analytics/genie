/**
 * THE LOOPBACK PORT ALLOCATOR — one for sites and service engines, so two things never share a port.
 *
 * The allocator it replaces counted `++nextPort` from 4100 on every boot. Engines keep the port they were
 * given (services.json records it, and the container publishes it), sites are given a fresh one each
 * boot — so after a restart the second site landed on the port the first engine already held, and the
 * dev server failed to bind (or, worse, bound 127.0.0.1 beside Docker's proxy on a platform that lets
 * it). A port is handed out here only when it is
 *
 *   - not RECORDED by a service instance (read every time — an engine added a minute ago counts),
 *   - not already handed out by this allocator, and
 *   - FREE on 127.0.0.1 when probed (a bind probe — anything else on the machine counts too).
 *
 * The scan is ascending from `first`, so the same records on the same machine give the same ports
 * after a restart. `next()` is synchronous because its callers are (the registry and the site
 * manager take `() => number`), and a bind probe cannot be: so the allocator keeps a small pool of
 * ports PROBED free ahead of time — `prime()` fills it at boot, every `next()` tops it up in the
 * background. If a burst empties the pool before the top-up lands, the next unrecorded, unissued
 * candidate is handed out unprobed and that is SAID (`log`), not hidden.
 */

export interface PortAllocatorDeps {
    /** The first port handed out (inclusive). */
    readonly first: number;
    /** The last port considered (inclusive); past it the allocator refuses, naming the range. */
    readonly last?: number;
    /** Ports something already owns — the service instances' recorded ports. Read on every allocation. */
    readonly reserved: () => Iterable<number>;
    /** Whether a port is free to bind on 127.0.0.1 right now. A rejection counts as "not free". */
    readonly isFree: (port: number) => Promise<boolean>;
    /** How many probed-free ports to keep ready. */
    readonly poolSize?: number;
    readonly log?: (line: string) => void;
}

export class PortAllocator {
    readonly #deps: PortAllocatorDeps;
    readonly #last: number;
    readonly #poolSize: number;
    readonly #issued = new Set<number>();
    readonly #pool: number[] = [];
    #cursor: number;
    #filling: Promise<void> | null = null;

    constructor(deps: PortAllocatorDeps) {
        this.#deps = deps;
        this.#last = deps.last ?? 65_535;
        this.#poolSize = Math.max(1, deps.poolSize ?? 16);
        this.#cursor = deps.first;
    }

    /** Fill the pool with probed-free ports. Await it once at boot, before the first `next()`. */
    prime(): Promise<void> {
        this.#filling ??= this.#fill().finally(() => { this.#filling = null; });
        return this.#filling;
    }

    /** Settles when no top-up is in flight (shutdown, tests). */
    async settled(): Promise<void> {
        while (this.#filling) await this.#filling;
    }

    next(): number {
        const reserved = new Set(this.#deps.reserved());
        while (this.#pool.length > 0) {
            const port = this.#pool.shift()!;
            // Recorded since it was probed (an engine was added): never hand it out.
            if (reserved.has(port) || this.#issued.has(port)) continue;
            this.#issued.add(port);
            void this.prime().catch(() => {});
            return port;
        }
        const port = this.#candidate(reserved);
        this.#issued.add(port);
        this.#deps.log?.(`[ports] ${port} handed out before it could be probed (the pool of probed-free ports was empty)`);
        void this.prime().catch(() => {});
        return port;
    }

    async #fill(): Promise<void> {
        while (this.#pool.length < this.#poolSize) {
            let port: number;
            try {
                port = this.#candidate(new Set(this.#deps.reserved()));
            } catch {
                return; // the range is used up; `next()` will refuse with the reason
            }
            const free = await this.#deps.isFree(port).catch(() => false);
            if (free && !this.#issued.has(port)) this.#pool.push(port);
        }
    }

    /** The next port in the scan that is neither recorded nor issued nor pooled; advances the scan past it. */
    #candidate(reserved: ReadonlySet<number>): number {
        while (this.#cursor <= this.#last) {
            const port = this.#cursor++;
            if (reserved.has(port) || this.#issued.has(port) || this.#pool.includes(port)) continue;
            return port;
        }
        throw new Error(`no loopback port left between ${this.#deps.first} and ${this.#last}`);
    }
}
