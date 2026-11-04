import type { BrowserActivation, BrowserEvent, BrowserFacts } from './browser-service.js';

/**
 * THE GENIE BROWSER'S PROCESS, ITS LINK TO THE HOST (the host split, P2b). It adopts a running host and never starts or
 * replaces one, outlives the window, and links again when the host drops, its pages staying up. The host ending on purpose
 * ends this process too. Every part of it is a port, so the rule is tested without a process.
 */

export interface BrowserLinkClient {
    browserCall(method: string, args: readonly unknown[]): Promise<unknown>;
    onBrowserEvent(listener: (event: BrowserEvent) => void): () => void;
    close(): void;
}

export interface BrowserLinkPorts {
    /** A linked client, or null when no host answers. `onLost` is called when this link drops. */
    connect(onLost: () => void): Promise<BrowserLinkClient | null>;
    sleep(ms: number): Promise<void>;
    facts(facts: BrowserFacts): void;
    door(up: boolean): void;
    open(url: string | null, activation: BrowserActivation): void;
    openSingle?(panelKey: string, url: string): void;
    closeSingle?(panelKey: string): void;
    /** A call into a page, from the `pages` tool. */
    pageCall?(event: Extract<BrowserEvent, { kind: 'pageCall' }>, client: BrowserLinkClient): void;
    /** Anything else the host says, for a side that watches it (the cookie sync). */
    other?(event: BrowserEvent): void;
    /** Linked: the current pages are said again. */
    linked?(client: BrowserLinkClient): void;
    quit(): void;
    log(line: string): void;
}

const RETRY_MS = 2_000;

export function runBrowserLink(ports: BrowserLinkPorts): { readonly linked: Promise<void>; stop(): void } {
    let stopped = false;
    let client: BrowserLinkClient | null = null;
    let known = false;
    const held: Array<() => void> = [];
    let firstLink: () => void = () => {};
    const linked = new Promise<void>((resolve) => { firstLink = resolve; });

    const onFacts = (facts: BrowserFacts): void => {
        ports.facts(facts);
        known = true;
        for (const run of held.splice(0)) run();
    };
    const onEvent = (event: BrowserEvent): void => {
        if (event.kind === 'facts') onFacts(event.facts);
        else if (event.kind === 'door') ports.door(event.up);
        else if (event.kind === 'quit') ports.quit();
        else if (event.kind === 'pages' || event.kind === 'poppedBack') return;
        else if (event.kind === 'cookies' || event.kind === 'cookiesWanted') ports.other?.(event);
        else if (event.kind === 'closeSingle') ports.closeSingle?.(event.panelKey);
        else if (event.kind === 'openSingle') { if (known) ports.openSingle?.(event.panelKey, event.url); else held.push(() => ports.openSingle?.(event.panelKey, event.url)); }
        else if (event.kind === 'pageCall') { if (client) ports.pageCall?.(event, client); }
        else if (known) ports.open(event.url, event.activation);
        else held.push(() => ports.open(event.url, event.activation));
    };

    const link = async (): Promise<void> => {
        while (!stopped) {
            const found = await ports.connect(() => {
                client = null;
                if (stopped) return;
                ports.door(false);
                ports.log('browser: the link to the host dropped; trying again');
                void link();
            }).catch((error: unknown) => { ports.log(`browser: no host: ${error instanceof Error ? error.message : String(error)}`); return null; });
            if (found === null) { await ports.sleep(RETRY_MS); continue; }
            client = found;
            found.onBrowserEvent(onEvent);
            const answer = await found.browserCall('register', []) as { facts: BrowserFacts | null; doorUp: boolean };
            if (answer.facts !== null) onFacts(answer.facts);
            ports.door(answer.doorUp);
            ports.linked?.(found);
            firstLink();
            return;
        }
    };
    void link().catch((error: unknown) => ports.log(`browser: linking failed: ${error instanceof Error ? error.message : String(error)}`));

    return {
        linked,
        stop() { stopped = true; client?.close(); client = null; },
    };
}
