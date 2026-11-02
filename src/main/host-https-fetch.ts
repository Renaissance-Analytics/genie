import { Agent, request } from 'node:https';
import tls from 'node:tls';
import type { SessionFetch } from './tynn-account.js';

/**
 * THE HOST'S HTTPS (P3.4 cut c; plan §13). A window's session fetch is Chromium's network stack. genie-host has Node, whose fetch
 * trusts only its bundled roots and has no OS proxy settings, which can break sign-in outright. This trusts:
 *   - Node's bundled roots: the public chain, real tynn.ai;
 *   - the OS store, as Node reads it: a test VM's alias CA, a company's root, and Genie's CA once the person has pressed Trust.
 *
 * NOT Genie's CA from its file. A CA that counts without the person's word, on calls that carry the Tynn token, would be wider
 * than the window, which trusted it only once it was in the OS store. A guard holds this (test/host-https-fetch.test.ts).
 *
 * VERIFICATION IS NEVER OFF. `rejectUnauthorized: true` is explicit on purpose: left unset, an inherited
 * NODE_TLS_REJECT_UNAUTHORIZED=0 would turn it off for the host, and Chromium never read that variable. A source guard holds this
 * (test/host-https-fetch.test.ts).
 *
 * ONLY https, and a redirect is refused: this carries bearer tokens, as the window's `redirect: 'error'` asked. Env proxies
 * (HTTPS_PROXY, NO_PROXY) are honoured by Node's agent. What the window had and this lacks: plan §13, "the host's network".
 */
export interface HostHttpsOptions {
    /** The roots to trust. Default: Node's bundled ones and the OS store. Tests name theirs, so no test touches a real store. */
    readonly machineRoots?: () => readonly string[];
    /** Where proxies are read from. Default: the host's own environment. */
    readonly env?: NodeJS.ProcessEnv;
}

/** Each of these is cached by Node for the process; so is this. A root added to the OS store is read at the next host start. */
let machineRoots: readonly string[] | null = null;
function rootsOfThisMachine(): readonly string[] {
    if (machineRoots) return machineRoots;
    const read = (kind: 'bundled' | 'system'): readonly string[] => { try { return tls.getCACertificates(kind); } catch { return []; } };
    const bundled = read('bundled');
    machineRoots = [...(bundled.length > 0 ? bundled : tls.rootCertificates), ...read('system')];
    return machineRoots;
}

export function hostHttpsFetch(options: HostHttpsOptions = {}): SessionFetch {
    /** One agent: a context over every root costs real time, and a call should not. */
    let built: Agent | null = null;
    const agentNow = (): Agent => {
        built ??= new Agent({ ca: [...(options.machineRoots ?? rootsOfThisMachine)()], rejectUnauthorized: true, proxyEnv: { ...(options.env ?? process.env) } } as ConstructorParameters<typeof Agent>[0]);
        return built;
    };

    return (url, init) => new Promise((resolve, reject) => {
        const target = new URL(url);
        if (target.protocol !== 'https:') { reject(new Error(`The host calls https only: ${target.protocol}`)); return; }
        if (init.signal.aborted) { reject(Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' })); return; }
        const agent = agentNow();
        const ask = request(target, { method: init.method, headers: init.headers, agent, rejectUnauthorized: true, signal: init.signal }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
                res.destroy();
                reject(new Error(`Tynn answered with a redirect (${status}), which is refused.`));
                return;
            }
            const chunks: Buffer[] = [];
            const body = new Promise<string>((done, failed) => {
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
                res.on('error', failed);
                res.on('close', () => { if (!res.complete) failed(new Error('The connection closed before the answer finished.')); });
            });
            // A status-only caller need not read it; its failure must still be handled.
            void body.catch(() => {});
            resolve({ ok: status >= 200 && status < 300, status, text: () => body });
        });
        ask.on('error', reject);
        ask.end(init.body);
    });
}
