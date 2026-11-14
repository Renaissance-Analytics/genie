import type { HostApiDeps } from './host-api.js';
import type { SessionEngineClient } from './session-engine-client.js';
import type { CallContext } from '../core/remote-protocol.js';
import type { FeatureBrowser } from './feature-callers.js';

/** The window holds no feature data. Each read/action belongs to the admitted protocol caller. */
export function featureReplica(client: () => SessionEngineClient, browser: (context: CallContext) => FeatureBrowser | null, localInvalidated?: (listener: () => void) => () => void): HostApiDeps['features'] {
    const call = async <T>(method: string, args: unknown[], context?: CallContext): Promise<T> => {
        const result = await client().call('engine.features', [method, args, context, context ? browser(context) : null]);
        if (!result.ok) throw new Error(result.reason);
        return result.value as T;
    };
    return {
        snapshot: context => call('snapshot', [], context), act: (action, context) => call('act', [action], context),
        picked: (paths, context) => call<void>('picked', [paths], context),
        soundData: key => call('soundData', [key]),
        releaseCaller: context => { void call('releaseCaller', [], context).catch(() => {}); },
        onInvalidated: listener => { const off = client().onFeatureInvalidated(listener); const localOff = localInvalidated?.(listener); return () => { off(); localOff?.(); }; },
    };
}
