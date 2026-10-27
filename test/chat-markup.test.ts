import { describe, expect, it } from 'vitest';
import {
    chatLinkTarget, linkChatRefs, parseChatMarkup, prepareChatMarkdown, streamSafe, stripForbiddenTags, stripInternalLinks,
    type ChatRefs, type ChatSegment,
} from '../src/core/chat-markup.js';

/**
 * CHAT MARKUP (genie#1263; the owner: "Add copy block support to Genie's chat … we need to use [moic's markup] in Genie to
 * make it easier for agents to communicate with humans and give them content they need to take somewhere else").
 *
 * moic's own vocabulary (MOIC-Partners/suite `resources/prompts/rules/custom-tags.md`, `ChatRenderService.php`):
 * `<result>` a card for content the person carries elsewhere, `<highlight>` a one-level callout, `<followup>` one closing
 * question, `[type:id|label]` pills and `[go:kind:id]` destinations. Genie keeps only the destinations it really has:
 * a file in the chat's workspace, an agent, a workspace. Everything here is a pure function, so the parser, the
 * sanitisers and the link rules are proved without a DOM.
 */

const kinds = (segs: readonly ChatSegment[]) => segs.map((s) => s.kind);

describe('parseChatMarkup — one segment per block', () => {
    it('plain Markdown is ONE markdown segment, untouched (the control: nothing invented)', () => {
        const md = '**Done.** I changed two things:\n\n- one\n- two';
        expect(parseChatMarkup(md)).toEqual([{ kind: 'markdown', text: md }]);
    });

    it('a fenced code block is its own segment, with its language and its exact code', () => {
        const segs = parseChatMarkup('Run this:\n\n```bash\nnpm ci\nnpm test\n```\n\nThen tell me.');
        expect(kinds(segs)).toEqual(['markdown', 'code', 'markdown']);
        expect(segs[1]).toEqual({ kind: 'code', lang: 'bash', code: 'npm ci\nnpm test' });
    });

    it('a ~~~ fence and a fence with no language both count', () => {
        expect(parseChatMarkup('~~~\nplain\n~~~')).toEqual([{ kind: 'code', lang: '', code: 'plain' }]);
    });

    it('a Markdown table is its own segment, its rows parsed (header first, the delimiter row dropped)', () => {
        const segs = parseChatMarkup('Counts:\n\n| Repo | Open |\n|---|---:|\n| genie | 12 |\n| tynn | 3 |\n\nThat is all.');
        expect(kinds(segs)).toEqual(['markdown', 'table', 'markdown']);
        const table = segs[1] as Extract<ChatSegment, { kind: 'table' }>;
        expect(table.rows).toEqual([['Repo', 'Open'], ['genie', '12'], ['tynn', '3']]);
        expect(table.markdown).toBe('| Repo | Open |\n|---|---:|\n| genie | 12 |\n| tynn | 3 |');
    });

    it('a pipe in prose is not a table (no delimiter row under it)', () => {
        expect(kinds(parseChatMarkup('Use a | b to pipe.\nNext line.'))).toEqual(['markdown']);
    });

    it('<result> is a card whose body is parsed again: a NESTED Markdown table inside it is a table segment', () => {
        const segs = parseChatMarkup('Here it is:\n\n<result>\n## Q3\n\n| Deal | Size |\n|---|---|\n| Acme | **$40k** |\n\n- signed\n</result>\n\nAnything else?');
        expect(kinds(segs)).toEqual(['markdown', 'result', 'markdown']);
        const result = segs[1] as Extract<ChatSegment, { kind: 'result' }>;
        expect(kinds(result.children)).toEqual(['markdown', 'table', 'markdown']);
        expect((result.children[1] as Extract<ChatSegment, { kind: 'table' }>).rows).toEqual([['Deal', 'Size'], ['Acme', '**$40k**']]);
        expect(result.body).toBe('## Q3\n\n| Deal | Size |\n|---|---|\n| Acme | **$40k** |\n\n- signed');
    });

    it('<highlight> and <followup> are their own blocks; inline on one line too', () => {
        const segs = parseChatMarkup('<highlight>The **migration** is irreversible.</highlight>\n\nDone.\n\n<followup>Shall I open the PR?</followup>');
        expect(kinds(segs)).toEqual(['highlight', 'markdown', 'followup']);
        expect(segs[0]).toMatchObject({ kind: 'highlight', body: 'The **migration** is irreversible.' });
        expect(segs[2]).toMatchObject({ kind: 'followup', body: 'Shall I open the PR?' });
    });

    it('ONE level: a block tag inside a block is not another card (its words stay, the tag goes)', () => {
        const segs = parseChatMarkup('<highlight>Outer <highlight>inner</highlight> rest</highlight>');
        expect(kinds(segs)).toEqual(['highlight']);
        const inner = (segs[0] as Extract<ChatSegment, { kind: 'highlight' }>).children;
        expect(kinds(inner)).toEqual(['markdown']);
        expect(JSON.stringify(inner)).not.toContain('<highlight>');
    });

    it('a tag INSIDE a code fence or a code span is code, not a card', () => {
        const fenced = parseChatMarkup('```html\n<result>x</result>\n```');
        expect(fenced).toEqual([{ kind: 'code', lang: 'html', code: '<result>x</result>' }]);
        expect(kinds(parseChatMarkup('Write `<result>` around it.'))).toEqual(['markdown']);
    });

    it('tag names are case-insensitive, as moic’s regexes are', () => {
        expect(kinds(parseChatMarkup('<Result>x</RESULT>'))).toEqual(['result']);
    });
});

