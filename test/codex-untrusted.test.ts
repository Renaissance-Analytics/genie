import { describe, expect, it } from 'vitest';
import { codexTrustOptions, type GenieInstructionFiles } from '../src/main/session-host.js';

/**
 * A CODEX AGENT IN AN UNTRUSTED WORKSPACE (measured, CLI 0.166.0, app-server mode, against a stand-in API): marking a folder
 * untrusted stops neither its AGENTS.md nor its skills. project_doc_max_bytes=0 stops the first, and skills.include_instructions=false
 * the second, a skill added during the session included. No list of skills is needed.
 */
const FILES: GenieInstructionFiles = { promptFile: '/g/prompt.md', pluginDir: '/g/plugin', promptText: 'words' };
const FLAGS = ['-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false'];

describe('the options', () => {
    it('trusted: none', () => {
        expect(codexTrustOptions({}, null)).toEqual({});
        expect(codexTrustOptions({ binaryArgs: ['/s.mjs'] }, null)).toEqual({});
    });

    it('untrusted: the two settings', () => {
        expect(codexTrustOptions({}, FILES)).toEqual({ binaryArgs: FLAGS });
    });

    it('a provider configured as a script stays first: these are arguments to it', () => {
        expect(codexTrustOptions({ binaryArgs: ['/s.mjs'] }, FILES).binaryArgs).toEqual(['/s.mjs', ...FLAGS]);
    });
});
