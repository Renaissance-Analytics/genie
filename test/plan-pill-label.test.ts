import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDraft } from '../src/core/chat-drafts.js';

/**
 * THE PLAN-STEP PILL SAYS WHICH STEP IT IS (genie#1280, the half #1282 could not ship). #1282 put a plan step into the
 * agent's chat as a text paste pill, and the pill read "Pasted text · N characters": react-fancy had no label for a text
 * pill. 5.66.0 adds one (`{ kind: "text", id, text, label? }`, display only; sending still expands to `text`).
 *
 * - The pill's label is the step's first words.
 * - What it sends is unchanged: `Plan step: "<the whole step>"`.
 * - The label survives the draft round trip (genie#1279): a restored pill still names its step.
 *
 * Imported where used, so each test fails for its own reason.
 */
const pill = () => import('../src/core/plan-pill.js') as Promise<Record<string, unknown>>;
const core = () => import('../src/core/chat-drafts.js');
const storeModule = () => import('../src/main/chat-draft-store.js');

type Insert = { agentId: string; focus: boolean; pill: { id: string; text: string; label?: string } };
const STEP = 'Write the migration for the accounts table';

describe('the pill’s label is the step’s first words', () => {
    it('a long step: its first six words, and an ellipsis for the rest', async () => {
        const { planStepInsert } = await pill() as { planStepInsert: (a: string, s: string, n: number) => Insert };
        expect(planStepInsert('a_b', STEP, 1).pill.label).toBe('Write the migration for the accounts…');
    });

    it('a short step: the whole step, no ellipsis', async () => {
        const { planStepInsert } = await pill() as { planStepInsert: (a: string, s: string, n: number) => Insert };
        expect(planStepInsert('a_b', 'Run the suite', 2).pill.label).toBe('Run the suite');
        expect(planStepInsert('a_b', 'One two three four five six', 3).pill.label).toBe('One two three four five six');
    });

    it('whitespace and line breaks are words’ gaps, not part of the label', async () => {
        const { planStepInsert } = await pill() as { planStepInsert: (a: string, s: string, n: number) => Insert };
        expect(planStepInsert('a_b', '  Read\n the\t\tbrief  ', 4).pill.label).toBe('Read the brief');
    });

    it('one very long word is still no more than react-fancy’s 80 characters', async () => {
        const { planStepInsert } = await pill() as { planStepInsert: (a: string, s: string, n: number) => Insert };
        const label = planStepInsert('a_b', `${'x'.repeat(200)} and more`, 5).pill.label!;
        expect(label.length).toBeLessThanOrEqual(80);
        expect(label.endsWith('…')).toBe(true);
        expect(label.startsWith('xxxx')).toBe(true);
    });

    it('what the pill SENDS is unchanged: the whole step, quoted as a plan step', async () => {
        const { planStepInsert } = await pill() as { planStepInsert: (a: string, s: string, n: number) => Insert };
        expect(planStepInsert('a_b', STEP, 6).pill.text).toBe(`Plan step: "${STEP}"`);
        expect(planStepInsert('a_b', `  ${STEP}\n`, 7).pill.text).toBe(`Plan step: "${STEP}"`);
    });

    it('the pill put into the draft carries the label, next to the full text', async () => {
        const { planStepInsert, withPill } = await pill() as {
            planStepInsert: (a: string, s: string, n: number) => Insert;
            withPill: (d: ChatDraft, p: Insert['pill']) => ChatDraft;
        };
        const insert = planStepInsert('a_b', STEP, 8);
        const d = withPill({ v: 1, text: '', pills: [], attachments: [] }, insert.pill);
        expect(d.pills).toEqual([{ kind: 'text', id: insert.pill.id, text: `Plan step: "${STEP}"`, label: 'Write the migration for the accounts…' }]);
    });
});

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'genie-pill-label-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const labelled = (): ChatDraft => ({
    v: 1,
    text: 'about ￼plan-step-9￼ ',
    pills: [{ kind: 'text', id: 'plan-step-9', text: `Plan step: "${STEP}"`, label: 'Write the migration for the accounts…' }],
    attachments: [],
} as ChatDraft);

describe('the label survives the draft round trip (genie#1279)', () => {
    it('read back (core/chat-drafts.ts readChatDraft): the label is kept', async () => {
        const { readChatDraft } = await core();
        expect(readChatDraft(JSON.parse(JSON.stringify(labelled())))).toEqual(labelled());
    });

    it('every chat’s drafts read back at load (parseChatDrafts): the label is kept', async () => {
        const { parseChatDrafts } = await core();
        expect(parseChatDrafts(JSON.parse(JSON.stringify({ a_b: labelled() })))).toEqual({ a_b: labelled() });
    });

    it('saved in main’s store, Genie restarted, read back: the label is there', async () => {
        const { ChatDraftStore } = await storeModule();
        const first = await ChatDraftStore.open(home);
        await first.save('a_b', labelled());
        const second = await ChatDraftStore.open(home);
        expect(second.all()).toEqual({ a_b: labelled() });
    });

    it('CONTROL: a text pill with no label reads back with no label key at all, as before', async () => {
        const { readChatDraft } = await core();
        const d = readChatDraft({ v: 1, text: 'x', pills: [{ kind: 'text', id: 'p', text: 't' }], attachments: [] });
        expect(d).not.toBeNull();
        expect('label' in d!.pills[0]!).toBe(false);
    });

    it('a non-string label is dropped (react-fancy’s own rule), and the draft is still read', async () => {
        const { readChatDraft } = await core();
        const d = readChatDraft({ v: 1, text: 'x', pills: [{ kind: 'text', id: 'p', text: 't', label: 42 }], attachments: [] });
        expect(d).not.toBeNull();
        expect(d!.pills[0]).toStrictEqual({ kind: 'text', id: 'p', text: 't' });
    });
});

describe('the react-fancy Genie runs has text-pill labels', () => {
    it('pinned at 5.66.0, and installed at 5.66 or later', () => {
        const ours = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
        expect(ours.dependencies['@particle-academy/react-fancy']).toBe('5.66.0');
        const pkg = JSON.parse(readFileSync(new URL('../node_modules/@particle-academy/react-fancy/package.json', import.meta.url), 'utf8')) as { version: string };
        const [major, minor] = pkg.version.split('.').map(Number) as [number, number];
        expect(major > 5 || (major === 5 && minor >= 66), pkg.version).toBe(true);
    });
});
