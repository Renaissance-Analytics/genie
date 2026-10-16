import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MainErrorBook } from '../src/core/main-errors.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE DECK'S DISMISS ON A MAIN-PROCESS ERROR goes through the same feature action as every other inline Deck answer,
 * and reaches the book main.ts passes in its ports. Refused with a reason — never swallowed — when nothing is wired or
 * the item is already gone. Red on origin/main: there is no `dismiss-main-error` command and no `mainErrors` port.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

let dir: string;
let services: ComposedServices;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-main-errors-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('deck.answer on a recorded main-process error', () => {
    it('Dismiss removes it from the book the ports carry', async () => {
        const book = new MainErrorBook();
        book.record('uncaught-exception', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        const item = book.deckItems()[0]!;
        await handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'dismiss' }, state(), { mainErrors: book });
        expect(book.list()).toEqual([]);
        expect(book.deckItems()).toEqual([]);
    });

    it('an item already dismissed is refused with its id; with no book wired the refusal says so', async () => {
        const book = new MainErrorBook();
        book.record('unhandled-rejection', 'connect ECONNREFUSED genie.example:443');
        const item = book.deckItems()[0]!;
        await expect(handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'dismiss' }, state())).rejects.toThrow('the main process’s error record is not wired into this Genie; nothing was dismissed');
        expect(book.list()).toHaveLength(1);
        await handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'dismiss' }, state(), { mainErrors: book });
        await expect(handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'dismiss' }, state(), { mainErrors: book })).rejects.toThrow(`no recorded error ${item.id}`);
    });
});
