import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';
import { ChatProse, CopyButtonView } from '../src/renderer/components/ChatProse.js';
import { StreamRow } from '../src/renderer/components/StreamRow.js';
import { ledgerRow } from '../src/core/stream-view.js';

/**
 * THE CHAT DRAWS MOIC'S MARKUP (genie#1263), asserted on markup with renderToStaticMarkup (docs/decisions.md D3: no
 * jsdom, no browser). What a click does is proved on the pure functions (chat-copy.test.ts, chat-markup.test.ts); here,
 * that every block is drawn, that each has its copy control, and that what must not render does not.
 */
const REFS = { agents: [{ id: 'ag_1', name: 'atlas' }], workspaces: [{ id: 'ws_1', name: 'tynn.ai' }] };

const thread = (text: string): ChatThread => ({
    agentId: 'a1', name: 'atlas', fidelity: 'declared', unread: null,
    messages: [{ id: 'm1', from: 'atlas', who: 'agent', text, delivered: true }],
});
const chat = (text: string, extra: Partial<Parameters<typeof ChatFlyout>[0]> = {}) =>
    renderToStaticMarkup(<ChatFlyout thread={thread(text)} onSend={() => {}} {...extra} />);

describe('code blocks and tables', () => {
    it('EVERY fenced block has a copy button; the code is shown as written, escaped', () => {
        const html = chat('One:\n\n```bash\nnpm ci && echo "<ok>"\n```\n\nTwo:\n\n```\nls\n```');
        expect((html.match(/data-copy="code"/g) ?? []).length).toBe(2);
        expect(html).toContain('aria-label="Copy code"');
        expect(html).toContain('npm ci &amp;&amp; echo &quot;&lt;ok&gt;&quot;');
        expect(html).toMatch(/data-chat-code="bash"/);
    });

    it('a table is rendered as a table and has a "Copy table" button', () => {
        const html = chat('| a | b |\n|---|---|\n| 1 | 2 |');
        expect(html).toContain('data-copy="table"');
        expect(html).toContain('aria-label="Copy table"');
        expect(html).toMatch(/<table>[\s\S]*<td>1<\/td>/);
    });

    it('CONTROL: a reply with neither has no copy button at all', () => {
        expect(chat('**Done.**')).not.toContain('data-copy=');
    });
});

describe('<result>, <highlight>, <followup>', () => {
    it('<result> is a card with a rich "Copy result" button, its Markdown rendered — a nested table included', () => {
        const html = chat('<result>\n**Signed:** Acme\n\n| Deal | Size |\n|---|---|\n| Acme | $40k |\n</result>');
        expect(html).toContain('data-chat-result=""');
        expect(html).toContain('aria-label="Copy result"');
        expect(html).toContain('<strong>Signed:</strong>');
        expect(html).toMatch(/data-chat-result=""[\s\S]*<table>[\s\S]*<td>Acme<\/td>/);
        expect(html).not.toContain('&lt;result');
    });

    it('<highlight> is a callout and <followup> a closing question; neither tag shows as text', () => {
        const html = chat('<highlight>The **migration** is irreversible.</highlight>\n\n<followup>Shall I open the PR?</followup>');
        expect(html).toMatch(/data-chat-highlight=""[\s\S]*<strong>migration<\/strong>/);
        expect(html).toMatch(/data-chat-followup=""[\s\S]*Shall I open the PR\?/);
        expect(html).not.toMatch(/&lt;\/?(highlight|followup)/);
    });

    it('a reply still arriving shows its card filling in — never a raw "<result"', () => {
        expect(chat('Draft:\n\n<result>\nDear Ana,')).toContain('data-chat-result=""');
        const partial = chat('Draft:\n\n<resul');
        expect(partial).not.toContain('&lt;resul');
        expect(partial).not.toContain('<resul');
    });
});

describe('forbidden tags', () => {
    it('a model-written button or approval card is not drawn — neither the control nor its words', () => {
        const html = chat('Ready. <button>Approve</button><approval>Allow rm?</approval>');
        expect(html).not.toContain('Approve');
        expect(html).not.toContain('Allow rm?');
        expect(html).toContain('Ready.');
    });
});

