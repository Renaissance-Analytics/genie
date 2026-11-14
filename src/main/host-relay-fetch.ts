import type { HostHttpsFetch } from './host-https-fetch.js';

/** How long one relay call to Tynn may take when its caller set no signal of its own. */
export const RELAY_FETCH_TIMEOUT_MS = 20_000;

/** Statuses a Response may not carry a body for. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * THE RELAY'S TYNN CALLS, OVER GENIE-HOST'S HTTPS CLIENT (Tynn issue #707). The relay ports (tynn-network.ts
 * `relayHostPorts`) speak `fetch`: they may send no signal, and they read `res.json()`. genie-host's client
 * (host-https-fetch.ts) takes a narrower request (a signal always, headers as a record, no cookies, no redirects) and
 * answers with `text()` only. This turns one into the other in the open: genie-host cast them into each other instead,
 * and every relay ticket threw before it was sent, so no 61.x drone reached the relay.
 */
export function relayFetchOver(send: HostHttpsFetch, timeoutMs: number = RELAY_FETCH_TIMEOUT_MS): (url: string, init?: RequestInit) => Promise<Response> {
    return async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'POST') throw new Error(`The relay calls Tynn with GET or POST only, not ${method}.`);
        if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new Error('The relay sends Tynn text bodies only.');
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
        const res = await send(url, {
            method,
            headers,
            ...(typeof init?.body === 'string' ? { body: init.body } : {}),
            credentials: 'omit',
            redirect: 'error',
            signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        const type = res.headers.get('content-type');
        return new Response(NO_BODY.has(res.status) ? null : text, { status: res.status, headers: type ? { 'content-type': type } : {} });
    };
}
