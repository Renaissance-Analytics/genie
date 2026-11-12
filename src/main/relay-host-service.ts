import { effectiveRoleOf, type WorkstationRole } from '../core/workstation-role.js';
import type { TynnWorkstationState } from '../renderer/features.js';
import type { RelayHostHandle, RelayHostStatus } from './tynn-network.js';
import type { LegacyIdentity } from './workstation-identity.js';
import type { readWorkstationRole } from './workstation-role-reader.js';
import type { WorkstationPort } from './workstation-service.js';

type TynnRequest = Parameters<typeof readWorkstationRole>[0];

/**
 * THIS MACHINE ON THE TYNN RELAY, AS A HOST (Tynn #410, host split P5d.3; the host side of `genie.relay-host`). Its
 * registration with Tynn, the role Tynn gives it, and the relay link run in genie-host, so a Pilot reaches this machine with
 * every window closed. A window reads them through its replica and hands over Genie 1's record, which only it can open.
 */
export interface RelayHostServicePorts {
    /** The Tynn account in use, once it is open. */
    readonly account: () => { host(): string; status(): { signedIn: boolean }; readonly request: TynnRequest } | null;
    readonly workstation: Pick<WorkstationPort, 'identity' | 'ensure' | 'legacyDone'>;
    /** The `remote_access` setting. */
    readonly enabled: () => boolean;
    /** Tynn's role for this sign-in. `unbound`: Tynn answered, and this sign-in is not bound to a workstation (its own null). */
    readonly readRole: (request: TynnRequest) => Promise<WorkstationRole | null | { readonly role: WorkstationRole | null; readonly unbound?: boolean }>;
    /** Start the link on this identity (`startRelayHost`, wired in genie-host). */
    readonly start: (input: { host: string; workstationId: string; fingerprint: string; onStatus: (status: RelayHostStatus) => void }) => RelayHostHandle;
    readonly onChange: () => void;
    /** A timer, for reading the role again when Tynn did not answer. Absent = only the callers' own reads. */
    readonly schedule?: (ms: number, fn: () => void) => () => void;
}

/** How long before the role is read again after no answer: 5 s, 15 s, 1 min, then every 5 min until Tynn answers. */
const ROLE_RETRY_MS = [5_000, 15_000, 60_000, 300_000] as const;

export interface RelayHostView {
    readonly workstation: TynnWorkstationState | null;
    readonly role: WorkstationRole | null;
    /** What Tynn answered, `null` = no answer yet: what a window shows, and what tells a drone from "not known". */
    readonly said?: WorkstationRole | null;
    /** Why the role is not known, in words a person can act on, when genie-host knows; `null` = a read that got no answer. */
    readonly unknownWhy?: string | null;
    readonly relay: RelayHostStatus;
}

export class RelayHostService {
    readonly #ports: RelayHostServicePorts;
    #workstation: TynnWorkstationState | null = null;
    /** A drone until Tynn's first answer (fail closed): what connecting out is gated on. */
    #role: WorkstationRole | null = 'drone';
    /**
     * What Tynn SAID, and nothing else: what a window shows (beta.61.1). A Pilot whose read had not answered, or had failed,
     * was shown as a drone and lost its host picker; showing is not the boundary (Tynn refuses a drone, and connecting out
     * still reads `#role`).
     */
    #said: WorkstationRole | null = null;
    #unbound = false;
    #retries = 0;
    #registerRetries = 0;
    #registerWaiting = false;
    #retryWaiting = false;
    #cancelRetry: () => void = () => {};
    #relay: RelayHostStatus = { state: 'off' };
    #handle: RelayHostHandle | null = null;
    #relayFor: string | null = null;
    #registering: Promise<void> | null = null;
    #legacy: LegacyIdentity | null = null;
    #again = false;

