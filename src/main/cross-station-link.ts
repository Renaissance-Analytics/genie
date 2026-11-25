import type { ClientTransport } from '../core/remote-protocol.js';
import type { StationLink } from './cross-station-host.js';

/** RED STUB (P9 x-station mail): nothing is built yet. */
export async function stationLinkOver(_transport: ClientTransport, _options: { label: string; timeoutMs?: number }): Promise<StationLink> {
    throw new Error('not built');
}
