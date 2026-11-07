import { CodexDriver } from '@particle-academy/prism-acp';
import { describe, expect, it } from 'vitest';
import { codexTrustOptions, type GenieInstructionFiles } from '../src/main/session-host.js';

/**
 * A CODEX AGENT IN AN UNTRUSTED WORKSPACE (measured, CLI 0.166.0, app-server mode, against a stand-in API; prism-acp measured the same on
 * real Codex 0.163.0, Windows and Linux): marking a folder untrusted stops neither its AGENTS.md nor its skills. project_doc_max_bytes=0
 * stops the first, and skills.include_instructions=false the second, a skill added during the session included. Per thread, through
 * prism-acp's own option.
 */
const FILES: GenieInstructionFiles = { promptFile: '/g/prompt.md', pluginDir: '/g/plugin', promptText: 'words' };

describe('the options', () => {
    it('trusted: none', () => {
        expect(codexTrustOptions(null)).toEqual({});
    });

    it('untrusted: the two settings, on the thread and not the process', () => {
        expect(codexTrustOptions(FILES)).toEqual({ config: { project_doc_max_bytes: 0, 'skills.include_instructions': false } });
        expect(codexTrustOptions(FILES)).not.toHaveProperty('binaryArgs');
    });

    it('the driver takes them: it refuses what it manages at construction, and these are not that', () => {
        expect(() => new CodexDriver({ cwd: '/w', ...codexTrustOptions(FILES) }, {} as never)).not.toThrow();
        expect(() => new CodexDriver({ cwd: '/w', config: { mcp_servers: {} } } as never, {} as never)).toThrow();
    });
});
