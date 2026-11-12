import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deckBody, linkParts, type DeckItem, type SignalState } from '../src/core/deck.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { LISTS_TOOL } from '../src/main/mcp-tools.js';
import { Deck } from '../src/renderer/components/Deck.js';
import { control } from './helpers/control-markup.js';

/**
 * THE DECK IS HARD TO READ (Tynn #602; the owner, 2026-11-10, with a screenshot: "the deck is not easy to read at all").
 * A person-list item showed as one paragraph: its numbered steps ran together, a URL was plain text, the collapsed row was
 * a cut-off sentence, and Done sat on a row of its own. Tested with the owner's real items of 2026-11-10.
 */
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const NOW = Date.parse('2026-11-10T22:00:00.000Z');
const PORTAL = 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Credentials/appId/eea362cf-3891-4f5d-a491-03b8798ff8da';

/** The two shapes agents wrote that day: a title line then a line per step, and the same as one run-on paragraph. */
const LINES = `Let Prism sign its supervisor as Renaissance Analytics (about 2 minutes)\n\n1. Open ${PORTAL}\n2. Click Federated credentials, then + Add credential.\n3. Scenario: GitHub Actions deploying Azure resources.\n4. Organization: Particle-Academy\n5. Repository: prism-acp-ts\n6. Entity type: Environment. Environment name: release\n7. Name: prism-acp-ts-release\n8. Click Add, then mark this Done.`;
const RUN_ON = `Let Prism sign under Renaissance Analytics (prism-acp's supervisor, so antivirus stops flagging it). 1) Open ${PORTAL} 2) Click "Federated credentials", then "+ Add credential". 3) Federated credential scenario: "GitHub Actions deploying Azure resources". 4) Organization: Particle-Academy. Repository: prism-acp-ts. Entity type: Environment. GitHub environment name: release. 5) Credential details, Name: prism-acp-ts-release. 6) Click Add. 7) Tick this item done; I then send Prism the IDs.`;
const CLIENT = 'Ask your client two things (agents wouldn\'t start on their PC)\n\n1. Open Command Prompt, type  where claude  and press Enter. Send every line it prints.\n2. Which antivirus they use, and the name it gave the file it quarantined (in its quarantine or history list).\n3. Paste both answers to the tynn agent, then mark this Done.';
const SHORT = 'Rotate the GitHub token.';

const itemOf = (text: string, id = 'li_1'): DeckItem => deckItemsFrom({
    questions: [], userList: [{ workspaceId: 'tynn', item: { id, text, askedBy: 'agent_t', createdAt: '2026-11-10T21:30:44.857Z', done: false } }],
    unreadDms: [], agents: { agent_t: { name: 'tynn' } }, workspaceNames: { tynn: 'Tynn.ai' },
} as unknown as Parameters<typeof deckItemsFrom>[0])[0]!;
const render = (items: readonly DeckItem[]) =>
    renderToStaticMarkup(<Deck items={items} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} now={NOW} />);
/** Text as a person reads it: the markup's entities (`&#x27;` for an apostrophe) turned back into their characters. */
const decoded = (text: string) => text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** The row's first line: everything up to the end of its header. */
const header = (html: string, id: string) => html.slice(html.indexOf(`data-deck-item="${id}"`), html.indexOf(`data-deck-body="${id}"`) > 0 ? html.indexOf(`data-deck-body="${id}"`) : undefined);

describe('reading an item: a title, then its steps', () => {
    it('a title line, then a line per step', () => {
        const body = deckBody(LINES);
        expect(body.title).toBe('Let Prism sign its supervisor as Renaissance Analytics (about 2 minutes)');
        expect(body.steps).toHaveLength(8);
        expect(body.steps[0]).toBe(`Open ${PORTAL}`);
        expect(body.steps[7]).toBe('Click Add, then mark this Done.');
        expect(body.text).toEqual([]);
    });

    it('the same written as one paragraph: the title is what comes before step 1, and the steps are found inside it', () => {
        const body = deckBody(RUN_ON);
        expect(body.title).toBe('Let Prism sign under Renaissance Analytics (prism-acp\'s supervisor, so antivirus stops flagging it).');
        expect(body.steps).toHaveLength(7);
        expect(body.steps[1]).toBe('Click "Federated credentials", then "+ Add credential".');
        expect(body.steps[3]).toBe('Organization: Particle-Academy. Repository: prism-acp-ts. Entity type: Environment. GitHub environment name: release.');
        expect(body.steps[6]).toBe('Tick this item done; I then send Prism the IDs.');
    });

    it('numbers that are not steps stay where they are', () => {
        const body = deckBody('Update to 2.0.1 and restart\n\nThe port is 8080. Then 3) is not a step, nor is version 1. here.');
        expect(body.title).toBe('Update to 2.0.1 and restart');
        expect(body.steps).toEqual([]);
        expect(body.text).toEqual(['The port is 8080. Then 3) is not a step, nor is version 1. here.']);
    });

    it('CONTROL: a one-line item is its title and nothing else', () => {
        expect(deckBody(SHORT)).toEqual({ title: SHORT, steps: [], text: [] });
    });
});

