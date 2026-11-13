import { describe, expect, it } from 'vitest';
import { sharedProtocol } from '../src/core/genie-protocol.js';

/**
 * QUESTIONS GO THROUGH ForceTheQuestion, NEVER THE CHAT (the owner, 2026-11-13: "agents keep doing this. add a line to the
 * genie protocol that says DO NOT leave questions in chat responses, use FTQ" — a reply ending in a `<followup>` question
 * the person only saw by chance). The person does not read chat to find decisions; a question in a reply is lost. So
 * shared.md says it in so many words, and no longer offers `<followup>` as the place for a closing question.
 */
describe('shared.md: questions for the person go through ForceTheQuestion', () => {
    const md = sharedProtocol([{ name: 'ForceTheQuestion', description: 'x' }]);

    it('says, in so many words, not to leave questions in chat responses and to use ForceTheQuestion', () => {
        expect(md).toContain('DO NOT leave questions in chat responses');
        expect(md).toMatch(/DO NOT leave questions in chat responses[^\n]*ForceTheQuestion/);
    });

    it('no longer offers <followup> as the place for a closing question', () => {
        expect(md).not.toMatch(/closing question/i);
        expect(md).not.toMatch(/<followup>/);
    });

    it('CONTROL: the rest of the chat markup is still taught', () => {
        expect(md).toMatch(/<result>/);
        expect(md).toMatch(/<highlight>/);
    });
});
