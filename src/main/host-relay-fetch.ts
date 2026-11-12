import type { HostHttpsFetch } from './host-https-fetch.js';

/** STUB (Tynn issue #707, test first): the cast genie-host used. Replaced by the real adapter in the next commit. */
export function relayFetchOver(send: HostHttpsFetch): (url: string, init?: RequestInit) => Promise<Response> {
    return async (url, init) => (await send(url, init as never)) as unknown as Response;
}
