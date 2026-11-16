import { describe, expect, it } from 'vitest';
import type { CloneOffer } from '../src/core/clone-offers.js';
import { offerCommands, offersDialogView } from '../src/core/offers-dialog-view.js';

/**
 * THE OFFERS DIALOG, AS DATA (Tynn #756, the offers UI): what the repo says beside what this machine has, in words. A NEW offer can be
 * applied, unless it would run something and the workspace is not trusted yet (then it shows what it would run, and the trust step
 * comes first). A CHANGED offer is shown with its two sides and no way to apply it: Genie does not replace it. Fixtures: invented names.
 */

const flowDoc = (command: string) => ({ $schema: 'https://particle.academy/schemas/workflow/v1.json', version: 1, graph: { nodes: [{ id: 's', kind: 'genie/terminal_run', config: { workspace: '${workspace}', command } }], edges: [] } });
const logDoc = { $schema: 'https://particle.academy/schemas/workflow/v1.json', version: 1, graph: { nodes: [{ id: 'l', kind: 'log', config: { message: 'tick' } }], edges: [] } };
const offer = (over: Partial<CloneOffer> = {}): CloneOffer => ({ id: 'flow:.flows/a.json', kind: 'flow', file: '.flows/a.json', change: 'new', summary: 'New flow: a', incoming: logDoc, local: null, ...over });
const view = (offers: CloneOffer[] | null, over: Partial<Parameters<typeof offersDialogView>[0]> = {}) => offersDialogView({ offers, trusted: true, busy: null, error: null, notes: {}, ...over });

describe('what each offer shows', () => {
    it('loading until the host answers, then each offer in words with the repo’s side, and this machine’s when it has one', () => {
        expect(view(null).loading).toBe(true);
        const v = view([offer(), offer({ id: 'process:.processes/w.json', kind: 'process', file: '.processes/w.json', change: 'changed', summary: 'Changed process: w', incoming: { command: 'b' }, local: { command: 'a' } })]);
        expect(v.loading).toBe(false);
        expect(v.rows.map((r) => [r.id, r.summary, r.change])).toEqual([['flow:.flows/a.json', 'New flow: a', 'new'], ['process:.processes/w.json', 'Changed process: w', 'changed']]);
        expect(v.rows[0]!.local).toBeNull();
        expect(v.rows[1]!.local).toContain('"command": "a"');
        expect(v.rows[1]!.incoming).toContain('"command": "b"');
    });

    it('a long side is cut with an ellipsis, so a row stays a row', () => {
        const v = view([offer({ incoming: { text: 'x'.repeat(5000) } })]);
        expect(v.rows[0]!.incoming.length).toBeLessThanOrEqual(1201);
        expect(v.rows[0]!.incoming.endsWith('…')).toBe(true);
    });

    it('nothing offered says so, in words', () => {
        const v = view([]);
        expect(v.rows).toEqual([]);
        expect(v.empty).toBe(true);
    });
});

describe('applying', () => {
    it('a new offer that runs nothing can be applied', () => {
        expect(view([offer()]).rows[0]).toMatchObject({ canApply: true, needsTrust: false, commands: [] });
    });

    it('a new offer that would run a command shows it, and before the trust it is the trust step first, not an Apply', () => {
        const run = offer({ incoming: flowDoc('npm run backup') });
        expect(offerCommands(run)).toEqual(['npm run backup']);
        expect(view([run], { trusted: false }).rows[0]).toMatchObject({ canApply: false, needsTrust: true, commands: ['npm run backup'] });
        expect(view([run], { trusted: true }).rows[0]).toMatchObject({ canApply: true, needsTrust: false, commands: ['npm run backup'] });
    });

    it('a process or an agent step is a command too', () => {
        expect(offerCommands(offer({ kind: 'process', file: '.processes/w.json', incoming: { command: 'php artisan queue:work' } }))).toEqual(['php artisan queue:work']);
    });

    it('a CHANGED offer cannot be applied, and says so in the words the host uses', () => {
        const changed = offer({ change: 'changed', summary: 'Changed flow: a', incoming: flowDoc('b'), local: flowDoc('a') });
        const row = view([changed], { trusted: true }).rows[0]!;
        expect(row.canApply).toBe(false);
        expect(row.note).toBe('Genie does not replace it: it differs from what you have here. Change it by hand, or remove it here and apply the new one.');
    });

    it('the one being applied is busy and cannot be pressed again; a refusal is shown on its own row, and an error above', () => {
        const v = view([offer()], { busy: 'flow:.flows/a.json', notes: { 'flow:.flows/a.json': 'it runs commands, so it waits until you trust this workspace' }, error: 'the host is starting' });
        expect(v.rows[0]).toMatchObject({ busy: true, canApply: false, note: 'it runs commands, so it waits until you trust this workspace' });
        expect(v.error).toBe('the host is starting');
    });
});
