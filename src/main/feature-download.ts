import { Agent, request } from 'node:https';
import { Readable } from 'node:stream';
import type { ProxyRoute } from '../core/proxy-answer.js';
import { rootsOfThisMachine } from './host-https-fetch.js';

/** Public, checksum-verified installer downloads. Carries no cookies or account credentials across redirects. */
export function featureDownload(options: { proxyRoutes(url: string): readonly ProxyRoute[]; env?: NodeJS.ProcessEnv }) {
    const env = options.env ?? process.env;
    const agents = new Map<string, Agent>();
    const send = (url: string, agent: Agent, hops = 0): Promise<Response> => new Promise((resolve, reject) => {
        let target: URL;
        try { target = publicDownloadTarget(url); } catch (error) { reject(error); return; }
        const ask = request(target, { method: 'GET', headers: { 'User-Agent': 'Genie installer', 'Accept-Encoding': 'identity' }, agent, rejectUnauthorized: true, signal: AbortSignal.timeout(30 * 60_000) }, res => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
                const location = res.headers.location; res.destroy();
                try {
                    if (!location || hops >= 5) throw new Error('The installer download sent an unusable redirect.');
                    const next = publicDownloadTarget(new URL(location, target).href);
                    // Resolve the OS proxy for the new target, too. No Authorization/cookie is ever supplied here.
                    resolve(download(next.href, hops + 1));
                } catch (error) { reject(error); }
                return;
            }
            try {
                const headers = new Headers();
                for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
                const body = status === 204 || status === 205 || status === 304 ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>;
                resolve(new Response(body, { status, headers }));
            } catch (error) { res.destroy(); reject(error); }
        });
        ask.on('error', reject); ask.end();
    });
    const download = async (url: string, hops = 0): Promise<Response> => {
        publicDownloadTarget(url);
        const explicit = Object.entries(env).some(([key, value]) => key.toUpperCase() === 'HTTPS_PROXY' && !!value);
        const routes = explicit ? [{ kind: 'direct' as const }] : options.proxyRoutes(url);
        let failure: unknown = new Error('The OS supplied no route for this download.');
        for (const route of routes) {
            if (route.kind === 'unsupported') { failure = new Error('The OS proxy for this download is not supported.'); continue; }
            const key = explicit ? 'environment' : JSON.stringify(route);
            let agent = agents.get(key);
            if (!agent) {
                const noProxy = Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() === 'NO_PROXY'));
                const proxyEnv = explicit ? { ...env } : route.kind === 'proxy' ? { ...noProxy, HTTPS_PROXY: `${route.scheme}://${route.host}:${route.port}` } : {};
                agent = new Agent({ ca: [...rootsOfThisMachine()], rejectUnauthorized: true, proxyEnv } as ConstructorParameters<typeof Agent>[0]);
                agents.set(key, agent);
            }
            try { return await send(url, agent, hops); } catch (error) {
                failure = error;
                // A certificate failure never grants a different route, as in the host's authenticated HTTPS port.
                const code = String((error as { code?: unknown } | null)?.code ?? '');
                const routeFailure = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code) || code.startsWith('ERR_PROXY');
                if (route.kind === 'direct' || !routeFailure) throw error;
            }
        }
        throw failure;
    };
    return (url: string): Promise<Response> => download(url);
}

export function publicDownloadTarget(url: string): URL {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Installer downloads require HTTPS without URL credentials.');
    return target;
}
