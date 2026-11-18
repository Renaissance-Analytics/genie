// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectMenu } from '../src/renderer/components/ConnectMenu.js';
import { FLASH_MS, Flash } from '../src/renderer/components/Flash.js';

/*
 * A CONFIRMATION COMES AND GOES (the owner: "I don't need this stuff to stick around and it should be a popover that
 * appears, not a label that makes the ui jump"). The note is a react-fancy Popover, portaled out of the layout, and it
 * closes on its own after FLASH_MS.
 */

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.useFakeTimers(); g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const flash = () => document.querySelector('[data-flash]');
const pass = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('Flash', () => {
    it('shows the note OUTSIDE the layout, then goes on its own', () => {
        act(() => root.render(<div><button type="button">Open</button><Flash note="Opened" /></div>));
        expect(flash()?.textContent).toContain('Opened');
        expect(host.textContent).not.toContain('Opened');
        pass(FLASH_MS - 1);
        expect(flash()).not.toBeNull();
        pass(1);
        expect(flash()).toBeNull();
    });

    it('anchors on what it wraps, which stays in place', () => {
        act(() => root.render(<Flash note="Saved"><button type="button" data-x="">Save</button></Flash>));
        expect(host.querySelector('[data-x]')).not.toBeNull();
        expect(flash()?.textContent).toContain('Saved');
    });

    it('a new note shows again after the last one went', () => {
        act(() => root.render(<Flash note="Saved" />));
        pass(FLASH_MS);
        act(() => root.render(<Flash note={null} />));
        act(() => root.render(<Flash note="Saved" />));
        expect(flash()?.textContent).toContain('Saved');
    });

    it('CONTROL: no note, no popover', () => {
        act(() => root.render(<Flash note={null} />));
        expect(flash()).toBeNull();
    });
});

describe('opening a workstation', () => {
    const list = { ok: true as const, workstations: [{ id: 'ws_a', name: 'studio', active: true, connectable: true, local: true, source: 'owner', mine: true }] };

    it('adds no line under its row; a popover says it opened, then goes', async () => {
        act(() => root.render(<ConnectMenu workstations={list} onOpenWorkstation={() => Promise.resolve()} onOpenSurface={() => {}} />));
        const before = host.querySelector('[data-tynn-workstation-row="ws_a"]')!.children.length;
        await act(async () => { (host.querySelector('[data-action="open-workstation"]') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
        expect(host.querySelector('[data-tynn-workstation-row="ws_a"]')!.children.length).toBe(before);
        expect(host.textContent).not.toContain('Opened in its own window');
        expect(flash()?.textContent).toContain('Opened in its own window');
        pass(FLASH_MS);
        expect(flash()).toBeNull();
    });
});
