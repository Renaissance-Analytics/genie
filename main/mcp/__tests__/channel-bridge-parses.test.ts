import { describe, expect, it } from 'vitest';
import { claudeChannelBridge } from '../agent-config';

/**
 * The generated AgentInbox channel bridge must be valid JavaScript.
 *
 * It was not. `claudeChannelBridge()` emits a `.cjs` file that Genie writes into
 * every workspace and that Claude Code spawns over stdio, and its template had
 * lost the line that invokes `deliver()`:
 *
 *     } else if (message.method === 'notifications/initialized') {
 *             process.stderr.write('[AgentInbox Channel] ' + error.message);
 *             process.exitCode = 1;
 *         });          <-- closes a callback that is no longer opened
 *
 * leaving the `.catch` body and its closing `});` orphaned. Node refused the
 * file outright:
 *
 *     SyntaxError: Unexpected token ')'
 *
 * So the channel process died before speaking a word of MCP, the harness
 * reported `CONNECTION_CLOSED`, and every AgentInbox message fell through to the
 * pty-nudge fallback — which rides the user's input and queues behind their
 * typing, the exact thing the channel exists to avoid (genie#314).
 *
 * Nothing syntax-checked the generated file, which is how a bridge that cannot
 * parse shipped. That is what this pins down: generated code is still code, and
 * the one property it must always have is that it parses.
 */

describe('the generated AgentInbox channel bridge (#314)', () => {
    const src = claudeChannelBridge();

    it('parses as JavaScript', () => {
        // `new Function` compiles the body without running it — precisely the
        // step that was failing, and enough to catch an unbalanced brace.
        expect(() => new Function(src)).not.toThrow();
    });

    it('actually starts delivery on notifications/initialized', () => {
        // POSITIVE CONTROL for the test above: a file can parse and still be
        // inert. `deliver()` registers the transport and runs the long-poll that
        // IS the channel; it was defined and never called, so even a parsing
        // bridge would have sat silent.
        expect(src).toMatch(/notifications\/initialized/);
        // Must be a CALL, not the `async function deliver()` definition — a bare
        // /deliver\(\)/ matches the declaration and passes on the broken file.
        expect(src).toMatch(/deliver\(\)\s*\.catch\(/);
    });

    it('keeps the handlers that make it a usable MCP server', () => {
        // Guards against "fixed the brace, dropped a branch".
        expect(src).toContain("message.method === 'initialize'");
        expect(src).toContain("message.method === 'ping'");
        expect(src).toContain("message.method === 'tools/list'");
        expect(src).toContain("capabilities: { experimental: { 'claude/channel': {} } }");
    });
});
