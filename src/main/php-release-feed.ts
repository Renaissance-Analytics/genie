import {
    PHP_NET_SUPPORTED_JSON,
    bakedPhpCatalog,
    buildPhpCatalog,
    currentPhpCatalog,
    parsePhpNetLine,
    parsePhpNetSupported,
    parseStoredCatalog,
    parseWindowsReleaseLines,
    phpNetLineJson,
    setPhpCatalog,
    type PhpCatalog,
} from '../core/php-releases.js';
import { PHP_RECIPES, PHP_WINDOWS_RELEASES_JSON, type PhpPlatform } from '../core/php-versions.js';
import type { Fetched } from './php-versions.js';

/**
 * PHP'S LIVE RELEASE DATA, FETCHED (Tynn #1066) — the effectful half of core/php-releases.ts.
 *
 * One feed per host. `refresh` reads php.net (the supported lines, then each line's releases) and, on Windows,
 * windows.php.net's releases.json — every request with a TIMEOUT, so a dead network never holds up whoever asked — and
 * makes the result the process's catalog (setPhpCatalog). Within the TTL it asks nothing. What it read is STORED, so a
 * restart while offline keeps the floor php.net last raised; a failed refresh never replaces a live catalog with the
 * baked one. Offline from the first start it is the baked list, said ONCE in the log until php.net answers again: no
 * error spam.
 */

export interface PhpReleaseFeedPorts {
    readonly platform: PhpPlatform;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    readonly now: () => number;
    /** Per request. Default 10 s. */
    readonly timeoutMs?: number;
    /** How long a live catalog is fresh. Default 6 h. */
    readonly ttlMs?: number;
    readonly log?: (line: string) => void;
    /** Where the last live catalog is kept between runs (a file in Genie's toolchain directory). */
    readonly store?: { read(): string | null; write(text: string): void };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 6 * 3_600_000;

export class PhpReleaseFeed {
    readonly #p: PhpReleaseFeedPorts;
    #freshAt: number | null = null;
    #offlineSaid = false;
    #inFlight: Promise<PhpCatalog> | null = null;

    constructor(ports: PhpReleaseFeedPorts) {
        this.#p = ports;
        let stored: PhpCatalog | null = null;
        try {
            stored = parseStoredCatalog(ports.store?.read() ?? null);
        } catch {
            stored = null;
        }
        if (stored !== null) setPhpCatalog(stored);
    }

    /** The catalog in use now: live, stored, or baked. */
    catalog(): PhpCatalog {
        return currentPhpCatalog();
    }

    /** Read php.net again unless the last read is inside the TTL (or `force`). Never rejects. One read at a time. */
    refresh(options: { force?: boolean } = {}): Promise<PhpCatalog> {
        const ttl = this.#p.ttlMs ?? DEFAULT_TTL_MS;
        if (!options.force && this.#freshAt !== null && this.#p.now() - this.#freshAt < ttl) return Promise.resolve(currentPhpCatalog());
        this.#inFlight ??= this.#read().finally(() => { this.#inFlight = null; });
        return this.#inFlight;
    }

    async #read(): Promise<PhpCatalog> {
        const get = (url: string) => this.#get(url);
        const windowsP = this.#p.platform === 'win32' ? get(PHP_WINDOWS_RELEASES_JSON) : Promise.resolve(null);
        const supportedText = await get(PHP_NET_SUPPORTED_JSON);
        const supported = supportedText === null ? null : parsePhpNetSupported(supportedText);
        const windowsText = await windowsP;
        const windows = windowsText === null ? null : parseWindowsReleaseLines(windowsText);
        const candidates = [...new Set([...(supported ?? []), ...PHP_RECIPES.map((r) => r.version.split('.').slice(0, 2).join('.')), ...Object.keys(windows ?? {})])];
        const lineTexts = await Promise.all(candidates.map(async (line) => [line, await get(phpNetLineJson(line))] as const));
        const lines = Object.fromEntries(lineTexts.map(([line, text]) => [line, text === null ? null : parsePhpNetLine(text, line)]));
        const built = buildPhpCatalog({ platform: this.#p.platform, at: this.#p.now(), windows, supported, lines });
        if (built.source !== 'live') {
            if (!this.#offlineSaid) {
                const using = currentPhpCatalog().source === 'live' ? 'the PHP release data it read last' : "this Genie release's baked PHP versions";
                this.#p.log?.(`php releases: php.net could not be read; Genie uses ${using} until it can`);
                this.#offlineSaid = true;
            }
            return currentPhpCatalog();
        }
        this.#offlineSaid = false;
        this.#freshAt = this.#p.now();
        setPhpCatalog(built);
        try {
            this.#p.store?.write(JSON.stringify(built));
        } catch {
            // the catalog is in use; only the next offline start misses it
        }
        return built;
    }

    /** One request, its body or `null`: a failure, an error status, or no answer within the timeout. */
    async #get(url: string): Promise<string | null> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<Fetched<string>>((resolve) => {
            timer = setTimeout(() => resolve({ ok: false, error: 'timed out' }), this.#p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        });
        try {
            const r = await Promise.race([this.#p.fetchText(url).catch((e: unknown) => ({ ok: false as const, error: String(e) })), timeout]);
            return r.ok ? r.body : null;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}

/** For tests and a host that wants the baked list back. */
export function resetPhpCatalog(): void {
    setPhpCatalog(bakedPhpCatalog());
}
