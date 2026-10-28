import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { offlineSentence, relayConnectView } from '../src/core/relay-connect.js';
import { RelayConnecting } from '../src/renderer/components/RelayConnecting.js';

/**
 * THE CONNECTING WINDOW, STEP BY STEP (the owner, 2026-10-28): the machine's NAME, what is happening, and when the target
 * is offline a plain sentence with Retry. No raw ids; the tailnet host/PIN form is not on this path.
 */

describe('relayConnectView', () => {
    it('working: the steps in order, done up to the current one', () => {
        const view = relayConnectView('Aionima', { kind: 'working', step: 'relay' });
        expect(view.title).toBe('Connecting to Aionima');
        expect(view.steps.map((s) => s.status)).toEqual(['done', 'working', 'waiting']);
        expect(view.steps.map((s) => s.label).join(' ')).toContain('Aionima');
        expect(view.problem).toBeNull();
    });

    it('offline: the plain sentence, at the step that found it', () => {
        const view = relayConnectView('Aionima', { kind: 'failed', step: 'relay', reason: 'workstation not connected', offline: true });
        expect(view.problem).toBe(offlineSentence('Aionima'));
        expect(offlineSentence('Aionima')).toBe('Aionima is offline: it needs Genie running, signed in, and Remote access on.');
        expect(view.steps.map((s) => s.status)).toEqual(['done', 'failed', 'waiting']);
    });

    it('another failure: the reason as said, at its step', () => {
        const view = relayConnectView('Aionima', { kind: 'failed', step: 'tynn', reason: 'Tynn could not be reached (offline)' });
        expect(view.problem).toBe('Tynn could not be reached (offline)');
        expect(view.steps[0]?.status).toBe('failed');
    });

    it('no name known: a plain word, never an id', () => {
        const view = relayConnectView(null, { kind: 'working', step: 'tynn' });
        expect(view.title).toBe('Connecting to your workstation');
    });
});

describe('RelayConnecting', () => {
    it('the machine’s name, the steps — no raw relay id, no host/PIN form', () => {
        const html = renderToStaticMarkup(<RelayConnecting name="Aionima" state={{ kind: 'working', step: 'host' }} onRetry={() => {}} />);
        expect(html).toContain('Connecting to Aionima');
        expect(html).not.toContain('relay:');
        expect(html).not.toContain('data-connect-tailnet');
        expect(html).not.toContain('data-form="connect-remote"');
        expect(html).toMatch(/data-relay-step="host"[^>]*data-status="working"/);
    });

    it('offline: the sentence and a real Retry button', () => {
        const html = renderToStaticMarkup(<RelayConnecting name="Aionima" state={{ kind: 'failed', step: 'relay', reason: 'workstation not connected', offline: true }} onRetry={() => {}} />);
        expect(html).toContain('Aionima is offline: it needs Genie running, signed in, and Remote access on.');
        expect(html).not.toContain('workstation not connected');
        expect(html).toMatch(/<button[^>]*data-action="retry-connect"/);
    });
});