    constructor(ports: RelayHostServicePorts) { this.#ports = ports; }

    status(): RelayHostView { return { workstation: this.#workstation, role: this.#role, said: this.#said, unknownWhy: this.unknownWhy(), relay: this.#relay }; }

    /** Why connecting out cannot be decided, when it is not "Tynn did not answer" (beta.61.1): true words, with what to do. */
    unknownWhy(): string | null {
        if (this.#said !== null || this.#role === null) return null;
        if (this.#workstation && !this.#workstation.registered) return `This machine is not registered with Tynn, so it did not connect: ${this.#workstation.reason}`;
        if (this.#unbound) return 'Tynn says this sign-in is not attached to this workstation yet, so Genie did not connect. Genie is attaching it again; try again in a moment. If this stays, sign out of Tynn in Genie and sign in again.';
        return null;
    }
    said(): WorkstationRole | null { return this.#said; }
    role(): WorkstationRole | null { return this.#role; }

    /** Register with the Tynn in use, one at a time. Genie 1's record arriving during a run gets a run of its own. */
    register(legacy: LegacyIdentity | null = null): Promise<void> {
        if (legacy) { this.#legacy = legacy; this.#again = this.#registering !== null; }
        this.#registering ??= (async () => {
            do { this.#again = false; await this.#registerOnce(); } while (this.#again);
        })().finally(() => { this.#registering = null; });
        return this.#registering;
    }

    async #registerOnce(): Promise<void> {
        const account = this.#ports.account();
        if (!account) return;
        const host = account.host();
        if (!account.status().signedIn) {
            this.#workstation = { registered: false, reason: 'sign in to Tynn to register this machine', role: null };
        } else {
            const legacy = this.#legacy;
            this.#legacy = null;
            const settled = legacy ? await this.#ports.workstation.legacyDone(host).catch(() => null) : null;
            const result = await this.#ports.workstation.ensure({ host, legacy: legacy && legacy.workstationId !== settled ? legacy : null })
                .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
            // Not registered (a key that could not be read, Tynn not reached): tried again by itself, backing off.
            if (!result.ok) this.#registerLater(); else { this.#registerRetries = 0; }
            this.#workstation = result.ok ? { registered: true, host, workstationId: result.workstationId, role: this.#said } : { registered: false, reason: result.reason, role: this.#said };
        }
        await this.readRole();
        await this.apply();
        this.#ports.onChange();
    }

    /** What Tynn says this machine is: Tynn's answer only; signed in, no answer is a drone. */
    async readRole(): Promise<void> {
        const account = this.#ports.account();
        const signedIn = account?.status().signedIn === true;
        // A read that fails is no answer: connecting out fails closed, and nothing is said in the window's name.
        const answer = signedIn && account ? await this.#ports.readRole((path, init) => account.request(path, init)).catch(() => null) : null;
        const role = answer !== null && typeof answer === 'object' ? answer.role : answer;
        const unbound = answer !== null && typeof answer === 'object' && answer.unbound === true && role === null;
        const next = signedIn ? effectiveRoleOf({ signedIn: true, role }) : effectiveRoleOf({ signedIn: false });
        // Signed in and unanswered: read again by itself, backing off, so a slow or failed first read is not the session's.
        if (signedIn && role === null) this.#readRoleLater();
        else { this.#retries = 0; this.#cancelRetry(); this.#cancelRetry = () => {}; this.#retryWaiting = false; }
        if (next === this.#role && role === this.#said && unbound === this.#unbound) return;
        this.#role = next;
        this.#said = role;
        this.#unbound = unbound;
        if (this.#workstation) this.#workstation = { ...this.#workstation, role };
        this.#ports.onChange();
    }

    #registerLater(): void {
        if (!this.#ports.schedule || this.#registerWaiting) return;
        this.#registerWaiting = true;
        const wait = ROLE_RETRY_MS[Math.min(this.#registerRetries, ROLE_RETRY_MS.length - 1)]!;
        this.#registerRetries += 1;
        this.#ports.schedule(wait, () => { this.#registerWaiting = false; void this.register().catch(() => {}); });
    }

    #readRoleLater(): void {
        if (!this.#ports.schedule || this.#retryWaiting) return;
        this.#retryWaiting = true;
        const wait = ROLE_RETRY_MS[Math.min(this.#retries, ROLE_RETRY_MS.length - 1)]!;
        this.#retries += 1;
        // With a workstation on record, no role may mean this sign-in is not bound to it: register again (its proof attaches
        // it), which reads the role again. With none, only the read.
        this.#cancelRetry = this.#ports.schedule(wait, () => {
            this.#retryWaiting = false;
            if (this.#workstation?.registered) void this.register().catch(() => {}); else void this.readRole();
        });
    }

    /** The link follows the switch and the registration: on while `remote_access` is on and this machine is registered. */
    async apply(): Promise<void> {
        const registered = this.#workstation?.registered ? this.#workstation : null;
        const want = registered && this.#ports.account() && this.#ports.enabled() ? `${registered.host} ${registered.workstationId}` : null;
        if (want === this.#relayFor) return;
        this.#stopLink();
        this.#relayFor = want;
        if (!want || !registered) { this.#ports.onChange(); return; }
        const identity = await this.#ports.workstation.identity(registered.host).catch(() => null);
        if (!identity || this.#relayFor !== want) { this.#ports.onChange(); return; }
        this.#handle = this.#ports.start({
            host: registered.host, workstationId: identity.workstationId, fingerprint: identity.fingerprint,
            onStatus: (status) => { this.#relay = status; this.#ports.onChange(); },
        });
        this.#ports.onChange();
    }

    stop(): void {
        this.#stopLink();
        this.#relayFor = null;
        this.#ports.onChange();
    }

    #stopLink(): void {
        this.#handle?.stop();
        this.#handle = null;
        this.#relay = { state: 'off' };
    }

    /** From a local window, over `engine.relayHost`; `start`, `stop` and `health` are the handlers `genie.relay-host` names. */
    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        switch (method) {
            case 'status': return this.status();
            case 'register': await this.register((args[0] ?? null) as LegacyIdentity | null); return this.status();
            case 'readRole': await this.readRole(); return this.#role;
            case 'revalidate': await this.#handle?.revalidate(); return true;
            case 'start': await this.apply(); return this.status();
            case 'stop': this.stop(); return this.status();
            case 'health': return { registered: this.#workstation?.registered === true, role: this.#role, relay: this.#relay.state };
            default: throw new Error(`The relay host has no ${method}.`);
        }
    }
}
