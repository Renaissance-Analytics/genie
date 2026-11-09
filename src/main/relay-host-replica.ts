import type { WorkstationRole } from '../core/workstation-role.js';
import type { TynnWorkstationState } from '../renderer/features.js';
import type { RelayHostView } from './relay-host-service.js';
import type { RelayHostStatus } from './tynn-network.js';
import type { LegacyIdentity } from './workstation-identity.js';

/**
 * THE RELAY HOST AS A WINDOW READS IT (Tynn #410; the client side of `genie.relay-host`). Fails closed: a drone until
 * genie-host has answered, as the window has always started.
 */
export class RelayHostReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    readonly #listeners = new Set<() => void>();
    #view: RelayHostView = { workstation: null, role: 'drone', relay: { state: 'off' } };

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) { this.#call = call; }

    workstation(): TynnWorkstationState | null { return this.#view.workstation; }
    role(): WorkstationRole | null { return this.#view.role; }
    relay(): RelayHostStatus { return this.#view.relay; }

    async refresh(): Promise<void> { this.deliver((await this.#call('status', [])) as RelayHostView); }
    async register(legacy: LegacyIdentity | null): Promise<void> { this.deliver((await this.#call('register', [legacy])) as RelayHostView); }
    async readRole(): Promise<void> { await this.#call('readRole', []); }
    async revalidate(): Promise<void> { await this.#call('revalidate', []); }

    deliver(view: RelayHostView): void {
        this.#view = view;
        for (const l of [...this.#listeners]) l();
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}
