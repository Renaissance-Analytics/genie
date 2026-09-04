/**
 * The `files:added` producer — the first system trigger, and the one the
 * owner's reference case rides.
 *
 * A producer owns both the DEFINITION of its event and the code that notices it
 * happening, so the props a filter can be written against and the props actually
 * emitted cannot drift apart. These tests hold that together: every prop the
 * definition declares must appear on a real event.
 */

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { FILE_ADDED_EVENT, buildFileAddedEvent, startFlowFileSource } from '../file-source';
import type { FileWatchEvent } from '../../files/watch';
import type { FlowEvent } from '../types';

const WS = { id: 'ws-1', root: path.join('/', 'projects', 'demo') };

function input(over: Partial<Parameters<typeof buildFileAddedEvent>[0]> = {}) {
    return {
        workspaceId: WS.id,
        workspacePath: WS.root,
        relPath: 'assets/video.mp4',
        eventType: 'rename' as const,
        stat: { isFile: true, size: 6_000_000 },
        ...over,
    };
}

describe('buildFileAddedEvent', () => {
    it('emits every prop the event definition declares', () => {
        const event = buildFileAddedEvent(input());
        expect(event).not.toBeNull();
        for (const prop of FILE_ADDED_EVENT.props) {
            expect(Object.keys(event!.props), `prop "${prop.key}" is declared`).toContain(prop.key);
            expect(typeof event!.props[prop.key]).toBe(prop.type);
        }
    });

    it('describes the file the way a filter would want to ask about it', () => {
        const event = buildFileAddedEvent(input());
        expect(event!.event).toBe(FILE_ADDED_EVENT.id);
        expect(event!.props).toMatchObject({
            workspaceId: 'ws-1',
            workspacePath: WS.root,
            path: path.join(WS.root, 'assets', 'video.mp4'),
            relPath: 'assets/video.mp4',
            name: 'video.mp4',
            extension: 'mp4',
            sizeBytes: 6_000_000,
        });
        expect(event!.source).toEqual({ kind: 'system' });
    });

    it('is not an addition when the OS reported a content change', () => {
        // `change` means an existing file was written to. Treating that as an
        // addition would make an editor's every save look like a new file.
        expect(buildFileAddedEvent(input({ eventType: 'change' }))).toBeNull();
    });

    it('is not an addition when the path no longer exists — that was a delete', () => {
        expect(buildFileAddedEvent(input({ stat: null }))).toBeNull();
    });

    it('is not an addition when the path is a directory', () => {
        expect(buildFileAddedEvent(input({ stat: { isFile: false, size: 0 } }))).toBeNull();
    });

    it('reports an empty extension rather than inventing one', () => {
        const event = buildFileAddedEvent(input({ relPath: 'LICENSE' }));
        expect(event!.props.extension).toBe('');
    });
});

describe('startFlowFileSource', () => {
    type Over = Partial<Parameters<typeof startFlowFileSource>[0]>;

    function harness(over: Over = {}) {
        let deliver: ((e: FileWatchEvent) => void) | null = null;
        const emitted: FlowEvent[] = [];
        const stop = startFlowFileSource({
            subscribe: (l) => {
                deliver = l;
                return () => {
                    deliver = null;
                };
            },
            statFile: () => ({ isFile: true, size: 6_000_000 }),
            workspaceIdFor: (p) => (p === WS.root ? WS.id : undefined),
            emit: (e) => void emitted.push(e),
            settleMs: 0,
            wait: async () => {},
            ...over,
        });
        return {
            stop,
            emitted,
            fire: (e: Partial<FileWatchEvent> = {}) =>
                deliver?.({
                    workspacePath: WS.root,
                    eventType: 'rename',
                    relPath: 'big.bin',
                    ...e,
                }),
        };
    }

    /** The producer settles asynchronously; let its microtasks drain. */
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('emits for a file added under a known workspace', async () => {
        const h = harness();
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(1);
        expect(h.emitted[0].props.relPath).toBe('big.bin');
        h.stop();
    });

    it('waits for a file still being written, so the size it reports is the real one', async () => {
        // THE reason this stage exists. `rename` fires the instant the path
        // appears — at zero bytes. A Flow filtering on "over 5 MB" would never
        // fire for a large file being copied in, which is precisely the case the
        // owner's example is about.
        const sizes = [0, 3_000_000, 6_000_000, 6_000_000];
        let i = 0;
        const h = harness({
            statFile: () => ({ isFile: true, size: sizes[Math.min(i, sizes.length - 1)] }),
            wait: async () => {
                i++;
            },
        });
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(1);
        expect(h.emitted[0].props.sizeBytes).toBe(6_000_000);
        h.stop();
    });

    it('gives up on a file that vanishes while it is settling', async () => {
        let gone = false;
        const h = harness({
            statFile: () => (gone ? null : { isFile: true, size: 10 }),
            wait: async () => {
                gone = true;
            },
        });
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(0);
        h.stop();
    });

    it('ignores a root that is not a registered workspace', async () => {
        const h = harness();
        h.fire({ workspacePath: path.join('/', 'somewhere', 'else') });
        await flush();
        expect(h.emitted).toHaveLength(0);
        // POSITIVE CONTROL: the same harness DOES emit for a known root, so the
        // assertion above is about the root and not about a dead source.
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(1);
        h.stop();
    });

    it('collapses the duplicate events one file creation produces', async () => {
        // Platforms report a single create as several `rename`s, and a file
        // being written produces `change`s in between. Without this a Flow would
        // run several times for one file — and for a Flow that MOVES the file,
        // every run after the first acts on a path that no longer exists.
        let now = 0;
        const h = harness({ dedupeMs: 500, now: () => now });
        h.fire();
        h.fire({ eventType: 'change' });
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(1);

        // POSITIVE CONTROL: past the window it is a new observation again, so
        // the de-duplication is a window and not a permanent mute.
        now += 501;
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(2);
        h.stop();
    });

    it('does not collapse two different files added at the same instant', async () => {
        const h = harness({ dedupeMs: 500, now: () => 0 });
        h.fire({ relPath: 'a.bin' });
        h.fire({ relPath: 'b.bin' });
        await flush();
        expect(h.emitted.map((e) => e.props.relPath).sort()).toEqual(['a.bin', 'b.bin']);
        h.stop();
    });

    it('unsubscribes from the watcher when stopped', () => {
        const unsubscribe = vi.fn();
        const stop = startFlowFileSource({
            subscribe: () => unsubscribe,
            statFile: () => null,
            workspaceIdFor: () => undefined,
            emit: () => {},
        });
        stop();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
});
