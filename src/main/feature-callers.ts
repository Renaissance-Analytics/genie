import type { CallContext } from '../core/remote-protocol.js';
import type { DeckItem } from '../core/deck.js';
import type { HostFeaturePresentation } from './features-host.js';

export type FeatureEffect = (connectionId: string, method: string, args: unknown[]) => Promise<unknown>;
export type FeatureBrowser = { url: string | null; canGoBack: boolean; canGoForward: boolean };
const NO_WINDOW = 'this feature action needs its caller’s own admitted local window; open Genie there and try again';

/**
 * THIS MACHINE'S WINDOWS' FEATURE EFFECTS: each window connection tunnelled to genie-host's RemoteHost is bound to the window
 * process that owns it; no window is selected by recency. Every client reaches the features themselves over the one
 * protocol, where RemoteHost admits it: the engine server's engine.features (step 2e-2, Tynn #914) and the question
 * window's engine.featureQuestion (step 2f-1, Tynn #912) are retired.
 */
export class FeatureCallers {
    /**
     * THIS MACHINE'S WINDOWS, TUNNELLED TO GENIE-HOST'S REMOTEHOST (Tynn #898 step 2d-4b): by the connection id RemoteHost
     * admitted, the window process that owns it, how to ask it for an effect, and its browser pane as it last said.
     */
    readonly #tunnelled = new Map<string, { owner: string; effect: FeatureEffect; browser: FeatureBrowser | null }>();

    presentation(context: CallContext): HostFeaturePresentation | null {
        const binding = this.#tunnelled.get(context.connectionId);
        if (!binding || context.origin !== 'local-window') return null;
        const effectId = context.connectionId;
        const current = () => this.#tunnelled.get(context.connectionId);
        const call = async <T>(method: string, args: unknown[] = []): Promise<T> => {
            if (current() !== binding) throw new Error(NO_WINDOW);
            const answer = await binding.effect(effectId, method, args) as { value?: unknown; browser?: FeatureBrowser | null };
            if (!answer || typeof answer !== 'object' || !Object.hasOwn(answer, 'value') || !Object.hasOwn(answer, 'browser')) throw new Error('the caller’s window answered with an invalid feature effect');
            if (current() !== binding) throw new Error(NO_WINDOW);
            binding.browser = answer.browser ?? null;
            return answer.value as T;
        };
        return {
            openFlowEditor: route => call<void>('flowEditor', [route]),
            openInBrowser: url => call('openInBrowser', [url]),
            openExternal: url => call<void>('openExternal', [url]),
            rendererNotice: { dismiss: () => call('rendererNotice.dismiss') },
            mainErrors: { deckItems: () => call<readonly DeckItem[]>('mainErrors.deckItems'), dismiss: id => call<boolean>('mainErrors.dismiss', [id]),
                retryHostCopy: id => call('mainErrors.retryHostCopy', [id]), openLog: id => call('mainErrors.openLog', [id]), report: id => call('mainErrors.report', [id]) },
            ...(binding.browser ? { browser: { snapshot: () => binding.browser!, navigate: url => call<void>('browser.navigate', [url]),
                back: () => call<void>('browser.back'), forward: () => call<void>('browser.forward'), reload: () => call<void>('browser.reload') } } : {}),
        };
    }

    /** A window's protocol connection, tunnelled to genie-host (protocol-tunnels.ts): its effects go to `owner`'s process. */
    bindConnection(connectionId: string, owner: string, effect: FeatureEffect): void {
        const previous = this.#tunnelled.get(connectionId);
        this.#tunnelled.set(connectionId, { owner, effect, browser: previous?.owner === owner ? previous.browser : null });
    }

    unbindConnection(connectionId: string): void {
        this.#tunnelled.delete(connectionId);
    }

    /** The window's browser pane as its process said it (null = this window has none). */
    connectionBrowser(connectionId: string, browser: FeatureBrowser | null): void {
        const binding = this.#tunnelled.get(connectionId);
        if (binding) binding.browser = browser;
    }

    dropOwner(owner: string): void {
        for (const [key, value] of this.#tunnelled) if (value.owner === owner) this.#tunnelled.delete(key);
    }
}

