import { describe, expect, it } from 'vitest';
import { osaInstructions, type OsaFacts } from '../src/core/osa-home.js';

/**
 * A DIRECT QUESTION GETS A DIRECT ANSWER IN DOCTOR MODE. Measured in doctor trials 2 and 3 on the owner's machine
 * (2026-10-13): the doctor instructions said "Start with the genie-diagnostics skill", and genie read it as "before
 * anything you say" — every reply opened with "I'll start with the diagnostics, as doctor mode asks", and asked to answer
 * "without using any tools" it invoked the skill anyway. The skill is for when diagnosis is wanted: asked what is wrong,
 * or before a repair. A question is answered as asked.
 */
const facts: OsaFacts = { version: '2.0.0-beta.20', platform: 'win32', installDir: 'C:/Program Files/Genie', genieHome: 'C:/Users/u/.genie', userData: 'C:/Users/u/AppData/Roaming/genie2' };

describe('the doctor instructions', () => {
    it('run the diagnostics skill when diagnosis is wanted — not before every reply', () => {
        const doctor = osaInstructions('doctor', facts);
        expect(doctor).not.toMatch(/^- Start with the `genie-diagnostics` skill/m);
        expect(doctor).toMatch(/When you are asked what is wrong, or before you repair anything, use the `genie-diagnostics` skill/);
        expect(doctor).toMatch(/Answer a direct question directly/);
        expect(doctor).toMatch(/If you are asked not to use tools, do not use them/);
    });
});
