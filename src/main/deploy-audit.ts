/** DEPLOYMENT: THE AUDIT LOG (Tynn #871; spec §4.7). RED stub: types only. */

export type AuditActor = { readonly kind: 'person' } | { readonly kind: 'agent'; readonly name: string; readonly workspace: string } | { readonly kind: 'genie' };

export interface AuditRecord {
    readonly actor: AuditActor;
    readonly action: string;
    readonly result: string;
    readonly accountId?: string;
    readonly target?: string;
    readonly planHash?: string;
    readonly approvalId?: string;
    readonly requestId?: string;
    readonly estimate?: unknown;
}

export type AuditVerdict = { readonly ok: true; readonly records: number } | { readonly ok: false; readonly line: number; readonly reason: string };

export function redactSecrets(_value: unknown, _known: readonly string[]): unknown {
    throw new Error('not built yet (#871 RED)');
}

export class DeployAudit {
    constructor(_file: string, _options: { readonly knownSecrets: () => readonly string[]; readonly now?: () => number }) {}

    append(_record: AuditRecord): Promise<void> {
        throw new Error('not built yet (#871 RED)');
    }

    verify(): Promise<AuditVerdict> {
        throw new Error('not built yet (#871 RED)');
    }
}