describe('pills and destinations', () => {
    it('agent and workspace pills are Genie links when the chat can open them', () => {
        const html = chat('Ask [agent:atlas|Atlas] in [go:workspace:ws_1].', { refs: REFS, onOpenAgent: () => {}, onOpenWorkspace: () => {} });
        expect(html).toContain('href="#agent:ag_1"');
        expect(html).toContain('href="#workspace:ws_1"');
        expect(html).toMatch(/>tynn\.ai<\/a>/);
    });

    it('CONTROL: with no opener, the same pill is its words, not a link', () => {
        const html = chat('Ask [agent:atlas|Atlas].', { refs: REFS });
        expect(html).not.toContain('#agent:');
        expect(html).toContain('Atlas');
    });

    it('a file pill opens in the chat’s workspace — a link only when there is one', () => {
        expect(chat('See [file:src/a.ts:3|a.ts].', { onOpenFile: () => {} })).toContain('href="#file:src/a.ts:3"');
        expect(chat('See [file:src/a.ts:3|a.ts].')).not.toContain('#file:');
    });

    it('a model-written Genie URL is never a link', () => {
        const html = chat('[open](#workspace:ws_1) [go](genie://agent/ag_1)', { refs: REFS, onOpenAgent: () => {}, onOpenWorkspace: () => {} });
        expect(html).not.toContain('href="#workspace:ws_1"');
        expect(html).not.toContain('genie://');
    });
});

describe('the copy button', () => {
    it('idle: the copy icon, an accessible name, and an EMPTY live region', () => {
        const html = renderToStaticMarkup(<CopyButtonView kind="code" label="Copy code" state="idle" onCopy={() => {}} />);
        expect(html).toContain('data-icon-state="copy"');
        expect(html).toMatch(/aria-live="polite"[^>]*><\/span>/);
    });

    it('copied: the icon swaps to a check and the live region says "Copied"', () => {
        const html = renderToStaticMarkup(<CopyButtonView kind="code" label="Copy code" state="copied" onCopy={() => {}} />);
        expect(html).toContain('data-icon-state="check"');
        expect(html).toMatch(/aria-live="polite"[^>]*>Copied<\/span>/);
    });

    it('failed: it says so, and never claims "Copied"', () => {
        const html = renderToStaticMarkup(<CopyButtonView kind="code" label="Copy code" state="failed" onCopy={() => {}} />);
        expect(html).toMatch(/aria-live="polite"[^>]*>Copy failed<\/span>/);
        expect(html).not.toContain('>Copied<');
    });
});

describe('the Stream draws an agent’s prose with the same markup', () => {
    const row = (speaker: 'agent' | 'you', text: string) => ledgerRow({ id: 'r1', at: null, event: { kind: 'message', speaker, peerName: null, text } }, { agentName: 'atlas' });

    it('an agent message row is prose: its code block has a copy button and its <result> is a card', () => {
        const r = row('agent', 'Done.\n\n```\nnpm test\n```\n\n<result>**ok**</result>');
        expect(r.prose).toBe(true);
        const html = renderToStaticMarkup(<StreamRow row={r} selected={false} onSelect={() => {}} />);
        expect(html).toContain('data-copy="code"');
        expect(html).toContain('data-chat-result=""');
    });

    it('CONTROL: your own message stays as you typed it', () => {
        const r = row('you', '**not bold** <result>x</result>');
        expect(r.prose).toBeFalsy();
        const html = renderToStaticMarkup(<StreamRow row={r} selected={false} onSelect={() => {}} />);
        expect(html).toContain('**not bold**');
        expect(html).not.toContain('data-chat-result');
    });

    it('ChatProse on its own: a plain reply is one rendered block (nothing invented around it)', () => {
        const html = renderToStaticMarkup(<ChatProse text="**hi**" />);
        expect(html).toContain('<strong>hi</strong>');
        expect((html.match(/data-react-fancy-content-renderer/g) ?? []).length).toBe(1);
    });
});
