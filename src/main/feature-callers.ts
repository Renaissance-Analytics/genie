import type { CallContext } from '../core/remote-protocol.js';
import type { DeckItem } from '../core/deck.js';
import type { FeatureAction } from '../renderer/features.js';
import type { HostFeaturePresentation, HostFeatures } from './features-host.js';

export type FeatureEffect = (connectionId: string, method: string, args: unknown[]) => Promise<unknown>;
export type FeatureBrowser = { url: string | null; canGoBack: boolean; canGoForward: boolean };
const NO_WINDOW = 'this feature action needs its caller’s own admitted local window; open Genie there and try again';

/** Engine connections own their forwarded callers and their effects; no window is selected by recency. */
export class FeatureCallers {
    readonly #callers = new Map<string, { owner: string; context: CallContext; effect: FeatureEffect; browser: FeatureBrowser | null }>();
    constructor(readonly service: () => HostFeatures | null) {}

    async call(owner: string, method: string, args: unknown[], raw: unknown, effect: FeatureEffect, browser: FeatureBrowser | null): Promise<unknown> {
        if (method === 'invalidate') { this.service()?.invalidate(); return null; }
        if (method === 'soundData') { const service = this.service(); if (!service) throw new Error('Genie’s feature services are still starting'); return service.soundData(String(args[0] ?? '')); }
        if (method === 'syncAgentDocs' || method === 'syncConfig') {
            const services = this.service()?.ports.machine?.services;
            if (!services || typeof args[0] !== 'string') throw new Error('workspace file services are still starting');
            const source = args[1] === 'you' ? 'you' : 'start';
            try { return await (method === 'syncAgentDocs' ? services.syncAgentDocs(args[0], source) : services.syncConfig(args[0], source)); }
            finally { this.service()?.invalidate(); }
        }
        const context = admittedContext(raw);
        const key = JSON.stringify([owner, context.connectionId]);
        const scoped = { ...context, connectionId: key };
        const service = this.service();
        if (!service) throw new Error('Genie’s feature services are still starting; try again in a moment');
        if (method === 'releaseCaller') { service.releaseCaller(scoped); this.#callers.delete(key); return null; }
        if (!this.#callers.has(key) && this.#callers.size >= 256) throw new Error('too many feature callers are connected; close an unused window and try again');
        const previous = this.#callers.get(key);
        if (previous) { previous.browser = browser; previous.effect = effect; }
        else this.#callers.set(key, { owner, context: scoped, effect, browser });
        switch (method) {
            case 'snapshot': return service.snapshot(scoped);
            case 'act': return service.act(args[0] as FeatureAction, scoped);
            case 'picked': service.picked(Array.isArray(args[0]) ? args[0] : [], scoped); return null;
            default: throw new Error('unknown feature operation');
        }
    }

    presentation(context: CallContext): HostFeaturePresentation | null {
        const binding = this.#callers.get(context.connectionId);
        if (!binding || binding.context.origin !== 'local-window') return null;
        const original = JSON.parse(context.connectionId) as [string, string];
        const call = async <T>(method: string, args: unknown[] = []): Promise<T> => {
            if (this.#callers.get(context.connectionId) !== binding) throw new Error(NO_WINDOW);
            const answer = await binding.effect(original[1], method, args) as { value?: unknown; browser?: FeatureBrowser | null };
            if (!answer || typeof answer !== 'object' || !Object.hasOwn(answer, 'value') || !Object.hasOwn(answer, 'browser')) throw new Error('the caller’s window answered with an invalid feature effect');
            if (this.#callers.get(context.connectionId) !== binding) throw new Error(NO_WINDOW);
            binding.browser = answer.browser ?? null;
            return answer.value as T;
        };
        return {
            openFlowEditor: route => call<void>('flowEditor', [route]),
            openInBrowser: url => call('openInBrowser', [url]),
            openExternal: url => call<void>('openExternal', [url]),
            login: provider => call('login', [provider]),
            rendererNotice: { dismiss: () => call('rendererNotice.dismiss') },
            mainErrors: { deckItems: () => call<readonly DeckItem[]>('mainErrors.deckItems'), dismiss: id => call<boolean>('mainErrors.dismiss', [id]),
                retryHostCopy: id => call('mainErrors.retryHostCopy', [id]), openLog: id => call('mainErrors.openLog', [id]), report: id => call('mainErrors.report', [id]) },
            ...(binding.browser ? { browser: { snapshot: () => binding.browser!, navigate: url => call<void>('browser.navigate', [url]),
                back: () => call<void>('browser.back'), forward: () => call<void>('browser.forward'), reload: () => call<void>('browser.reload') } } : {}),
        };
    }

    dropOwner(owner: string): void {
        for (const [key, value] of this.#callers) if (value.owner === owner) { this.service()?.releaseCaller(value.context); this.#callers.delete(key); }
    }
}

function admittedContext(raw: unknown): CallContext {
    if (!raw || typeof raw !== 'object') throw new Error('features need an admitted caller');
    const v = raw as CallContext;
    if (typeof v.connectionId !== 'string' || !v.connectionId || v.connectionId.length > 256 || typeof v.label !== 'string'
        || !['local-window', 'remote-window', 'device', 'relay'].includes(v.origin)
        || !['desktop', 'mobile'].includes(v.profile) || typeof v.isOwner !== 'boolean' || typeof v.readonly !== 'boolean'
        || (v.workspaceId !== null && typeof v.workspaceId !== 'string')) throw new Error('features need an admitted caller');
    return { connectionId: v.connectionId, label: v.label, origin: v.origin, profile: v.profile, isOwner: v.isOwner, workspaceId: v.workspaceId, readonly: v.readonly };
}
