import { ensureWorkstation, identityFrom, type EnsureWorkstationPorts, type EnsureWorkstationResult, type IdentityStore, type LegacyIdentity, type WorkstationIdentity } from './workstation-identity.js';

/**
 * THIS MACHINE'S KEY, AND WHAT IT SIGNS, ARE THE HOST'S (P3.4; plan §13). The relay lives in the window until P5, so a window asks the host to sign. No method returns the key, and an
 * unlisted method is refused. The window sends one thing the other way: Genie 1's record of this machine, which only it can open, until that record is settled with Tynn.
 */
export interface WorkstationServiceOptions {
    readonly store: IdentityStore;
    readonly request: EnsureWorkstationPorts['request'];
    readonly host: () => string;
    readonly hostname: () => string;
    readonly machineKey: () => Promise<string | null>;
    /** The clock; absent = the system's. */
    readonly now?: () => number;
    /** What each registration sent and what Tynn answered, for the lifecycle log (beta.61.1). */
    readonly log?: (line: string) => void;
}

/** The answers a window, or a window's own engine, reads. */
export interface WorkstationPort {
    identity(host: string): Promise<{ readonly workstationId: string; readonly fingerprint: string } | null>;
    sign(host: string, data: Buffer): Promise<Buffer>;
    authHeader(host: string): Promise<string>;
    ensure(options: { readonly host: string; readonly legacy?: LegacyIdentity | null }): Promise<EnsureWorkstationResult>;
    legacyDone(host: string): Promise<string | null>;
}

export class WorkstationService implements WorkstationPort {
    readonly #options: WorkstationServiceOptions;
    /** Read once per key: making one parses it, and signing happens at each relay hello and ticket. */
    readonly #identities = new Map<string, { pem: string; identity: WorkstationIdentity }>();

    constructor(options: WorkstationServiceOptions) { this.#options = options; }

    async #identity(host: string): Promise<WorkstationIdentity | null> {
        const stored = await this.#options.store.read(host);
        if (!stored) { this.#identities.delete(host); return null; }
        const held = this.#identities.get(host);
        if (held?.pem === stored.privateKeyPem) return held.identity;
        const identity = identityFrom(stored);
        this.#identities.set(host, { pem: stored.privateKeyPem, identity });
        return identity;
    }

    async #must(host: string): Promise<WorkstationIdentity> {
        const identity = await this.#identity(host);
        if (!identity) throw new Error('This machine is not registered with that Tynn.');
        return identity;
    }

    async identity(host: string): Promise<{ workstationId: string; fingerprint: string } | null> {
        const identity = await this.#identity(host);
        return identity ? { workstationId: identity.workstationId, fingerprint: identity.fingerprint } : null;
    }

    async sign(host: string, data: Buffer): Promise<Buffer> { return (await this.#must(host)).sign(data); }
    async authHeader(host: string): Promise<string> { return (await this.#must(host)).authHeader(); }

    /*
     * ONE REGISTRATION AT A TIME, AND NO PROOF TWICE (beta.61.1). Tynn takes a re-attach proof once, and a request whose
     * proof it does not accept is the same machine registering unproven: a drone. The proof signs a time in whole seconds,
     * so two registrations in one second were one proof. Each waits for the one before, and each proof's second is its own.
     */
    #registering: Promise<unknown> = Promise.resolve();
    #lastProofSecond = 0;

    ensure(options: { readonly host: string; readonly legacy?: LegacyIdentity | null }): Promise<EnsureWorkstationResult> {
        const run = this.#registering.then(() => this.#ensureOne(options));
        this.#registering = run.catch(() => {});
        return run;
    }

    #ensureOne(options: { readonly host: string; readonly legacy?: LegacyIdentity | null }): Promise<EnsureWorkstationResult> {
        const legacy = options.legacy ?? null;
        const clock = this.#options.now ?? Date.now;
        const request: EnsureWorkstationPorts['request'] = async (path, init) => {
            if (path !== '/api/v1/workstations/self-register') return this.#options.request(path, init);
            const proof = (init.body as { proof?: { workstation_id?: unknown } } | undefined)?.proof;
            const sent = proof ? `proved (${String(proof.workstation_id)})` : 'unproven (nothing on record)';
            try {
                const res = await this.#options.request(path, init);
                if (!res.ok) { this.#options.log?.(`tynn registration: ${sent}; Tynn refused it, HTTP ${res.status}`); return res; }
                // Read once here for the log, and handed on as read.
                const body = (await res.json().catch(() => null)) as { workstation?: { id?: unknown }; enrollment?: unknown } | null;
                this.#options.log?.(`tynn registration: ${sent}; Tynn answered HTTP ${res.status}, workstation ${String(body?.workstation?.id ?? 'none')}, ${body?.enrollment ? 'a new enrollment' : 'no new enrollment'}`);
                return { ok: res.ok, status: res.status, json: async () => body };
            } catch (error) {
                this.#options.log?.(`tynn registration: ${sent}; Tynn was not reached: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
            }
        };
        return ensureWorkstation({
            host: () => options.host,
            hostname: this.#options.hostname,
            request,
            store: this.#options.store,
            machineKey: this.#options.machineKey,
            legacy: async () => legacy,
            // Each proof's second is later than the last one's, so no two proofs are the same signature.
            now: () => {
                const second = Math.max(Math.floor(clock() / 1000), this.#lastProofSecond + 1);
                this.#lastProofSecond = second;
                return second * 1000;
            },
        });
    }

    async legacyDone(host: string): Promise<string | null> { return (await this.#options.store.legacyDone?.(host)) ?? null; }

    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        const host = String(args[0] ?? '');
        switch (method) {
            case 'identity': return this.identity(host);
            case 'sign': return (await this.sign(host, Buffer.from(String(args[1] ?? ''), 'base64'))).toString('base64');
            case 'authHeader': return this.authHeader(host);
            case 'ensure': return this.ensure(args[0] as { host: string; legacy?: LegacyIdentity | null });
            case 'legacyDone': return this.legacyDone(host);
            default: throw new Error(`The workstation has no ${method}.`);
        }
    }
}
