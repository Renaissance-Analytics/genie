import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alertDelivery, toastFor } from '../src/core/alerts.js';
import { AlertToasts } from '../src/renderer/components/AlertToasts.js';

/**
 * AN ALERT DOES NOT COVER THE CHAT, AND NAMES THE AGENT BY ITS ADDRESS (genie#1211; the owner, 2026-10-26, of a
 * "Finished" notification over the chat composer titled `MR8GJF5KPJY11N560000 · prism-slave`: "move this toast to the
 * left side. it's annoying when it covers the chat"). Those were Windows notifications: Windows puts them bottom-right
 * and Genie cannot move them. While Genie's window has focus its OWN toast shows, bottom-LEFT, clear of the docked chat;
 * the OS notification is kept for when Genie is behind another app — the only way to reach the person then.
 */

describe('the title', () => {
    const slugs = new Map([['MR8GJF5KPJY11N560000', 'prism']]);

    it('is the agent’s address, name@workspace — never the workspace’s id; the OS agent is genie@system', () => {
        expect(toastFor({ kind: 'finished', workspace: 'MR8GJF5KPJY11N560000', agent: 'prism-slave', detail: 'done' }, slugs))
            .toEqual({ title: 'prism-slave@prism', body: 'Finished: done' });
        expect(toastFor({ kind: 'question', workspace: '__genie__', agent: 'genie', detail: 'Ship now?' }, slugs).title).toBe('genie@system');
        // CONTROL: a workspace with no slug yet is named by what Genie has.
        expect(toastFor({ kind: 'broken', workspace: 'ws-unknown', agent: 'bolt', detail: 'exited' }, slugs).title).toBe('bolt@ws-unknown');
    });
});

describe('where it shows', () => {
    it('Genie in front: its own toast; Genie behind another app: the OS notification', () => {
        expect(alertDelivery(true)).toBe('in-app');
        expect(alertDelivery(false)).toBe('os');
    });

    it('Genie’s own toasts sit bottom-LEFT, each with its title and body and a way to dismiss it', () => {
        const html = renderToStaticMarkup(<AlertToasts toasts={[{ id: 't1', title: 'prism-slave@prism', body: 'Finished: done' }]} onDismiss={() => {}} />);
        expect(html).toContain('data-alert-toasts');
        expect(html).toMatch(/data-alert-toasts[^>]*class="[^"]*\bleft-4\b/);
        expect(html).not.toMatch(/data-alert-toasts[^>]*class="[^"]*\bright-/);
        expect(html).toContain('prism-slave@prism');
        expect(html).toContain('Finished: done');
        expect(html).toContain('data-alert-toast-dismiss="t1"');
    });

    it('nothing to show: nothing drawn', () => {
        expect(renderToStaticMarkup(<AlertToasts toasts={[]} onDismiss={() => {}} />)).toBe('');
    });
});
