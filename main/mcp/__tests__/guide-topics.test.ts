import { describe, expect, it } from 'vitest';
import { guideTopics, guideIndex, guideFor } from '../guide-topics';
import { GENIE_MCP_GUIDE } from '../guide';
import { osAgentBootInstructions } from '../../agents/os-lifecycle';

/**
 * `genieGuide` returned the WHOLE guide, every time.
 *
 * The owner's ask: called with no arguments it should list the topics, and let an
 * agent select one directly — *"we will be publishing a lot more guides later on
 * and this should be easy for agents to reach for when they need it and not
 * blowing up their context when they don't."*
 *
 * That is the operative constraint. The guide is ~680 lines; an agent that wanted
 * to know how `imDone` works paid for every tool's documentation to find out. A
 * catalogue that costs a few lines, and a body that costs only what was asked
 * for, is the difference between a reference an agent reaches for and one it
 * avoids.
 *
 * Topics are DERIVED from the guide's own headings rather than hand-listed. A
 * hand-maintained index is a second copy of the same facts, and the guide is
 * exactly the kind of document that grows — so the index would be the half that
 * goes stale, silently, while still looking authoritative.
 */
const GUIDE = [
    '# Genie MCP',
    '',
    'Intro prose that belongs to no topic.',
    '',
    '## Reading a result',
    '',
    'ok is the verdict.',
    '',
    '## imDone',
    '',
    'Call it when you finish.',
    'Second line.',
    '',
    '## manageSite',
    '',
    'Host a repo.',
].join('\n');

describe('guideTopics', () => {
    it('makes one topic per section, from the guide itself', () => {
        const topics = guideTopics(GUIDE);

        expect(topics.map((t) => t.title)).toEqual(['Reading a result', 'imDone', 'manageSite']);
    });

    it('gives each topic a stable, agent-typable id', () => {
        const topics = guideTopics(GUIDE);

        expect(topics.map((t) => t.id)).toEqual(['reading-a-result', 'imdone', 'managesite']);
    });

    it('carries the section BODY, and stops at the next section', () => {
        const imDone = guideTopics(GUIDE).find((t) => t.id === 'imdone')!;

        expect(imDone.body).toContain('Call it when you finish.');
        expect(imDone.body).toContain('Second line.');
        // The bleed test: a topic that ran on into its neighbour would quietly
        // undo the whole point of splitting.
        expect(imDone.body).not.toContain('Host a repo.');
    });

    it('does not invent a topic for the preamble', () => {
        // Text above the first heading belongs to no topic. Attaching it to the
        // first one would put unrelated prose under a specific title.
        expect(guideTopics(GUIDE).some((t) => t.body.includes('belongs to no topic'))).toBe(false);
    });
});

describe('guideIndex', () => {
    it('lists every topic id so an agent can ask for one', () => {
        const index = guideIndex(guideTopics(GUIDE));

        expect(index).toContain('imdone');
        expect(index).toContain('managesite');
        expect(index).toContain('reading-a-result');
    });

    it('does NOT include the bodies — that is the entire point', () => {
        const index = guideIndex(guideTopics(GUIDE));

        expect(index).not.toContain('Call it when you finish.');
        expect(index).not.toContain('Host a repo.');
    });

    it('says how to ask for one, so the listing is self-explaining', () => {
        expect(guideIndex(guideTopics(GUIDE)).toLowerCase()).toContain('topic');
    });
});

describe('guideFor', () => {
    it('returns just the requested topic', () => {
        const got = guideFor(guideTopics(GUIDE), 'imdone');

        expect(got.ok).toBe(true);
        expect(got.text).toContain('Call it when you finish.');
        expect(got.text).not.toContain('Host a repo.');
    });

    it('is forgiving about case and surrounding space', () => {
        expect(guideFor(guideTopics(GUIDE), '  imDone ').ok).toBe(true);
    });

    it('answers an unknown topic with the INDEX, not just a refusal', () => {
        // A "no such topic" that does not say what the topics are costs the agent
        // a second call to find out — the same silence this whole change is about.
        const got = guideFor(guideTopics(GUIDE), 'nonsense');

        expect(got.ok).toBe(false);
        expect(got.text).toContain('nonsense');
        expect(got.text).toContain('imdone');
    });
});

/**
 * THE GUIDE HAS AN OPERATOR TOPIC, AND THE BOOT PROMPT'S POINTER RESOLVES.
 *
 * The guide never mentioned the workstation operator — not the role, not the
 * first-boot/recovery distinction, not how to triage a wedged agent. So the one
 * agent on this machine whose whole job is described nowhere else was reading
 * the same text as every project agent, which is a fair part of why it behaved
 * like one.
 *
 * Nothing about `genieGuide` had to become role-aware to fix that. Topics are
 * derived from the guide's own `##` headings, so a section IS a topic — the
 * operator's boot instruction names the id, and this pins that the id it names
 * actually resolves. A prompt pointing at a topic that does not exist is worse
 * than one pointing nowhere: it costs a call to find out.
 */
describe('the workstation-operator guide topic', () => {
    const topics = guideTopics(GENIE_MCP_GUIDE);

    it('is reachable under the id the operator boot prompt tells it to ask for', () => {
        expect(osAgentBootInstructions('first-boot')).toContain('the-workstation-operator');

        expect(guideFor(topics, 'the-workstation-operator').ok).toBe(true);
    });

    it('says what the operator must NOT do, not only what it does', () => {
        const body = guideFor(topics, 'the-workstation-operator').text;

        expect(body).toMatch(/do NOT/i);
        expect(body).toMatch(/project/i);
        expect(body).toMatch(/registerAgent/);
    });

    it('describes the triage the refusal hands off to', () => {
        const body = guideFor(topics, 'the-workstation-operator').text;

        expect(body).toMatch(/runAgent diagnose/);
        expect(body).toMatch(/wedged|stuck/i);
    });

    it('POSITIVE CONTROL — it is one topic, not prose smeared across the guide', () => {
        // A section that leaked into every topic would pass every assertion above
        // while making `genieGuide` more expensive for every agent — the exact
        // cost the topic split exists to avoid.
        const imdone = guideFor(topics, 'imdone');

        expect(imdone.ok).toBe(true);
        expect(imdone.text).not.toMatch(/WORKSTATION OPERATOR/);
    });
});