describe('streamSafe — a reply still arriving never shows a half-written tag', () => {
    it('a partial opening tag at the end is held back (moic: "<result" must never flash raw)', () => {
        for (const tail of ['<', '<r', '<resul', '<result', '<result ', '</res', '</result', '<highlight cl']) {
            expect(streamSafe(`Here:\n\n${tail}`)).toBe('Here:\n\n');
        }
    });

    it('an unfinished pill or destination at the end is held back', () => {
        expect(streamSafe('Open [file:src/co')).toBe('Open ');
        expect(streamSafe('Ask [go:agent:atl')).toBe('Ask ');
        expect(streamSafe('Ask [agent:atlas|At')).toBe('Ask ');
    });

    it('an OPEN block with no close yet renders as its card, filling in (not as raw text)', () => {
        const segs = parseChatMarkup(streamSafe('Draft:\n\n<result>\nDear Ana,\n\nThanks for'));
        expect(kinds(segs)).toEqual(['markdown', 'result']);
        expect((segs[1] as Extract<ChatSegment, { kind: 'result' }>).body).toBe('Dear Ana,\n\nThanks for');
    });

    it('an open fence renders as code while it arrives', () => {
        expect(parseChatMarkup(streamSafe('```ts\nconst a = 1;\nconst b'))).toEqual([{ kind: 'code', lang: 'ts', code: 'const a = 1;\nconst b' }]);
    });

    it('CONTROL: complete text is left exactly as it was (a finished reply loses nothing)', () => {
        const done = 'a < b and [x](https://e.com) <result>ok</result> [file:src/a.ts|a.ts] 3 < 4';
        expect(streamSafe(done)).toBe(done);
    });

    it('a "<" inside an unclosed code fence is code, not a tag to hold back', () => {
        expect(streamSafe('```\nif (a <')).toBe('```\nif (a <');
    });
});

describe('stripForbiddenTags — a model never authors interactive or approval UI', () => {
    it('buttons, forms, inputs and approval look-alikes are removed WITH their content (COUNTED: 6 of 6)', () => {
        const md = [
            '<button onclick="x()">Approve</button>',
            '<form action="/x"><input name="a"></form>',
            '<approval id="1">Allow?</approval>',
            '<plan-approval plan-id="3"/>',
            '<permission-request>rm -rf</permission-request>',
            '<select><option>a</option></select>',
        ].join('\n');
        const out = stripForbiddenTags(md);
        expect(out).not.toMatch(/<\/?(button|form|input|approval|plan-approval|permission-request|select|option)\b/i);
        expect(out).not.toMatch(/Approve|Allow\?|rm -rf/);
    });

    it('a stray opening or closing forbidden tag is removed too', () => {
        expect(stripForbiddenTags('a <button> b </textarea> c')).toBe('a  b  c');
    });

    it('CONTROL: the same tags shown as CODE are kept (an agent explaining HTML is not authoring UI)', () => {
        const md = 'Use `<button>` like:\n\n```html\n<button>Go</button>\n```';
        expect(stripForbiddenTags(md)).toBe(md);
    });

    it('CONTROL: the allowed blocks and ordinary Markdown pass through', () => {
        const md = '<result>**x**</result> <highlight>y</highlight> <followup>z?</followup>';
        expect(stripForbiddenTags(md)).toBe(md);
    });
});

