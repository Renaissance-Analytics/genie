import type { ServiceInstance } from './services.js';

/** STUB for the red commit (parity audit #12): the real rules land with the fix. */
export interface EngineUse {
    readonly chosen: (workspaceId: string) => ReadonlySet<string>;
}
export function enginesToRelease(_input: EngineUse & { workspaceId: string; instances: readonly ServiceInstance[]; workspaces: readonly { id: string; asleep: boolean }[] }): string[] { return []; }
export function enginesToResume(_input: EngineUse & { workspaceId: string; instances: readonly ServiceInstance[]; personStopped: ReadonlySet<string> }): string[] { return []; }
export function asleepOnlyEngine(_i: ServiceInstance, _input: EngineUse & { workspaces: readonly { id: string; asleep: boolean }[] }): boolean { return false; }
