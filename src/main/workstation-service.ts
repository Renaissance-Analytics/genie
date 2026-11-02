/** RED STUB. */
export interface WorkstationServiceOptions { readonly store: unknown; readonly request: unknown; readonly host: () => string; readonly hostname: () => string; readonly machineKey: () => Promise<string | null> }
export class WorkstationService {
    constructor(readonly options: WorkstationServiceOptions) {}
    call(_method: string, _args: readonly unknown[]): Promise<unknown> { return Promise.reject(new Error('not built')); }
}
