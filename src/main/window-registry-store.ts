import type { AgentRecord } from '../core/identity.js';
import type { RemoteMethod } from '../core/remote-protocol.js';
import { callRefusal, type OwnCallAnswer } from './own-protocol-client.js';
import type { RegistryStore } from './registry.js';
import type { RegistryRead, RegistryWrite } from './registry-protocol.js';
import type { RecordChange, WorkspaceRecord } from './store.js';

/**
 * MAIN'S WINDOW REGISTRY, ON GENIE-HOST'S FILES OVER THE ONE PROTOCOL (Tynn #1007, 2g-4e). The same calls the Store
 * answers, asked of genie-host by main's own client: reads with `registry.read`, writes with `registry.write`. A refusal
 * throws its words, as the store's own failure would, so the registry's callers hear it as before. Nothing here touches
 * the engine link.
 */
export type RegistryOwnClient = { call(method: RemoteMethod | 'registry.read', args: unknown[]): Promise<OwnCallAnswer> };

const asked = async (own: RegistryOwnClient, method: RemoteMethod | 'registry.read', args: unknown[]): Promise<unknown> => {
    const answer = await own.call(method, args);
    const refusal = callRefusal(answer);
    if (refusal !== null) throw new Error(refusal);
    return answer.ok ? answer.value : undefined;
};

const list = async <T>(own: RegistryOwnClient, read: RegistryRead): Promise<readonly T[]> => {
    const value = await asked(own, 'registry.read', [read]);
    if (!Array.isArray(value)) throw new Error(`genie-host's registry answered ${read} with something that is not a list`);
    return value as T[];
};

const listOf = <T>(value: unknown, what: string): readonly T[] => {
    if (!Array.isArray(value)) throw new Error(`genie-host's registry answered ${what} with something that is not a list`);
    return value as T[];
};

const write = (own: RegistryOwnClient, method: RegistryWrite, args: unknown[]): Promise<unknown> => asked(own, 'registry.write', [method, args]);

/** Opened once genie-host can be asked: what its store dropped reading the files is read first, for the registry's faults. */
export async function openWindowRegistryStore(own: RegistryOwnClient): Promise<RegistryStore> {
    const dropped = [...(await list<string>(own, 'dropped'))];
    return {
        dropped,
        readWorkspaces: () => list<WorkspaceRecord>(own, 'readWorkspaces'),
        readAgents: () => list<AgentRecord>(own, 'readAgents'),
        readRunningAtQuit: () => list<string>(own, 'readRunningAtQuit'),
        readInterruptedAtQuit: () => list<string>(own, 'readInterruptedAtQuit'),
        // One record at a time (Tynn #1007): what this window changed, never its copy of a whole list.
        changeWorkspaces: async (change: RecordChange<WorkspaceRecord>) => listOf<WorkspaceRecord>(await write(own, 'changeWorkspaces', [change]), 'changeWorkspaces'),
        changeAgents: async (change: RecordChange<AgentRecord>) => listOf<AgentRecord>(await write(own, 'changeAgents', [change]), 'changeAgents'),
        writeRunningAtQuit: async (ids) => { await write(own, 'writeRunningAtQuit', [ids]); },
        writeInterruptedAtQuit: async (ids) => { await write(own, 'writeInterruptedAtQuit', [ids]); },
        beginRestore: async () => {
            const value = (await write(own, 'beginRestore', [])) as { running?: unknown; interrupted?: unknown } | null;
            const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
            return { running: ids(value?.running), interrupted: ids(value?.interrupted) };
        },
        restoreStarted: async (id) => (await write(own, 'restoreStarted', [id])) === true,
    };
}

/**
 * main's registry before genie-host can be asked (Tynn #1007): it holds no file of its own to fall back on, so every call
 * is refused until `openWindowRegistryStore` replaces it, before the registry loads.
 */
export function unopenedRegistryStore(): RegistryStore {
    const refused = async (): Promise<never> => { throw new Error('genie-host’s registry is not open in this window yet'); };
    return {
        dropped: [],
        readWorkspaces: refused, readAgents: refused, readRunningAtQuit: refused, readInterruptedAtQuit: refused,
        changeWorkspaces: refused, changeAgents: refused, writeRunningAtQuit: refused, writeInterruptedAtQuit: refused,
        beginRestore: refused, restoreStarted: refused,
    };
}

/** The watch as the registry's refresh hears it: every view said (the answer, each reconnect, each write) is a change. */
export function registryChanges(own: { watchRegistry(onView: (view: unknown) => void): () => void }): { onRegistryChanged(listener: () => void): () => void } {
    return { onRegistryChanged: (listener) => own.watchRegistry(() => listener()) };
}
