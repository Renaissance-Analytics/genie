import type { CallContext } from '../core/remote-protocol.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';

/**
 * THE HOST'S TOOLS IN THE LAUNCHER'S UPDATES (Tynn #1058 L7, #716). Skeleton: the red step's exports only.
 */

export const LAUNCHER_FEATURE_CALLER = 'genie-launcher';

export interface LauncherToolchainFeatures {
    snapshot(context: CallContext): Promise<FeatureData>;
    act(action: FeatureAction, context: CallContext): Promise<FeatureData>;
}

export interface LauncherToolchain {
    call(method: string, args: readonly unknown[]): Promise<unknown>;
}

export function launcherToolchain(_features: () => LauncherToolchainFeatures | null): LauncherToolchain {
    return { call: async () => { throw new Error('not built yet'); } };
}
