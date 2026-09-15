import type { RelayHostDeps, RelayHostHandle, RelayHostStatus } from '../host-core/relay-host/service';

/**
 * Whether THIS computer is reachable over Tynn, and why not when it is not
 * (genie#680, genie#451).
 *
 * The Settings "Tynn" network switch (`remote_network_tynn`, on by default) was
 * read by nothing, while Settings claimed "Tynn: authenticated relay enabled" on
 * every install. Here it governs the relay host: with Genie Remote on and Tynn
 * allowed, this machine dials its relay; otherwise it does not, and a live link is
 * stopped. The status this reports is what Settings shows.
 *
 * Settings are read on every `sync`, so a toggle takes effect when Settings applies
 * it rather than at the next app start.
 */

/** The enrolled workstation identity the relay host dials as. */
export interface RelayHostIdentity {
    workstationId: string;
    fingerprint: string;
    authHeader: () => string;
    sign: (data: Buffer) => Buffer;
}

export type RelayHostPublicStatus = { state: 'off' } | Exclude<RelayHostStatus, { state: 'stopped' }>;

export const NOT_LISTENING_MESSAGE = 'Tynn reaches this computer through the Local listener, which is not running.';

/**
 * The local server the relay proxies onto: the Local listener on loopback, never a
 * Tailscale or LAN address, so relayed traffic never leaves this machine. Null when
 * Local is not listening.
 */
export function relayLocalTarget(
    listeners: ReadonlyArray<{ network: string; ip: string; port: number; secure: boolean }>,
): string | null {
    const local = listeners.find((l) => l.network === 'local' && l.ip === '127.0.0.1');
    return local ? `${local.secure ? 'https' : 'http'}://127.0.0.1:${local.port}` : null;
}

export interface RelayHostControllerDeps {
    settings: () => Record<string, string | undefined>;
    identity: () => RelayHostIdentity | null;
    tynnApiBaseUrl: () => string;
    /** This machine's member-facing server on loopback, or null when not listening there. */
    localBaseUrl: () => string | null;
    start: (deps: RelayHostDeps) => RelayHostHandle;
    broadcast: (status: RelayHostPublicStatus) => void;
    log?: (msg: string) => void;
}

export class RelayHostController {
    private handle: RelayHostHandle | null = null;
    private running: { workstationId: string; tynn: string } | null = null;
    private current: RelayHostPublicStatus = { state: 'off' };

    constructor(private readonly deps: RelayHostControllerDeps) {}

    status(): RelayHostPublicStatus {
        return this.current;
    }

    /** Bring the relay host in line with the settings, identity and local server. */
    sync(): void {
        const settings = this.deps.settings();
        const wanted = settings.remote_enabled === 'on' && settings.remote_network_tynn !== 'off';
        if (!wanted) {
            this.halt({ state: 'off' });
            return;
        }
        const identity = this.deps.identity();
        if (!identity) {
            this.halt({
                state: 'unavailable',
                reason: 'not_enrolled',
                message: 'Sign in to Tynn so this computer is registered as a workstation.',
            });
            return;
        }
        if (!this.deps.localBaseUrl()) {
            this.halt({
                state: 'unavailable',
                reason: 'not_listening',
                message: NOT_LISTENING_MESSAGE,
            });
            return;
        }
        const tynn = this.deps.tynnApiBaseUrl();
        if (this.handle && this.running?.workstationId === identity.workstationId && this.running.tynn === tynn) return;

        this.handle?.stop();
        this.running = { workstationId: identity.workstationId, tynn };
        const started = this.deps.start({
            workstationId: identity.workstationId,
            fingerprint: identity.fingerprint,
            sign: identity.sign,
            authHeader: identity.authHeader,
            tynnApiBaseUrl: tynn,
            localBaseUrl: () => this.deps.localBaseUrl(),
            onStatus: (s) => {
                if (this.handle !== started || s.state === 'stopped') return;
                this.publish(s);
            },
            log: this.deps.log,
        });
        this.handle = started;
        const initial = started.status();
        this.publish(initial.state === 'stopped' ? { state: 'off' } : initial);
    }

    stop(): void {
        this.halt({ state: 'off' });
    }

    private halt(status: RelayHostPublicStatus): void {
        const handle = this.handle;
        this.handle = null;
        this.running = null;
        handle?.stop();
        this.publish(status);
    }

    private publish(status: RelayHostPublicStatus): void {
        this.current = status;
        this.deps.broadcast(status);
    }
}

/** The one relay host this app runs, for the IPC layer to report and re-sync. */
let active: RelayHostController | null = null;

export function setRelayHostController(controller: RelayHostController | null): void {
    active = controller;
}

export function relayHostStatus(): RelayHostPublicStatus {
    return active?.status() ?? { state: 'off' };
}

export function syncRelayHost(): void {
    active?.sync();
}
