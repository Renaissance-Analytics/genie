import type { EnsureWorkstationResult, LegacyIdentity } from './workstation-identity.js';
import type { WorkstationPort } from './workstation-service.js';

/** This machine as a workstation, from a window: it asks the host, which holds the key. With no link it refuses, and never reads as not registered. */
export class WorkstationReplica implements WorkstationPort {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) { this.#call = call; }

    identity(host: string): Promise<{ workstationId: string; fingerprint: string } | null> { return this.#call('identity', [host]) as Promise<{ workstationId: string; fingerprint: string } | null>; }
    async sign(host: string, data: Buffer): Promise<Buffer> { return Buffer.from(await this.#call('sign', [host, data.toString('base64')]) as string, 'base64'); }
    authHeader(host: string): Promise<string> { return this.#call('authHeader', [host]) as Promise<string>; }
    ensure(options: { readonly host: string; readonly legacy?: LegacyIdentity | null }): Promise<EnsureWorkstationResult> { return this.#call('ensure', [options]) as Promise<EnsureWorkstationResult>; }
    legacyDone(host: string): Promise<string | null> { return this.#call('legacyDone', [host]) as Promise<string | null>; }
}
