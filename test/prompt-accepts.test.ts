import { describe, expect, it } from 'vitest';
import { promptAcceptsFor } from '../src/main/session-host.js';

/**
 * ATTACHMENTS REACH CLAUDE AND CODEX. Genie sends a file only when the agent's driver DECLARES it can take one
 * (prism-acp's `promptBlocks`); before prism-acp 0.11.0 no driver declared any, so every attachment was refused —
 * visibly, but refused. 0.11.0 (prism-acp-ts#4) declares ['text', 'image', 'resource-text'] for both, measured
 * live: Claude and Codex each described an attached PNG and quoted an attached text file.
 */
describe('what each provider takes in a prompt', () => {
    it('claude and codex take images and text files; a provider with no driver takes neither (the control)', () => {
        expect(promptAcceptsFor('claude')).toEqual({ image: true, textResource: true });
        expect(promptAcceptsFor('codex')).toEqual({ image: true, textResource: true });
        expect(promptAcceptsFor('kimi')).toEqual({ image: false, textResource: false });
    });
});
