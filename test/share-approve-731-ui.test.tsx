// @vitest-environment happy-dom
/**
 * "LET <WHO> IN?" AS THE PERSON AT THE MACHINE SEES IT (Tynn #731). A share-link guest's request uses the same card as
 * "Pair this device?" (never focused, real Allow and Deny, an outcome after), in its own few words: who, through what,
 * and what they could reach. A PIN request reads as it always did (CONTROL).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PairRequest } from '../src/core/pair-confirm.js';
import { PairPrompt } from '../src/renderer/components/PairPrompt.js';

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let el: HTMLDivElement;
let root: Root;

beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
});

afterEach(() => {
    act(() => root.unmount());
    el.remove();
    document.body.innerHTML = '';
});

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const request = (over: Partial<PairRequest> = {}): PairRequest => ({ id: 'pair_1', label: 'wren', from: 'relay:wren', host: 'alphar', replaces: null, raisedAt: NOW, expiresAt: NOW + 120_000, guest: { workspace: 'Tynn App', readonly: false }, ...over });
const text = () => el.textContent ?? '';
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('PairPrompt for a share-link guest (Tynn #731)', () => {
    it('asks "Let wren in?": who, through a share link, what they could reach, with Deny and Allow', () => {
        act(() => root.render(<PairPrompt requests={[request()]} onAnswer={async () => {}} now={NOW} />));
        expect(el.querySelector('h2')?.textContent).toBe('Let wren in?');
        expect(text()).toContain('wren opened a share link to alphar.');
        expect(text()).toContain('They could see and use the Tynn App workspace.');
        expect(text()).not.toContain('Pair this device?');
        expect(el.querySelector('[data-action="allow-pair"]')?.textContent).toBe('Allow');
        expect(el.querySelector('[data-action="deny-pair"]')?.textContent).toBe('Deny');
        expect(el.querySelector('[data-pair-countdown]')?.textContent).toBe('2:00 left');
    });

    it('a read-only guest of the whole machine: "see this whole machine"', () => {
        act(() => root.render(<PairPrompt requests={[request({ guest: { workspace: null, readonly: true } })]} onAnswer={async () => {}} now={NOW} />));
        expect(text()).toContain('They could see this whole machine.');
    });

    it('after the answer it says what happened, in a guest\'s words: let in, or nobody answered', async () => {
        act(() => root.render(<PairPrompt requests={[request()]} onAnswer={async () => {}} now={NOW} />));
        await act(async () => { (el.querySelector('[data-action="allow-pair"]') as HTMLButtonElement).click(); });
        await flush();
        act(() => root.render(<PairPrompt requests={[]} onAnswer={async () => {}} now={NOW} />));
        expect(el.querySelector('[data-pair-outcome]')?.textContent).toBe('wren is connected.');

        act(() => root.render(<PairPrompt requests={[request({ id: 'pair_2' })]} onAnswer={async () => {}} now={NOW + 120_000} />));
        act(() => root.render(<PairPrompt requests={[]} onAnswer={async () => {}} now={NOW + 120_000} />));
        expect(el.querySelector('[data-pair-outcome]')?.textContent).toBe('Nobody answered in time: wren was not let in.');
    });

    it('CONTROL: a PIN request still reads "Pair this device?"', () => {
        act(() => root.render(<PairPrompt requests={[request({ label: 'Pixel 7', from: '100.101.7.9', guest: undefined })]} onAnswer={async () => {}} now={NOW} />));
        expect(el.querySelector('h2')?.textContent).toBe('Pair this device?');
        expect(text()).toContain('It typed the PIN shown here.');
    });
});