describe('stripInternalLinks — a model-written URL never navigates inside Genie', () => {
    it('a Markdown link into genie:// or a #fragment keeps its words and loses its target', () => {
        expect(stripInternalLinks('Go [here](genie://workspace/w1) or [there](#agent:atlas).')).toBe('Go here or there.');
        expect(stripInternalLinks('<genie://agent/x> and <a href="#file:a.ts">a</a>')).toBe('genie://agent/x and a');
    });

    it('CONTROL: an ordinary web link is left alone (it is not a navigation into Genie)', () => {
        const md = 'See [docs](https://example.com/x).';
        expect(stripInternalLinks(md)).toBe(md);
    });
});

const REFS: ChatRefs = {
    files: true,
    agents: [{ id: 'ag_1', name: 'atlas' }, { id: 'ag_2', name: 'wren' }],
    workspaces: [{ id: 'ws_1', name: 'tynn.ai' }],
};

describe('linkChatRefs — pills and destinations, only where Genie has one', () => {
    it('[type:id|label] pills: file, agent (by id or name), workspace, each a Genie link labelled as written', () => {
        const out = linkChatRefs('See [file:src/core/route.ts:42|route.ts], ask [agent:atlas|Atlas] or [agent:ag_2|Wren] in [workspace:ws_1|Tynn].', REFS);
        expect(out).toBe('See [route.ts](#file:src/core/route.ts:42), ask [Atlas](#agent:ag_1) or [Wren](#agent:ag_2) in [Tynn](#workspace:ws_1).');
    });

    it('[go:kind:id] destinations take the record’s OWN name (the model names the place, Genie labels it)', () => {
        expect(linkChatRefs('Ask [go:agent:ag_1] in [go:workspace:ws_1]; open [go:file:docs/a b.md].', REFS))
            .toBe('Ask [atlas](#agent:ag_1) in [tynn.ai](#workspace:ws_1); open [a b.md](#file:docs/a%20b.md).');
    });

    it('UNKNOWN: a pill keeps its label as plain words; a destination disappears (moic: "renders as nothing")', () => {
        const out = linkChatRefs('Deal [deal:9|Acme], agent [agent:nobody|Ghost], go [go:op:20] and [go:agent:nobody].', REFS);
        expect(out).toBe('Deal Acme, agent Ghost, go  and .');
    });

    it('a file pill that climbs out of the workspace or is a URL is not a link', () => {
        expect(linkChatRefs('[file:../../etc/passwd|pw] [file:https://x.com/a|x] [file:/etc/hosts|h]', REFS)).toBe('pw x h');
    });

    it('with nowhere to open files (no workspace), file pills are words', () => {
        expect(linkChatRefs('[file:src/a.ts|a.ts]', { ...REFS, files: false })).toBe('a.ts');
    });

    it('CONTROL: a pill shown in code is left as code', () => {
        const md = 'Write `[agent:atlas|Atlas]` to name one.\n\n```\n[go:agent:ag_1]\n```';
        expect(linkChatRefs(md, REFS)).toBe(md);
    });

    it('CONTROL: a real Markdown link whose text looks like a pill is not rewritten', () => {
        const md = '[agent:atlas](https://example.com)';
        expect(linkChatRefs(md, REFS)).toBe(md);
    });
});

describe('chatLinkTarget — reading a Genie link back', () => {
    it('file (with and without a line), agent and workspace', () => {
        expect(chatLinkTarget('#file:src/a.ts:12')).toEqual({ kind: 'file', path: 'src/a.ts', line: 12 });
        expect(chatLinkTarget('#file:docs/a%20b.md')).toEqual({ kind: 'file', path: 'docs/a b.md', line: null });
        expect(chatLinkTarget('#agent:ag_1')).toEqual({ kind: 'agent', id: 'ag_1' });
        expect(chatLinkTarget('#workspace:ws_1')).toEqual({ kind: 'workspace', id: 'ws_1' });
    });

    it('anything else is not a Genie link', () => {
        for (const href of ['https://e.com', '#section', '#agent:', 'genie://agent/x', '']) expect(chatLinkTarget(href)).toBeNull();
    });
});

describe('prepareChatMarkdown — the whole pipeline, in the order that keeps it safe', () => {
    it('a model-written internal link is stripped BEFORE Genie adds its own, so only Genie’s survive', () => {
        const out = prepareChatMarkdown('[evil](#workspace:ws_1) and [workspace:ws_1|Tynn] <button>x</button>', REFS);
        expect(out).toBe('evil and [Tynn](#workspace:ws_1) ');
    });

    it('file references in prose still become links (chat-file-links), when files can open', () => {
        expect(prepareChatMarkdown('Fixed src/core/route.ts.', REFS)).toContain('[src/core/route.ts](#file:src/core/route.ts)');
        expect(prepareChatMarkdown('Fixed src/core/route.ts.', { ...REFS, files: false })).not.toContain('#file:');
    });
});
