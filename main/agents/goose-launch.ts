/**
 * GOOSE'S LAUNCH GRAMMAR — PURE, and the only place that knows it.
 *
 * Goose (`aaif-goose/goose`, formerly `block/goose`) is a real interactive TUI
 * when run bare: `crates/goose-cli/src/cli.rs:2957` routes `None` to
 * `handle_default_session`, which builds a session with `interactive: true`
 * (`cli.rs:2742-2772`). No published docs page says so, which is why the
 * citation is to the dispatcher.
 *
 * ## Why bare `goose` is not enough for Genie
 *
 * `handle_default_session` passes **no extensions of any kind** —
 * `extensions: Vec::new()`, `streamable_http_extensions: Vec::new()`. An agent
 * launched that way has no `genie` MCP server, which means no `imDone`, no
 * `ForceTheQuestion`, and no AgentInbox: the terminal would look alive and be
 * unreachable, which is the failure Genie's whole protocol exists to prevent.
 *
 * Everything Genie needs hangs off the `session` subcommand, and that word has
 * to be INSERTED rather than appended. `--name` and
 * `--with-streamable-http-extension` live on `Identifier` (`cli.rs:78-86`),
 * which only `session` and `run` accept; the top-level `Cli` struct carries no
 * global args at all (`cli.rs:71-74`), so `goose --name x` is a clap error.
 *
 * ## What this module will NOT do
 *
 * It never rewrites a command that is not the `goose` binary. The owner's
 * `agent_command_goose` may be a wrapper with its own argument grammar, and
 * prepending a word to somebody else's command is a guess — the kind that
 * becomes a command typed into a real terminal.
 */

/** The binary names that mean "this is really Goose", not a wrapper. */
const GOOSE_BIN = /^(?:.*[/\\])?goose(?:\.exe|\.cmd)?$/i;

/** Subcommands Goose defines. A command that already names one is left alone —
 *  `goose session run` is not a command. */
const GOOSE_SUBCOMMANDS = new Set([
    'session',
    'run',
    'configure',
    'info',
    'mcp',
    'agents',
    'bench',
    'project',
    'projects',
    'recipe',
    'schedule',
    'update',
    'web',
]);

/** The flag that attaches a remote MCP server to a Goose session. */
export const GOOSE_HTTP_EXTENSION_FLAG = '--with-streamable-http-extension';

/** Split a command line into tokens, keeping it simple: Genie builds these
 *  lines itself, so the only quoting that appears is its own. */
function tokens(command: string): string[] {
    return String(command ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * Ensure a Goose command runs the `session` subcommand, inserting it directly
 * after the binary. IDEMPOTENT, and a no-op for anything that is not the bare
 * goose binary or that already names a subcommand.
 */
export function gooseSessionCommand(command: string): string {
    const parts = tokens(command);
    if (parts.length === 0) return String(command ?? '');
    const [bin, ...rest] = parts;
    if (!GOOSE_BIN.test(bin!)) return command;
    // Already a subcommand — including `session` itself, which is what makes
    // this safe to apply on every relaunch.
    if (rest[0] && GOOSE_SUBCOMMANDS.has(rest[0])) return command;
    return [bin, 'session', ...rest].join(' ');
}

/**
 * Point a Goose launch at THIS terminal's genie MCP endpoint.
 *
 * Genie's endpoint carries its token in the URL **path**
 * (`http://127.0.0.1:<port>/mcp/<token>`), which is the one shape this flag can
 * express — so Goose's lack of header support costs nothing here. Tynn is the
 * exception and genuinely cannot be reached this way: its entry needs an
 * `Authorization: Bearer` header, and Goose's CLI has no route for one.
 *
 * REPLACES any existing genie extension rather than adding beside it: an
 * upgrade mints a new port and token, and two extensions would leave the agent
 * talking to a dead one half the time.
 */
export function withGooseGenieMcpLaunch(
    command: string,
    input: { agent: string; genieUrl?: string | null },
): string {
    if (input.agent !== 'goose' || !input.genieUrl) return command;
    // Drop any endpoint already attached, quoted or bare.
    const cleaned = String(command ?? '')
        .replace(
            new RegExp(`\\s*${GOOSE_HTTP_EXTENSION_FLAG}(?:=|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`, 'g'),
            '',
        )
        .trim();
    // The flag is a `session` flag, so the subcommand arrives with it or the
    // whole launch line is malformed.
    return `${gooseSessionCommand(cleaned)} ${GOOSE_HTTP_EXTENSION_FLAG} "${input.genieUrl}"`.trim();
}
