/** RED STUB. */
export class WorkstationReplica {
    async identity(_host: string): Promise<{ workstationId: string; fingerprint: string } | null> { throw new Error('not built'); }
    async sign(_host: string, _data: Buffer): Promise<Buffer> { throw new Error('not built'); }
    async authHeader(_host: string): Promise<string> { throw new Error('not built'); }
    async ensure(_options: { host: string }): Promise<unknown> { throw new Error('not built'); }
    async legacyDone(_host: string): Promise<string | null> { throw new Error('not built'); }
}
