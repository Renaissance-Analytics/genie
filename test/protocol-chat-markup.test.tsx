import { describe, expect, it } from 'vitest';
import { sharedProtocol } from '../src/core/genie-protocol.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatProse } from '../src/renderer/components/ChatProse.js';

/**
 * AGENTS ARE TOLD THE MARKUP (genie#1263: "Teach agents the markup through Genie's skills / AGENTS shared instructions").
 * `shared.md` is in every agent's instructions, so the section is short and concrete: when `<result>` and when a fence,
 * and the only destinations Genie opens. Every tag it teaches is one the renderer really draws — checked by running the
 * example it gives through the parser.
 */
describe('shared.md teaches the chat markup', () => {
    const md = sharedProtocol([{ name: 'imDone', description: 'x' }]);

    it('names <result> for content the person carries elsewhere, and a fence for code', () => {
        expect(md).toMatch(/<result>/);
        expect(md).toMatch(/fence|```/i);
        expect(md).toMatch(/<highlight>/);
        expect(md).toMatch(/<followup>/);
    });

    it('names Genie’s ONLY destinations: file, agent, workspace — and says a URL is not one', () => {
        expect(md).toContain('[file:');
        expect(md).toContain('[agent:');
        expect(md).toContain('[workspace:');
        expect(md).toMatch(/\[go:/);
        expect(md).toMatch(/never a URL|not a URL|no URLs?/i);
    });

    it('stays short: the section is at most 12 lines', () => {
        const section = md.slice(md.indexOf('## Your replies in the chat'));
        expect(md).toContain('## Your replies in the chat');
        const body = section.split('\n## ')[0]!;
        expect(body.split('\n').filter((l) => l.trim() !== '').length).toBeLessThanOrEqual(12);
    });

    it('its <result> example parses as a result card (what agents are taught is what Genie draws)', () => {
        const example = /(<result>[\s\S]*?<\/result>)/.exec(md)?.[1];
        expect(example).toBeDefined();
        const html = renderToStaticMarkup(<ChatProse text={example!.replace(/\\`/g, '`')} />);
        expect((html.match(/data-chat-result=""/g) ?? []).length).toBe(1);
        expect(html).not.toContain('&lt;result');
    });
});
