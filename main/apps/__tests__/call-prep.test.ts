import { describe, expect, it } from 'vitest';
import { prepareAppToolCall } from '../call-prep';

/**
 * What an allowed GApp call actually becomes before it is dispatched (Tynn #250).
 *
 * The page proposes; Genie disposes. A GApp's window is developer-authored web
 * content, so nothing arriving from it may be trusted to describe WHO is calling
 * or WHERE they may act — those are facts Genie already decided, and this is where
 * the decision is stamped over anything the page said.
 *
 * Pure, because "the page cannot forge its own workspace" is a property worth
 * asserting directly rather than inferring from a dispatch path.
 */

const decision = {
    allowed: true as const,
    workspaceId: 'ws-app',
    reason: '',
    via: 'self' as const,
};

describe('the facts the page does not get to choose', () => {
    it('forces the workspace Genie resolved, over whatever was asked for', () => {
        const call = prepareAppToolCall(decision, {
            tool: 'manageSite',
            args: { action: 'list', workspaceId: 'ws-somebody-elses' },
        });

        expect(call.params.arguments.workspaceId).toBe('ws-app');
    });

    it('sets the workspace even when the page omitted it', () => {
        const call = prepareAppToolCall(decision, { tool: 'manageSite', args: { action: 'list' } });
        expect(call.params.arguments.workspaceId).toBe('ws-app');
    });

    it('strips any terminal the page claimed to be', () => {
        // An app has no terminal identity. Letting one through would let it act as
        // whichever agent it named.
        const call = prepareAppToolCall(decision, {
            tool: 'imDone',
            args: { terminalId: 'term-someone-else' },
        });

        expect(call.params.arguments.terminalId).toBeUndefined();
    });

    it('is a well-formed tools/call for the tool that was allowed', () => {
        const call = prepareAppToolCall(decision, { tool: 'manageSite', args: {} });

        expect(call.method).toBe('tools/call');
        expect(call.params.name).toBe('manageSite');
        expect(call.jsonrpc).toBe('2.0');
    });

    it('ignores an args payload that is not an object', () => {
        for (const args of [null, undefined, 42, 'hi', []] as unknown[]) {
            const call = prepareAppToolCall(decision, { tool: 'manageSite', args });
            expect(call.params.arguments.workspaceId).toBe('ws-app');
        }
    });
});

describe('attribution — the user always knows who is talking', () => {
    const attributed = { ...decision, mustAttribute: true as const, appName: 'Example Trader' };

    it('stamps the app’s name onto a question it raises', () => {
        // A GApp raising an always-on-top modal is the impersonation risk the
        // reserved names in the manifest exist to close. The modal is Genie-drawn,
        // and this is what makes it say whose question it is.
        const call = prepareAppToolCall(attributed, {
            tool: 'ForceTheQuestion',
            args: { questions: [{ header: 'Pick', question: 'Which strategy?', options: [] }] },
        });

        const q = (call.params.arguments.questions as Array<{ question: string }>)[0];
        expect(q?.question).toContain('Example Trader');
        // The app's own words survive — attribution adds, never replaces.
        expect(q?.question).toContain('Which strategy?');
    });

    it('stamps it onto a message sent to another agent', () => {
        const call = prepareAppToolCall(attributed, {
            tool: 'agentinbox',
            args: { action: 'send', to: 'agent-7', text: 'build finished' },
        });

        expect(call.params.arguments.text).toContain('Example Trader');
        expect(call.params.arguments.text).toContain('build finished');
    });

    it('leaves an agentinbox call with nothing to say alone', () => {
        const call = prepareAppToolCall(attributed, {
            tool: 'agentinbox',
            args: { action: 'list' },
        });
        expect(call.params.arguments.text).toBeUndefined();
    });

    it('survives a malformed questions payload without throwing', () => {
        // The page can send anything. A crash here would be a denial of service on
        // the main process, from inside a third-party window.
        for (const questions of [null, 'x', [null], [{}], 42] as unknown[]) {
            expect(() =>
                prepareAppToolCall(attributed, { tool: 'ForceTheQuestion', args: { questions } }),
            ).not.toThrow();
        }
    });

    it('adds nothing when the call is not one the user sees', () => {
        const call = prepareAppToolCall(decision, {
            tool: 'manageSite',
            args: { action: 'list', name: 'trader' },
        });

        expect(call.params.arguments.name).toBe('trader');
    });
});
