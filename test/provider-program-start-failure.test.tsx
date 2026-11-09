import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComposerSendError } from '../src/renderer/components/ChatFlyout.js';

/*
 * Tynn #577, the follow-up: a failed agent start is the first place a person meets a provider hidden behind a batch
 * wrapper, so its error offers the same "Choose claude.exe" the model list does: in the chat's "Not sent" line (a first
 * message starts the agent) and on the agent's own view (Start).
 */
const REFUSED = "Genie could not start claude: claude on PATH is a batch file Genie cannot run: C:\\tools\\bin\\claude.cmd. Choose claude's .exe.";
const ACTION = 'data-action="provider-choose-program"';
const send = ComposerSendError as unknown as (props: Record<string, unknown>) => ReturnType<typeof ComposerSendError>;
const onChoose = async () => ({ ok: true as const });
const choice = async () => { const path: string = '../src/renderer/components/ProviderProgramChoice.js'; return import(path) as Promise<any>; };
const program = async () => { const path: string = '../src/core/provider-program.js'; return import(path) as Promise<any>; };

describe('a failed start offers the picker', () => {
    it('in the chat: the "Not sent" line for a refused start has the button, for the provider it names', () => {
        const html = renderToStaticMarkup(createElement(send, { chat: 'a', error: REFUSED, onChooseProviderProgram: onChoose }));
        expect(html).toContain('Not sent:');
        expect(html).toContain(ACTION);
        expect(html).toContain('Choose claude.exe');
    });

    it('CONTROL: any other send error has no button, and neither does a window that cannot choose', () => {
        expect(renderToStaticMarkup(createElement(send, { chat: 'a', error: 'the provider is overloaded', onChooseProviderProgram: onChoose }))).not.toContain(ACTION);
        expect(renderToStaticMarkup(createElement(send, { chat: 'a', error: REFUSED }))).not.toContain(ACTION);
    });

    it('on the agent: the start refusal says why and offers the button', async () => {
        const { ProviderStartRefusal } = await choice();
        const html = renderToStaticMarkup(createElement(ProviderStartRefusal, { reason: REFUSED, onChoose }));
        expect(html).toContain('data-start-refusal');
        expect(html).toContain('C:\\tools\\bin\\claude.cmd');
        expect(html).toContain(ACTION);
    });

    // Every refused Start is said on desktop, not only this one (the owner's rule: never a dead click).
    it('on the agent, any other refusal is said too, with no picker', async () => {
        const { ProviderStartRefusal } = await choice();
        const html = renderToStaticMarkup(createElement(ProviderStartRefusal, { reason: '"atlas" is still stopping; it starts once its previous run has ended.', onChoose }));
        expect(html).toContain('data-start-refusal');
        expect(html).toContain('is still stopping');
        expect(html).not.toContain(ACTION);
    });

    it('a window that cannot choose still says the refusal, with no picker', async () => {
        const { ProviderStartRefusal } = await choice();
        const html = renderToStaticMarkup(createElement(ProviderStartRefusal, { reason: REFUSED }));
        expect(html).toContain('C:\\tools\\bin\\claude.cmd');
        expect(html).not.toContain(ACTION);
    });

    it('CONTROL: no refusal draws nothing', async () => {
        const { ProviderStartRefusal } = await choice();
        expect(renderToStaticMarkup(createElement(ProviderStartRefusal, { reason: null, onChoose }))).toBe('');
    });

    it('is never a dead click: a refused Start or Restart from any surface says its reason on desktop', () => {
        const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
        const view = read('../src/renderer/components/AgentView.tsx'), app = read('../src/renderer/App.tsx');
        // Drawn whether or not this window can choose a program.
        expect(view).not.toMatch(/ops\?\.onChooseProviderProgram \? <ProviderStartRefusal/);
        expect(view).toContain('<ProviderStartRefusal reason={startRefusal}');
        for (const handler of ['onStartAgent', 'onRestartAgent']) expect(app).toMatch(new RegExp(`${handler}=\\{\\(agentId\\) => \\{[^\\n]*setDockNotice\\(\\{ kind: 'refused'`));
    });

    it('reads the provider from the words, and only from that problem', async () => {
        const { providerOfProgramProblem } = await program();
        expect(providerOfProgramProblem(REFUSED)).toBe('claude');
        expect(providerOfProgramProblem('codex on PATH is a batch file Genie cannot run: C:\\x\\codex.cmd')).toBe('codex');
        expect(providerOfProgramProblem('could not start claude: spawn EINVAL')).toBeNull();
    });

    it('is wired: the chat and the agent view get the choice, and choosing starts the agent', () => {
        const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
        const shell = read('../src/renderer/Shell.tsx'), view = read('../src/renderer/components/AgentView.tsx'), chat = read('../src/renderer/components/ChatFlyout.tsx'), app = read('../src/renderer/App.tsx');
        expect(chat).toMatch(/<ComposerSendError[^>]*onChooseProviderProgram=/);
        expect(shell).toMatch(/startRefusal=\{agentDetail\.refusal\}/);
        expect(view).toContain('<ProviderStartRefusal');
        expect(view).toMatch(/onStart\?\.\(agent\.id\)/);
        expect(shell).toContain('onChooseProviderProgram');
        expect(app).toMatch(/<Shell[\s\S]*onChooseProviderProgram=/);
    });
});
