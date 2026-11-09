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
    readonly readRole: (request: TynnRequest) => Promise<WorkstationRole | null>;
    /** Start the link on this identity (`startRelayHost`, wired in genie-host). */
    readonly start: (input: { host: string; workstationId: string; fingerprint: string; onStatus: (status: RelayHostStatus) => void }) => RelayHostHandle;
    readonly onChange: () => void;
}

export interface RelayHostView {
    readonly workstation: TynnWorkstationState | null;
    readonly role: WorkstationRole | null;
    readonly relay: RelayHostStatus;
}

export class RelayHostService {
    readonly #ports: RelayHostServicePorts;
    #workstation: TynnWorkstationState | null = null;
    /** A drone until Tynn's first answer (fail closed). */
    #role: WorkstationRole | null = 'drone';
    #relay: RelayHostStatus = { state: 'off' };
    #handle: RelayHostHandle | null = null;
    #relayFor: string | null = null;
    #registering: Promise<void> | null = null;
    #legacy: LegacyIdentity | null = null;
    #again = false;

    constructor(ports: RelayHostServicePorts) { this.#ports = ports; }

    status(): RelayHostView { return { workstation: this.#workstation, role: this.#role, relay: this.#relay }; }
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
            this.#workstation = result.ok ? { registered: true, host, workstationId: result.workstationId, role: this.#role } : { registered: false, reason: result.reason, role: this.#role };
        }
        await this.readRole();
        await this.apply();
        this.#ports.onChange();
    }

    /** What Tynn says this machine is: Tynn's answer only; signed in, no answer is a drone. */
    async readRole(): Promise<void> {
        const account = this.#ports.account();
        const signedIn = account?.status().signedIn === true;
        const role = signedIn && account ? await this.#ports.readRole(account.request) : null;
        const next = signedIn ? effectiveRoleOf({ signedIn: true, role }) : effectiveRoleOf({ signedIn: false });
        if (next === this.#role) return;
        this.#role = next;
        if (this.#workstation) this.#workstation = { ...this.#workstation, role: next };
        this.#ports.onChange();
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
