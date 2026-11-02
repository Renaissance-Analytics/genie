import { readFile } from 'node:fs/promises';
import { parseProxyAnswer, renderProxyAnswer, type ProxyRoute } from '../core/proxy-answer.js';
import { PRIVATE_FILE, makePrivate, writeJsonAtomic } from './store.js';

/**
 * WHAT THE OS LAST SAID ABOUT PROXIES (P3.4 cut c; the owner: "Yes, cover it."). Only a window can ask (`session.resolveProxy`), and the
 * host has to reach Tynn with no window open, so the answer is kept: `runtime/host-proxy.json`, 0600. Each answer goes through the
 * parser first, so what is written holds routes and nothing else: never a credential. It holds until a window says otherwise, so a PAC
 * or settings change while no window is open is not seen.
 */
const DIRECT: readonly ProxyRoute[] = [{ kind: 'direct' }];
const originOf = (url: string): string | null => { try { return new URL(url).origin; } catch { return null; } };

export class ProxyMemory {
    readonly #file: string;
    readonly #log: (line: string) => void;
    readonly #origins = new Map<string, string>();

    private constructor(file: string, log: (line: string) => void) { this.#file = file; this.#log = log; }

    static async open(file: string, log: (line: string) => void = () => {}): Promise<ProxyMemory> {
        const memory = new ProxyMemory(file, log);
        await makePrivate(file);
        const text = await readFile(file, 'utf8').catch(() => null);
        if (text === null) return memory;
        try {
            const parsed = JSON.parse(text) as { version?: unknown; origins?: unknown };
            if (parsed.version !== 1 || typeof parsed.origins !== 'object' || parsed.origins === null) throw new Error('not this file');
            for (const [origin, answer] of Object.entries(parsed.origins)) if (typeof answer === 'string') memory.#origins.set(origin, answer);
        } catch {
            log('the remembered proxy answer could not be read, so calls go direct until a window says otherwise');
        }
        return memory;
    }

    routesFor(url: string): readonly ProxyRoute[] {
        const origin = originOf(url);
        const answer = origin === null ? undefined : this.#origins.get(origin);
        return answer === undefined ? DIRECT : parseProxyAnswer(answer);
    }

    async remember(answers: Readonly<Record<string, unknown>>): Promise<void> {
        for (const [origin, answer] of Object.entries(answers)) {
            // An origin only, https only, an answer only. What a link sends is not trusted to be the shape it should be.
            if (typeof answer !== 'string' || originOf(origin) !== origin || !origin.startsWith('https://')) continue;
            this.#origins.set(origin, renderProxyAnswer(parseProxyAnswer(answer)));
        }
        await writeJsonAtomic(this.#file, { version: 1, origins: Object.fromEntries(this.#origins) }, PRIVATE_FILE);
        this.#log(`proxy answers remembered: ${[...this.#origins].map(([origin, answer]) => `${origin} -> ${answer}`).join(', ')}`);
    }
}
