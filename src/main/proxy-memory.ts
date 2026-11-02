import type { ProxyRoute } from '../core/proxy-answer.js';
/** RED STUB (the proxy's first commit). */
export class ProxyMemory {
    static async open(_file: string, _log?: (line: string) => void): Promise<ProxyMemory> { return new ProxyMemory(); }
    routesFor(_url: string): ProxyRoute[] { return [{ kind: 'direct' }]; }
    async remember(_answers: Readonly<Record<string, string>>): Promise<void> {}
}
