import { describe, expect, it } from 'vitest';
import { gooseSessionCommand, withGooseGenieMcpLaunch } from '../goose-launch';

/**
 * Goose's launch grammar, asserted rather than assumed.
 *
 * Every claim here is read from `crates/goose-cli/src/cli.rs` on
 * `aaif-goose/goose@main`, because the published docs do not answer any of it —
 * and a wrong guess becomes a command Genie types into a real terminal.
 */

describe('gooseSessionCommand — the `session` word has to be INSERTED', () => {
    it('turns the bare binary into an interactive session command', () => {
        // Bare `goose` IS an interactive TUI (cli.rs:2957 routes None to
        // handle_default_session, interactive: true) — but it passes NO
        // extensions at all (`extensions: Vec::new()`,
        // `streamable_http_extensions: Vec::new()`), so an agent launched that
        // way has no genie MCP server and cannot call imDone. Everything Genie
        // needs hangs off the `session` subcommand.
        expect(gooseSessionCommand('goose')).toBe('goose session');
    });

    it('is idempotent — never a second `session`', () => {
        expect(gooseSessionCommand('goose session')).toBe('goose session');
        expect(gooseSessionCommand('goose session --name mine')).toBe('goose session --name mine');
    });

    it('inserts AFTER the binary, not at the end', () => {
        // `--name` and `--with-streamable-http-extension` live on `Identifier`
        // (cli.rs:78-86), which only the `session` and `run` subcommands take.
        // The top-level Cli struct has NO global args (cli.rs:71-74), so a
        // subcommand appended after a flag is a clap error.
        expect(gooseSessionCommand('goose --debug')).toBe('goose session --debug');
    });

    it('handles the Windows binary name', () => {
        expect(gooseSessionCommand('goose.exe')).toBe('goose.exe session');
    });

    it('leaves a command that already names a DIFFERENT subcommand alone', () => {
        // `goose run --text …` is the one-shot form. Inserting `session` would
        // produce `goose session run`, which is not a command.
        expect(gooseSessionCommand('goose run --text hi')).toBe('goose run --text hi');
        expect(gooseSessionCommand('goose configure')).toBe('goose configure');
    });

    it('NEVER rewrites a command that is not the goose binary', () => {
        // The owner's `agent_command_goose` may be a wrapper script with its own
        // argument grammar. Prepending a word to somebody else's command is a
        // guess, and this file exists because guesses become typed commands.
        expect(gooseSessionCommand('my-goose-wrapper --go')).toBe('my-goose-wrapper --go');
        expect(gooseSessionCommand('/opt/tools/goose-helper')).toBe('/opt/tools/goose-helper');
    });

    it('accepts an absolute path to the real binary', () => {
        expect(gooseSessionCommand('/usr/local/bin/goose')).toBe('/usr/local/bin/goose session');
    });

    it('is empty-safe', () => {
        expect(gooseSessionCommand('')).toBe('');
    });
});

describe('withGooseGenieMcpLaunch — the per-terminal genie endpoint', () => {
    const URL_ = 'http://127.0.0.1:41234/mcp/tok-abc123';

    it('attaches the genie endpoint as a streamable-http extension', () => {
        // Genie's endpoint carries its token in the URL PATH, which is the one
        // shape this flag can express — Goose's lack of header support costs
        // nothing here. (Tynn is the exception: it needs a bearer header, and
        // Goose has no CLI route for one. See the design doc.)
        expect(withGooseGenieMcpLaunch('goose session', { agent: 'goose', genieUrl: URL_ })).toBe(
            `goose session --with-streamable-http-extension "${URL_}"`,
        );
    });

    it('ensures the session subcommand itself, so the flag is never orphaned', () => {
        // `--with-streamable-http-extension` is a `session` flag. If the word is
        // missing the whole launch line is malformed, so the two arrive together
        // or not at all.
        expect(withGooseGenieMcpLaunch('goose', { agent: 'goose', genieUrl: URL_ })).toBe(
            `goose session --with-streamable-http-extension "${URL_}"`,
        );
    });

    it('QUOTES the url', () => {
        // Goose splits the value on whitespace and reads trailing key=value
        // pairs (cli.rs:149), so an unquoted URL is fragile rather than broken —
        // but quoting is this codebase's job wherever it builds a shell line.
        const out = withGooseGenieMcpLaunch('goose session', { agent: 'goose', genieUrl: URL_ });
        expect(out).toContain(`"${URL_}"`);
    });

    it('is idempotent — a relaunch must not stack a second endpoint', () => {
        const once = withGooseGenieMcpLaunch('goose session', { agent: 'goose', genieUrl: URL_ });
        expect(withGooseGenieMcpLaunch(once, { agent: 'goose', genieUrl: URL_ })).toBe(once);
    });

    it('REPLACES a stale endpoint rather than adding beside it', () => {
        // An upgrade mints a new port and token. Two extensions would leave the
        // agent talking to a dead one half the time.
        const stale = `goose session --with-streamable-http-extension "http://127.0.0.1:1/mcp/old"`;
        expect(withGooseGenieMcpLaunch(stale, { agent: 'goose', genieUrl: URL_ })).toBe(
            `goose session --with-streamable-http-extension "${URL_}"`,
        );
    });

    it('does nothing for another provider, or with no url', () => {
        // POSITIVE CONTROLS: without these, "it added the flag" would pass
        // against a function that adds it unconditionally — which would corrupt
        // every other provider's launch line.
        expect(withGooseGenieMcpLaunch('claude', { agent: 'claude', genieUrl: URL_ })).toBe('claude');
        expect(withGooseGenieMcpLaunch('goose session', { agent: 'goose', genieUrl: null })).toBe(
            'goose session',
        );
    });
});
