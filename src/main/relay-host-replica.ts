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
    #view: RelayHostView = { workstation: null, role: 'drone', relay: { state: 'off' }, epoch: '', rev: -1 };

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) { this.#call = call; }

    workstation(): TynnWorkstationState | null { return this.#view.workstation; }
    role(): WorkstationRole | null { return this.#view.role; }
    /** What Tynn answered; `null` until it has (and before genie-host has answered this window at all). */
    said(): WorkstationRole | null { return this.#view.said ?? null; }
    unknownWhy(): string | null { return this.#view.unknownWhy ?? null; }
    relay(): RelayHostStatus { return this.#view.relay; }

    async refresh(): Promise<void> { this.deliver((await this.#call('status', [])) as RelayHostView); }
    async register(legacy: LegacyIdentity | null): Promise<void> { this.deliver((await this.#call('register', [legacy])) as RelayHostView); }
    async readRole(): Promise<void> { await this.#call('readRole', []); }
    async revalidate(): Promise<void> { await this.#call('revalidate', []); }

    /**
     * The newest view wins, not the last to arrive (Tynn #656): a call's reply is applied a turn after an event that came in
     * the same read, so an older reply would replace a newer event. A view from another run of genie-host (it restarted)
     * starts over.
     */
    deliver(view: RelayHostView): void {
        if (view.epoch === this.#view.epoch && view.rev < this.#view.rev) return;
        this.#view = view;
        for (const l of [...this.#listeners]) l();
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}
