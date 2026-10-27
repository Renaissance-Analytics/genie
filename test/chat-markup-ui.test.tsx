import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';
import { ChatProse, CopyButtonView, stopCopyClick } from '../src/renderer/components/ChatProse.js';
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

/** react-fancy's copy region: drawn only while its copy buttons are on (5.67.0, ContentRenderer `copyButtons`). */
const LIVE = /data-react-fancy-content-renderer-live=""/g;
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe('code blocks and tables: ONE copy button per block, react-fancy’s', () => {
    /*
     * react-fancy 5.67 puts a copy button on every <pre> and <table> a ContentRenderer draws — ON by default — and adds
     * them after mount, so a static render shows the blocks but not the buttons. What a render CAN prove: Genie draws no
     * code or table button of its own (a second one would sit beside fancy's), every block is drawn by ONE renderer, and
     * that renderer's copy is on (its live region is drawn only then).
     */
    it('two fences: two <pre> in one renderer with its copy on, and NO copy button of Genie’s', () => {
        const html = chat('One:\n\n```bash\nnpm ci && echo "<ok>"\n```\n\nTwo:\n\n```\nls\n```');
        expect(count(html, /<pre>/g)).toBe(2);
        expect(count(html, /data-react-fancy-content-renderer=""/g)).toBe(1);
        expect(count(html, LIVE)).toBe(1);
        expect(html).not.toContain('data-copy="code"');
        expect(html).toContain('class="language-bash"');
        expect(html).toContain('npm ci &amp;&amp; echo &quot;&lt;ok&gt;&quot;');
    });

    it('a table is a table, in a renderer with its copy on, and NO copy button of Genie’s', () => {
        const html = chat('| a | b |\n|---|---|\n| 1 | 2 |');
        expect(html).toMatch(/<table>[\s\S]*<td>1<\/td>/);
        expect(count(html, LIVE)).toBe(1);
        expect(html).not.toContain('data-copy="table"');
    });

    it('a code block and a table inside a <result> are the same renderer’s: the card adds ONLY its own "Copy result"', () => {
        const html = chat('<result>\n```\nls\n```\n\n| a |\n|---|\n| 1 |\n</result>');
        expect(count(html, /data-copy=/g)).toBe(1);
        expect(html).toContain('data-copy="result"');
        expect(count(html, /data-react-fancy-content-renderer=""/g)).toBe(1);
        expect(count(html, LIVE)).toBe(1);
    });

    it('ChatProse never turns react-fancy’s copy off, and routes it through Genie’s clipboard writer', () => {
        const src = readFileSync(new URL('../src/renderer/components/ChatProse.tsx', import.meta.url), 'utf8');
        expect(src).not.toMatch(/copyButtons=/);
        expect(src).toMatch(/clipboardWriter=\{genieClipboardWriter\}/);
    });

    it('CONTROL: a reply with neither has no copy button of Genie’s at all', () => {
        const html = chat('**Done.**');
        expect(html).not.toContain('data-copy=');
        expect(html).not.toContain('<pre>');
    });
});

describe('a copy click is a copy, nothing else (genie#1265: a click navigates only when it is a link)', () => {
    const event = (inside: string | null) => {
        let stopped = 0;
        const target = { closest: (sel: string) => (inside !== null && sel.split(',').map((s) => s.trim()).includes(inside) ? {} : null) };
        return { e: { target, stopPropagation: () => { stopped += 1; } }, stopped: () => stopped };
    };

    it('a click on react-fancy’s copy button or Genie’s does not reach the row or the log behind it', () => {
        for (const sel of ['[data-react-fancy-content-copy]', '[data-copy]']) {
            const { e, stopped } = event(sel);
            stopCopyClick(e as never);
            expect(stopped()).toBe(1);
        }
    });

    it('CONTROL: any other click goes on as before (a pill’s link still opens)', () => {
        const { e, stopped } = event(null);
        stopCopyClick(e as never);
        expect(stopped()).toBe(0);
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
        expect(html).not.toContain('href="#agent:');
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
        const html = renderToStaticMarkup(<CopyButtonView kind="result" label="Copy result" state="idle" onCopy={() => {}} />);
        expect(html).toContain('data-icon-state="copy"');
        expect(html).toMatch(/aria-live="polite"[^>]*><\/span>/);
    });

    it('copied: the icon swaps to a check and the live region says "Copied"', () => {
        const html = renderToStaticMarkup(<CopyButtonView kind="result" label="Copy result" state="copied" onCopy={() => {}} />);
        expect(html).toContain('data-icon-state="check"');
        expect(html).toMatch(/aria-live="polite"[^>]*>Copied<\/span>/);
    });

    it('failed: it says so, and never claims "Copied"', () => {
        const html = renderToStaticMarkup(<CopyButtonView kind="result" label="Copy result" state="failed" onCopy={() => {}} />);
        expect(html).toMatch(/aria-live="polite"[^>]*>Copy failed<\/span>/);
        expect(html).not.toContain('>Copied<');
    });
});

describe('the Stream draws an agent’s prose with the same markup', () => {
    const row = (speaker: 'agent' | 'you', text: string) => ledgerRow({ id: 'r1', at: null, event: { kind: 'message', speaker, peerName: null, text } }, { agentName: 'atlas' });

    it('an agent message row is prose: its code block is in a renderer with copy on (react-fancy’s button) and its <result> is a card', () => {
        const r = row('agent', 'Done.\n\n```\nnpm test\n```\n\n<result>**ok**</result>');
        expect(r.prose).toBe(true);
        const html = renderToStaticMarkup(<StreamRow row={r} selected={false} onSelect={() => {}} />);
        expect(count(html, /<pre>/g)).toBe(1);
        expect(count(html, LIVE)).toBe(1);
        expect(html).not.toContain('data-copy="code"');
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
        expect(count(html, /data-react-fancy-content-renderer=""/g)).toBe(1);
    });
});
