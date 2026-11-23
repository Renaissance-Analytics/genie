import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';

/**
 * TURNING DO NOT DISTURB OFF OPENS THE QUESTIONS THAT WAITED (Tynn #721; the owner, 2026-11-14). While it is on, a
 * ForceTheQuestion question only waits (a badge). When it goes off, by hand or on its schedule, the questions still
 * pending open in the usual modal, one at a time, highest priority first then oldest. Answered, cancelled and dismissed
 * ones are not reopened; with none pending nothing opens.
 */
const q = (id: string, at: number, priority: 'urgent' | 'high' | 'normal' | 'low' = 'normal'): DeckItem => ({
    id, source: 'agent-question', agentId: `agent_${id}`, agentName: 'kai', workspaceId: 'ws_01HTYNN', workspaceName: 'Tynn.ai', title: 'Pick', blocking: false, priority, at,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
    forwardedFrom: null,
} as unknown as DeckItem);

function harness(initial: DeckItem[] = [], dnd = true) {
    let items = initial;
    let dndOn = dnd;
    const log: string[] = [];
    const ctl = new QuestionWindow({
        items: () => items,
        open: () => { log.push('open'); return { show: (v: QuestionView) => { log.push(`show ${v.item.id}`); }, close: () => { log.push('close'); } }; },
        answer: async (item) => { items = items.filter((i) => i.id !== item.id); },
        dismiss: async (item) => { items = items.filter((i) => i.id !== item.id); },
        dnd: () => dndOn,
    });
    return {
        ctl, log,
        set: (next: DeckItem[]) => { items = next; ctl.changed(); },
        dnd: (on: boolean) => { dndOn = on; ctl.changed(); },
    };
}

describe('Do Not Disturb off opens what waited', () => {
    it('DnD on, a question is asked: no modal (control)', () => {
        const h = harness();
        h.set([q('a', 10)]);
        expect(h.log).toEqual([]);
        expect(h.ctl.showing).toBeNull();
    });

    it('DnD off: the modal opens with that question', () => {
        const h = harness();
        h.set([q('a', 10)]);
        h.dnd(false);
        expect(h.log).toEqual(['open', 'show a']);
        expect(h.ctl.showing).toBe('a');
    });

    it('a question answered while DnD was on stays closed', () => {
        const h = harness();
        h.set([q('a', 10), q('b', 20)]);
        h.set([q('b', 20)]);
        h.dnd(false);
        expect(h.log).toEqual(['open', 'show b']);
    });

    it('a question dismissed or withdrawn while DnD was on stays closed, and with none pending nothing opens', () => {
        const h = harness();
        h.set([q('a', 10)]);
        h.set([]);
        h.dnd(false);
        expect(h.log).toEqual([]);
    });

    it('two pending open in order: highest priority first, then oldest, one at a time', async () => {
        const h = harness();
        h.set([q('old', 10), q('rush', 30, 'high'), q('new', 20)]);
        h.dnd(false);
        expect(h.log).toEqual(['open', 'show rush']);
        await h.ctl.answer([['A']], ['']);
        expect(h.log.at(-1)).toBe('show old');
        await h.ctl.answer([['A']], ['']);
        expect(h.log.at(-1)).toBe('show new');
    });

    it('a question put off with Later before DnD is not reopened by it', () => {
        const h = harness([q('later', 5)], false);
        h.ctl.changed();
        h.ctl.later();
        h.dnd(true);
        h.set([q('later', 5), q('a', 10)]);
        h.dnd(false);
        expect(h.log.filter((l) => l.startsWith('show')).at(-1)).toBe('show a');
    });

    it('DnD staying off does not reopen anything: only the change from on to off does (control)', () => {
        const h = harness([], false);
        h.ctl.changed();
        h.dnd(false);
        expect(h.log).toEqual([]);
    });
});

describe('Genie wires it', () => {
    it('main re-checks the window when the Do Not Disturb setting changes (by hand or on its schedule)', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        expect(main).toMatch(/settingsNow\.onChange\(\(key\)\s*=>\s*\{\s*if \(key === 'do_not_disturb'\) questionWindow\?\.changed\(\);\s*\}\)/);
    });
});
