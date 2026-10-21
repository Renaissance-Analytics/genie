import { describe, expect, it } from 'vitest';
import { addConfirmer, type AddOutcome } from '../src/renderer/add-confirm.js';

/**
 * CONFIRMING AN ADD (parity rows 25 and 38).
 *
 * Row 25: Genie 1's confirm buttons could not be pressed twice. Genie 2's "Clone and add" stayed live through a clone that
 * can take minutes, so a second click started a second clone into the same folder. The controller behind the button starts
 * nothing while an add is running — a click that lands before React redraws the button is refused here too — and keeps the
 * busy state for the whole run.
 *
 * Row 38: New opened the workspace it made; Import from Git, Import from Tynn and Open existing just closed the plan and
 * left the person where they were. Each now opens the workspace it added, as New does.
 */

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

function harness() {
    const busy: boolean[] = [];
    const previews: Array<{ ok: false; reason: string } | null> = [];
    const opened: string[] = [];
    const confirm = addConfirmer(() => ({ setBusy: (b) => busy.push(b), setPreview: (p) => previews.push(p), open: (r) => opened.push(r) }));
    return { busy, previews, opened, confirm };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the add confirmer', () => {
    it('a second confirm while the first runs starts NOTHING; the busy state covers the whole run; the added workspace opens', async () => {
        const h = harness();
        const d = deferred<AddOutcome>();
        let runs = 0;
        const run = () => { runs++; return d.promise; };
        h.confirm(run);
        h.confirm(run); // the double click
        expect(runs).toBe(1);
        expect(h.busy).toEqual([true]);
        d.resolve({ ok: true, id: 'fancy-ui' });
        await settle();
        expect(h.busy).toEqual([true, false]);
        expect(h.previews).toEqual([null]);
        expect(h.opened).toEqual(['genie://workspace/fancy-ui']);
        // Positive control: the guard lets go once the add has finished — a later confirm runs.
        h.confirm(() => { runs++; return Promise.resolve({ ok: true, id: 'other' }); });
        await settle();
        expect(runs).toBe(2);
        expect(h.opened).toEqual(['genie://workspace/fancy-ui', 'genie://workspace/other']);
    });

    it('a refusal shows the reason, opens nothing, and frees the button', async () => {
        const h = harness();
        h.confirm(() => Promise.resolve({ ok: false, reason: 'git clone failed: fatal: repository not found' }));
        await settle();
        expect(h.opened).toEqual([]);
        expect(h.previews).toEqual([{ ok: false, reason: 'git clone failed: fatal: repository not found' }]);
        expect(h.busy).toEqual([true, false]);
    });

    it('a throw is a refusal in its own words, never a button stuck on "Cloning…"', async () => {
        const h = harness();
        h.confirm(() => Promise.reject(new Error('the host went away')));
        await settle();
        expect(h.previews).toEqual([{ ok: false, reason: 'the host went away' }]);
        expect(h.busy).toEqual([true, false]);
        expect(h.opened).toEqual([]);
    });

    it('no bridge to ask: nothing runs and nothing is marked busy', () => {
        const h = harness();
        h.confirm(() => undefined);
        expect(h.busy).toEqual([]);
    });
});
