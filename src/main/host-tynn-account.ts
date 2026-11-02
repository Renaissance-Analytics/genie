import { hostHttpsFetch, type HostHttpsOptions } from './host-https-fetch.js';
import type { SessionFetch, TynnAccountPorts, TynnSecrets } from './tynn-account.js';

/**
 * THE TYNN ACCOUNT'S PORTS WHERE THERE IS NO ELECTRON (P3.4 cut c). The sign-in exchange sends the code as a cookie: in the window
 * that was an Electron session's jar, which genie-host does not have. Here the jar is a small map that lives for the exchange
 * (the account sets it, then clears it), and the cookie is a header on the one call that asks for credentials.
 */
export interface HostTynnOptions {
    readonly file: string;
    readonly host: () => string;
    readonly secrets: TynnSecrets;
    /** The roots to trust, for tests; the default is the machine's (host-https-fetch.ts). */
    readonly machineRoots?: () => readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly proxyRoutes?: HostHttpsOptions['proxyRoutes'];
    /** Tests of the account's logic; the real one speaks TLS. */
    readonly fetch?: SessionFetch;
    readonly schedule?: TynnAccountPorts['schedule'];
}

export function hostTynnPorts(options: HostTynnOptions): TynnAccountPorts {
    const jar = new Map<string, Map<string, string>>();
    const send = options.fetch ?? hostHttpsFetch(options.machineRoots ? { machineRoots: options.machineRoots } : {});
    return {
        file: options.file,
        host: options.host,
        secrets: options.secrets,
        ...(options.schedule ? { schedule: options.schedule } : {}),
        cookies: {
            set: async (host, name, value) => { jar.set(host, (jar.get(host) ?? new Map<string, string>()).set(name, value)); },
            get: async (host, name) => jar.get(host)?.get(name) ?? null,
            clear: async (host) => { jar.delete(host); },
        },
        fetch: (url, init) => {
            const cookies = init.credentials === 'include' ? jar.get(new URL(url).origin) : undefined;
            const cookie = cookies ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') : '';
            return send(url, { ...init, headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}) } });
        },
    };
}
