import { MAX_LINE_BYTES, META_COMMAND_SOURCE, META_PLUGINS, META_SUBAGENTS, NdjsonFramer } from '@particle-academy/prism-acp';
import { describe, expect, it } from 'vitest';

/**
 * GENIE RESOLVES THE prism-acp THAT CARRIES ITS TWO FIXES (0.13.0). Both were measured in Genie, and neither can reach a
 * person until the lockfile carries the release:
 * - #12: an agent's row read "Broken · NDJSON frame exceeds 1000000 bytes (1036723 bytes; content withheld)" while it
 *   kept working — a tool result carrying an image was DROPPED at the old 1 MB cap. The measured frame must now pass.
 * - #11: Claude's own commands, skills, plugins and subagents reach the chat's `/` menu and agent settings (genie2#259) —
 *   the metadata keys Genie reads them by exist only from 0.13.0.
 */
describe('the prism-acp Genie resolves', () => {
    it('passes the measured 1,036,723-byte frame whole (0.12.0 refused it), and still caps a runaway line', () => {
        expect(MAX_LINE_BYTES).toBeGreaterThanOrEqual(64_000_000);
        const framer = new NdjsonFramer();
        const payload = 'x'.repeat(1_036_723 - '{"data":""}'.length);
        const frames = framer.push(Buffer.from(`${JSON.stringify({ data: payload })}\n`, 'utf8'));
        expect(frames).toHaveLength(1);
        expect(frames[0]!.ok).toBe(true);
    });

    it('exports the metadata keys Claude’s commands, plugins and subagents arrive under', () => {
        expect([typeof META_COMMAND_SOURCE, typeof META_PLUGINS, typeof META_SUBAGENTS]).toEqual(['string', 'string', 'string']);
    });
});
