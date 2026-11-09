import { LOCAL_FRAME_LIMIT_BYTES } from '../core/local-frame.js';
import type { MarketplaceApi, MarketplaceReview } from '../core/marketplace.js';

/** One authenticated window connection's reviews, shared by the engine link and the admitted renderer frame adapter. */
export class MarketplaceSession {
    readonly #reviews = new Map<string, MarketplaceApi>();
    #preparing = 0;
    #closed = false;
    #closing: Promise<void> | null = null;
    constructor(private readonly api: () => MarketplaceApi | null, private readonly log?: (line: string) => void) {}

    #current(): MarketplaceApi {
        const api = this.api();
        if (!api) throw new Error('Marketplace is not available on this host.');
        return api;
    }
    #bounded<T>(value: T, review = false): T {
        const text = JSON.stringify(value);
        if (typeof text !== 'string') throw new Error('Invalid Marketplace response.');
        // Leave room for the protocol envelope; never drop a local connection by returning an oversized review.
        if (Buffer.byteLength(text) > LOCAL_FRAME_LIMIT_BYTES - 4096) throw new Error(review
            ? 'The package review is too large for this window. Ask the publisher to reduce its manifest.'
            : 'The Marketplace results are too large. Narrow the search and try again.');
        return value;
    }
    async call(operation: unknown, args: readonly unknown[]): Promise<unknown> {
        if (this.#closed) throw new Error('The Marketplace window connection is closed.');
        const invalid = (): never => { throw new Error('Invalid Marketplace operation arguments.'); };
        const [first, second] = args;
        switch (operation) {
            case 'search':
                if (args.length < 1 || args.length > 2 || typeof first !== 'string' || (second !== undefined && typeof second !== 'string')) return invalid();
                return this.#bounded(await this.#current().search(first, second));
            case 'prepare': {
                if (args.length !== 2 || typeof first !== 'string' || typeof second !== 'string') return invalid();
                if (this.#reviews.size + this.#preparing >= 4) throw new Error('Cancel an existing Marketplace review before preparing another.');
                const api = this.#current(); let staged: MarketplaceReview | undefined;
                this.#preparing++;
                try {
                    staged = await api.prepare(first, second);
                    if (this.#closed) throw new Error('The preparing window closed; its Marketplace review was discarded.');
                    this.#bounded(staged, true);
                    this.#reviews.set(staged.token, api);
                    return staged;
                } catch (error) {
                    if (staged) await api.discard(staged.token).catch(() => this.log?.('Marketplace staged review cleanup failed.'));
                    throw error;
                } finally { this.#preparing--; }
            }
            case 'install': {
                if (args.length !== 2 || typeof first !== 'string' || typeof second !== 'boolean') return invalid();
                const api = this.#reviews.get(first);
                if (!api) throw new Error('This Marketplace review does not belong to this window.');
                const result = await api.install(first, second);
                this.#reviews.delete(first);
                return result;
            }
            case 'discard': {
                if (args.length !== 1 || typeof first !== 'string') return invalid();
                const api = this.#reviews.get(first);
                if (!api) throw new Error('This Marketplace review does not belong to this window.');
                this.#reviews.delete(first); await api.discard(first); return null;
            }
            default: throw new Error('Unknown Marketplace operation.');
        }
    }
    close(): Promise<void> {
        if (this.#closing) return this.#closing;
        this.#closed = true;
        const reviews = [...this.#reviews]; this.#reviews.clear();
        this.#closing = Promise.allSettled(reviews.map(([token, api]) => Promise.resolve().then(() => api.discard(token)))).then(results => {
            if (results.some(result => result.status === 'rejected')) this.log?.('Marketplace review cleanup failed after a window disconnected.');
        });
        return this.#closing;
    }
}