describe('links', () => {
    it('a URL is a link; the punctuation after it is not part of it', () => {
        expect(linkParts(`Open ${PORTAL}. Then wait.`)).toEqual(['Open ', { url: PORTAL }, '. Then wait.']);
        expect(linkParts('See (https://example.com/a), then go.')).toEqual(['See (', { url: 'https://example.com/a' }, '), then go.']);
        expect(linkParts('No link here')).toEqual(['No link here']);
    });

    it('only http and https are links', () => {
        expect(linkParts('Run javascript:alert(1) or file:///etc/passwd')).toEqual(['Run javascript:alert(1) or file:///etc/passwd']);
    });
});

describe('the row', () => {
    it('collapsed, it shows only the short bold title: no step, no URL', () => {
        for (const text of [LINES, RUN_ON, CLIENT]) {
            const body = deckBody(text);
            const html = render([itemOf(text)]);
            const title = control(html, 'data-deck-preview="li_1"');
            expect(title, text.slice(0, 30)).toMatchObject({ tag: 'button', fancy: true });
            expect(decoded(title!.text)).toBe(body.title);
            expect(title!.open).toMatch(/font-semibold/);
            expect(html).not.toContain('portal.azure.com');
            expect(html).not.toContain(body.steps[1]!);
        }
    });

    it('opened, its steps are a numbered list and its URL a link that opens in the browser', () => {
        const html = render([itemOf(LINES)]).replace('aria-expanded="false"', '');
        const opened = renderToStaticMarkup(<DeckOpened text={LINES} />);
        expect(opened).toMatch(/<ol[^>]*data-deck-steps="li_1"/);
        expect((opened.match(/<li[^>]*data-deck-step=/g) ?? []).length).toBe(8);
        const link = control(opened, `href="${PORTAL}"`);
        expect(link).toMatchObject({ tag: 'a', fancy: true, text: PORTAL });
        expect(link!.open).toContain('target="_blank"');
        expect(link!.open).toContain('rel="noreferrer"');
        expect(html).toBeTruthy();
    });

    it('the run-on paragraph opens as the same list', () => {
        const opened = renderToStaticMarkup(<DeckOpened text={RUN_ON} />);
        expect((opened.match(/<li[^>]*data-deck-step=/g) ?? []).length).toBe(7);
        expect(opened).toContain(`href="${PORTAL}"`);
    });

    it('Done is at the end of the row, beside Open, not on a row of its own', () => {
        const html = render([itemOf(CLIENT)]);
        const top = header(html, 'li_1');
        expect(top.indexOf('data-deck-open="li_1"')).toBeGreaterThan(0);
        expect(top.indexOf('data-approval-option="done"')).toBeGreaterThan(top.indexOf('data-deck-open="li_1"'));
        expect(control(html, 'data-approval-option="done"')).toMatchObject({ tag: 'button', fancy: true, text: 'Done' });
        expect(html.match(/data-approval-option="done"/g)).toHaveLength(1);
    });

    it('CONTROL: a short item is drawn whole, bold, with nothing to open', () => {
        const html = render([itemOf(SHORT)]);
        expect(html).not.toContain('data-action="deck-expand"');
        expect(html).toMatch(new RegExp(`data-deck-title="li_1"[^>]*font-semibold[^>]*>${SHORT.replace('.', '\\.')}<`));
    });
});

describe('the lists tool asks for that shape', () => {
    it('a person item: a short title line, then each step on its own numbered line', () => {
        expect(LISTS_TOOL.description).toMatch(/first line.*short title/i);
        expect(LISTS_TOOL.description).toMatch(/each step on its own numbered line/i);
    });
});

/** The row as it looks once opened (the Deck opens it on a click; here it is drawn opened). */
function DeckOpened({ text }: { text: string }) {
    return <Deck items={[itemOf(text)]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} now={NOW} initiallyExpanded={['li_1']} />;
}
