import { describe, expect, it, vi } from 'vitest';
import { RESTRICTED_CALL_CONTEXT, type CallContext } from '../src/core/remote-protocol.js';
import type { FeatureData } from '../src/renderer/features.js';
import { buildHostApi } from '../src/main/host-api.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

// A hook-boundary test, not a substitute for the later real-contributor/no-window service tests.
// Calls here carry the context the real RemoteHost admitted; nothing launches a host or provider.
const caller = (connectionId: string, origin: CallContext['origin'], readonly = false): CallContext => Object.freeze({
    connectionId, origin, profile: 'desktop', isOwner: true, workspaceId: null, readonly, label: connectionId,
});
const ownWindows = [
    { name: 'local window A', context: caller('window-a', 'local-window') },
    { name: 'local window B', context: caller('window-b', 'local-window') },
];
const otherCallers = [
    { name: 'remote window', context: caller('remote-window', 'remote-window') },
    { name: 'paired device', context: caller('paired-device', 'device') },
    { name: 'read-only relay owner', context: caller('relay-owner', 'relay', true) },
];
const answer = { knowledge: { hits: null } } as unknown as FeatureData;

function subject() {
    const deps = protocolContractDeps('/fixture-workspace');
    const snapshot = vi.fn(async (_context?: CallContext) => answer);
    const picked = vi.fn((_paths: unknown[], _context?: CallContext) => {});
    const act = vi.fn(async (_action: unknown, _context?: CallContext) => answer);
    Object.assign(deps.features, { snapshot, picked, act });
    return { api: buildHostApi(deps), snapshot, picked, act };
}

describe('feature hooks keep the admitted caller (Tynn #720)', () => {
    it.each([...ownWindows, ...otherCallers])('$name snapshot carries its original admitted context', async ({ context }) => {
        const s = subject();
        expect(await s.api.invoke('features.snapshot', [], context)).toBe(answer);
        expect(s.snapshot).toHaveBeenCalledExactlyOnceWith(context);
        expect(s.snapshot.mock.calls[0]![0]).toBe(context);
    });

    it.each(ownWindows)('$name picks carry paths and their original admitted context', async ({ context }) => {
        const s = subject(), paths = ['/fixture-workspace/chosen.txt'];
        expect(await s.api.invoke('features.picked', [paths], context)).toBeNull();
        expect(s.picked).toHaveBeenCalledExactlyOnceWith(paths, context);
        expect(s.picked.mock.calls[0]![0]).toBe(paths);
        expect(s.picked.mock.calls[0]![1]).toBe(context);
    });

    it.each([
        { name: 'absent', context: undefined },
        { name: 'restricted', context: RESTRICTED_CALL_CONTEXT },
    ])('$name context refuses a feature snapshot before reading caller state', async ({ context }) => {
        const s = subject();
        await expect(s.api.invoke('features.snapshot', [], context)).rejects.toThrow(/admitted caller/i);
        expect(s.snapshot).not.toHaveBeenCalled();
    });

    it.each(otherCallers)('CONTROL: $name cannot register local file picks', async ({ context }) => {
        const s = subject();
        expect(await s.api.invoke('features.picked', [['/fixture-workspace/chosen.txt']], context)).toBeNull();
        expect(s.picked).not.toHaveBeenCalled();
    });

    it('CONTROL: absent context cannot register local file picks', async () => {
        const s = subject();
        expect(await s.api.invoke('features.picked', [['/fixture-workspace/chosen.txt']])).toBeNull();
        expect(s.picked).not.toHaveBeenCalled();
    });

    it('CONTROL: an action already carries its admitted context unchanged', async () => {
        const s = subject(), action = { kind: 'knowledge.search', query: 'fixture' } as const;
        const context = otherCallers[1]!.context;
        expect(await s.api.invoke('features.act', [action], context)).toBe(answer);
        expect(s.act).toHaveBeenCalledExactlyOnceWith(action, context);
    });

    it('CONTROL: a thrown snapshot operation still rejects with its original reason', async () => {
        const s = subject(), failure = new Error('the contributor could not be read');
        s.snapshot.mockRejectedValueOnce(failure);
        await expect(s.api.invoke('features.snapshot', [], ownWindows[0]!.context)).rejects.toBe(failure);
        expect(s.snapshot).toHaveBeenCalledTimes(1);
    });
});
