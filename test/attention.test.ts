import { describe, expect, it } from 'vitest';
import {
    LIST_LIMITS,
    addToList,
    looksLikeQuestion,
    questionKey,
    validateQuestions,
    type ListItem,
} from '../src/core/attention.js';

/**
 * THE ATTENTION PROTOCOL — the pure half (§6.3): the two lists' rules, what a question must
 * look like, and how a repeated question is recognised so it is rejoined rather than duplicated.
 */

const item = (text: string, i: number): ListItem => ({ id: `li_${i}`, text, askedBy: 'agent_x', createdAt: '2026-10-11T00:00:00Z', done: false });

describe('the two lists refuse when full rather than dropping the oldest', () => {
    it('states the limits the spec names', () => {
        expect(LIST_LIMITS).toEqual({ agent: 10, user: 5 });
    });

    it('an agent checklist takes a 10th item and refuses an 11th, keeping all 10', () => {
        const nine = Array.from({ length: 9 }, (_, i) => item(`t${i}`, i));
        const ten = addToList('agent', nine, item('t9', 9));
        expect(ten.kind).toBe('added');
        if (ten.kind !== 'added') throw new Error('unreachable');
        expect(ten.items).toHaveLength(10);

        const eleventh = addToList('agent', ten.items, item('t10', 10));
        expect(eleventh).toEqual({ kind: 'full', limit: 10, items: ten.items });
        // COUNTED: the oldest is still there — nothing was dropped to make room.
        if (eleventh.kind !== 'full') throw new Error('unreachable');
        expect(eleventh.items.filter((x) => x.text === 't0')).toHaveLength(1);
    });

    it('the user list is capped at 5', () => {
        const five = Array.from({ length: 5 }, (_, i) => item(`u${i}`, i));
        expect(addToList('user', five, item('u5', 5)).kind).toBe('full');
        expect(addToList('user', five.slice(0, 4), item('u4', 4)).kind).toBe('added');
    });

    it('DONE items do not count against the cap', () => {
        const ten = Array.from({ length: 10 }, (_, i) => ({ ...item(`t${i}`, i), done: i < 3 }));
        expect(addToList('agent', ten, item('t10', 10)).kind).toBe('added');
    });

    it('a QUESTION is never a list item', () => {
        expect(looksLikeQuestion('Which port should the server use?')).toBe(true);
        expect(looksLikeQuestion('Should I merge PR #12')).toBe(true);
        expect(looksLikeQuestion('Rotate the GitHub token')).toBe(false);
        expect(looksLikeQuestion('Decide on the browser engine (see the plan)')).toBe(false);

        const r = addToList('user', [], item('Can you approve the release?', 0));
        expect(r.kind).toBe('question');
        if (r.kind !== 'question') throw new Error('unreachable');
        expect(r.reason).toMatch(/ForceTheQuestion/);
    });
});

describe('ForceTheQuestion — shape', () => {
    const q = (n: number, opts: number) => ({
        header: `Q${n}`,
        question: `Question ${n}?`,
        options: Array.from({ length: opts }, (_, i) => ({ label: `o${i}` })),
    });

    it('accepts 1–4 questions with 2–4 options each', () => {
        expect(validateQuestions([q(1, 2)])).toBeNull();
        expect(validateQuestions([q(1, 4), q(2, 3), q(3, 2), q(4, 2)])).toBeNull();
    });

    it('refuses zero or five questions, and one or five options, naming which', () => {
        expect(validateQuestions([])).toMatch(/1.*4 questions/);
        expect(validateQuestions([q(1, 2), q(2, 2), q(3, 2), q(4, 2), q(5, 2)])).toMatch(/1.*4 questions/);
        expect(validateQuestions([q(1, 1)])).toMatch(/Q1.*2.*4 options/);
        expect(validateQuestions([q(1, 2), q(2, 5)])).toMatch(/Q2.*2.*4 options/);
    });

    it('refuses a header over 12 characters', () => {
        expect(validateQuestions([{ ...q(1, 2), header: 'ThirteenChars' }])).toMatch(/header/);
    });
});

describe('a repeated question is REJOINED, not duplicated', () => {
    const base = {
        header: 'Engine',
        question: 'Which browser engine?',
        options: [{ label: 'webContents' }, { label: 'BrowserWindow' }],
    };

    it('the same questions from the same agent produce the same key', () => {
        expect(questionKey('agent_a', [base])).toBe(questionKey('agent_a', [{ ...base }]));
    });

    it('a different option, wording or asker produces a different key', () => {
        const k = questionKey('agent_a', [base]);
        expect(questionKey('agent_b', [base])).not.toBe(k);
        expect(questionKey('agent_a', [{ ...base, question: 'Which browser engine? (v2)' }])).not.toBe(k);
        expect(questionKey('agent_a', [{ ...base, options: [...base.options, { label: 'iframe' }] }])).not.toBe(k);
    });

    it('option DESCRIPTIONS do not change the key — the decision is the same decision', () => {
        const k = questionKey('agent_a', [base]);
        const described = { ...base, options: base.options.map((o) => ({ ...o, description: 'more words' })) };
        expect(questionKey('agent_a', [described])).toBe(k);
    });
});
