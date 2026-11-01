/**
 * ONE BUILD AT A TIME, THE LATEST STATE ALWAYS LAST (genie#1393).
 *
 * Main pushed the feature snapshot to the windows on every change (a site, a supervisor transition, a setting), and each
 * push built its own snapshot concurrently. At boot that was dozens at once, each with its own Docker reads, and they
 * landed in whatever order they finished, so a snapshot built BEFORE a site answered could arrive AFTER the one built
 * when it did, and the window showed it `starting` until something else happened to push (the owner: "after a minute
 * or so the ui refreshed").
 *
 * Through this a request while idle builds AT ONCE. Requests during a build become ONE more build after it: it reads the
 * state then, so the last change is always followed by a delivery that sees it, and deliveries are in build order.
 */
export class LatestPush<T> {
    readonly #build: () => Promise<T>;
    readonly #deliver: (value: T) => void;
    readonly #onError: (error: unknown) => void;
    #building = false;
    #again = false;

    constructor(options: { build: () => Promise<T>; deliver: (value: T) => void; onError?: (error: unknown) => void }) {
        this.#build = options.build;
        this.#deliver = options.deliver;
        this.#onError = options.onError ?? ((error) => { console.error('[genie] push:', error instanceof Error ? error.message : String(error)); });
    }

    /** Something changed: build and deliver, now or right after the build in flight. */
    request(): void {
        if (this.#building) {
            this.#again = true;
            return;
        }
        void this.#run();
    }

    async #run(): Promise<void> {
        this.#building = true;
        try {
            do {
                this.#again = false;
                try {
                    this.#deliver(await this.#build());
                } catch (error) {
                    this.#onError(error);
                }
            } while (this.#again);
        } finally {
            this.#building = false;
        }
    }
}
