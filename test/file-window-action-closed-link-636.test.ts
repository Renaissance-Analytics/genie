import { describe, expect, it, vi } from 'vitest';
import { moveFilePanel } from '../src/renderer/file-window-action.js';

// Controlled promise-shaped window call; records escaped rejection without changing runner global handlers.
function pendingMove() {
    let success: (() => unknown) | undefined;
    let failure: ((error: unknown) => unknown) | undefined;
    const escaped: unknown[] = [];
    const chain = {
        then(ok: () => unknown, bad?: (error: unknown) => unknown) { success = ok; if (bad) failure = bad; return chain; },
        catch(bad: (error: unknown) => unknown) { failure = bad; return chain; },
    };
    return { promise: chain as unknown as Promise<void>, escaped, resolve: () => { success?.(); }, reject: () => {
        const error = new Error('the connection closed: synthetic internal detail\n    at fixture/internal.ts:1:2');
        if (!failure) escaped.push(error); else { try { failure(error); } catch (thrown) { escaped.push(thrown); } }
    } };
}

describe('file-window moves report failure and keep the current route (#636)', () => {
    it('changes the route only after the move is confirmed, not while the request is pending', () => {
        const call = pendingMove(); const moved = vi.fn(); const refused = vi.fn();
        moveFilePanel(() => call.promise, moved, refused);
        expect(moved).not.toHaveBeenCalled(); expect(refused).not.toHaveBeenCalled();
        call.resolve(); expect(moved).toHaveBeenCalledTimes(1);
    });

    it('owns a rejected move, keeps the route and says what failed without internal diagnostics or replay', () => {
        const call = pendingMove(); const run = vi.fn(() => call.promise); const moved = vi.fn(); const refused = vi.fn();
        moveFilePanel(run, moved, refused); call.reject();
        expect(call.escaped).toEqual([]); expect(moved).not.toHaveBeenCalled();
        expect(refused).toHaveBeenCalledTimes(1);
        expect(refused.mock.calls[0]![0]).toMatch(/^The file panel could not be moved\./);
        expect(refused.mock.calls[0]![0]).not.toMatch(/synthetic|internal\.ts|\n\s*at /);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('owns a synchronous window refusal without moving the route', () => {
        const moved = vi.fn(); const refused = vi.fn();
        expect(() => moveFilePanel(() => { throw new Error('the connection closed'); }, moved, refused)).not.toThrow();
        expect(moved).not.toHaveBeenCalled(); expect(refused).toHaveBeenCalledTimes(1);
    });

    it('does not claim the panel moved if this bridge has no native file-window port', () => {
        const moved = vi.fn(); const refused = vi.fn();
        moveFilePanel(() => undefined, moved, refused);
        expect(moved).not.toHaveBeenCalled(); expect(refused).toHaveBeenCalledWith('File panels can only be moved from this Genie window.');
    });

    it.each([['pop out', 'detached'], ['bring back', 'attached']] as const)('CONTROL: a successful %s still reaches its route once', (_action, target) => {
        const call = pendingMove(); const run = vi.fn(() => call.promise); const refused = vi.fn();
        let route = 'original'; const moved = vi.fn(() => { route = target; });
        moveFilePanel(run, moved, refused); call.resolve();
        expect(route).toBe(target); expect(moved).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1); expect(refused).not.toHaveBeenCalled();
    });
});
