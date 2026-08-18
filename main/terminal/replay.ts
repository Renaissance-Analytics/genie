/**
 * Making a scrollback REPLAY behave like history instead of a live stream
 * (genie#202, genie#200).
 *
 * A pty's scrollback is a raw byte ring — everything the program wrote, escape
 * sequences included. Genie replays it whenever a pane joins a pty it did not
 * itself spawn: a warm re-attach after a suspend/restart, a second window
 * joining the same terminal, and every remote/mobile client attaching to a host
 * pty (the `/ws/term` catch-up frame). The receiving xterm is FRESH, so it
 * happily executes those bytes as if the program were writing them right now.
 * Two of its reactions are wrong, and they are exactly the two reported bugs:
 *
 *  1. IT ANSWERS RECORDED QUESTIONS. A TUI probes its terminal at startup —
 *     DA1 (`ESC[c`), DA2 (`ESC[>c`), XTVERSION, DSR, DECRQM, OSC colour reads,
 *     the OSC 52 clipboard read. xterm replies to each one on its `onData`
 *     channel, which Genie wires straight to `terminal.write` — so a replay
 *     TYPES the replies into the pty. At a bare shell they land on the prompt as
 *     `^[[?1;2c` / `^[[>0;276;0c` garbage (genie#202). A question asked in the
 *     past must never be answered now, so the queries are stripped from the
 *     replay. Only queries: colours, cursor moves, erases, alt-screen and
 *     bracketed paste all still render, because a replay that dropped those
 *     would draw the history wrong.
 *
 *  2. IT RE-ENTERS MOUSE-TRACKING MODE. A TUI turns tracking on at startup and
 *     off at exit; if it was KILLED (pty-host death, upgrade, crash) the ring
 *     holds the `ESC[?1002h` and never the matching `l`. The replay therefore
 *     leaves the fresh emulator reporting the mouse for a program that is gone:
 *     every pointer move becomes an SGR report written to the pty, which a bare
 *     shell echoes as `35;28;31M` spam (genie#202), and xterm — believing an
 *     app wants the mouse — stops turning drags into SELECTIONS, which is why
 *     text cannot be selected on a remotely-driven workstation (genie#200).
 *     The ring is also BOUNDED, so which mode-changes survived in it is
 *     arbitrary: a busy terminal may have evicted the enable, a quiet one keeps
 *     it forever. Replay-derived tracking state cannot be trusted in either
 *     direction, so the replay ends with an explicit disable and the live
 *     program re-asserts tracking itself if it wants it.
 *
 * KNOWN TRADE-OFF: a pane re-attached to a STILL-LIVE full-screen app loses
 * mouse reporting for that app until it re-enables tracking. That is deliberate
 * — see the bounded-ring argument above — and it costs nothing on the remote
 * path, where clicks and drags are already withheld from the host by design
 * (`isBlockedMouseReport` in renderer/lib/remote-bridge.ts forwards only wheel
 * ticks). Knowing that a child TUI has exited needs a signal from the pty-host,
 * which owns the child lifecycle; with such a signal this disable could be
 * conditional instead of unconditional.
 *
 * Pure + dependency-free (no electron, no pty, no DOM) so both the main process
 * and the renderer import it and the decisions are unit-tested directly.
 */

/**
 * DECRST for every private mode that turns pointer motion or focus changes into
 * BYTES on the pty: X10 (9), normal (1000), highlight (1001), button-event
 * (1002) and any-event (1003) tracking, focus reporting (1004), and the UTF-8 /
 * SGR / urxvt / SGR-pixel report encodings (1005/1006/1015/1016). Deliberately
 * does NOT touch alt-screen (1049) or bracketed paste (2004): those change how
 * output is drawn and how a paste is delimited, not whether the emulator
 * generates input, so resetting them would corrupt a live app's display and
 * break multi-line paste for no benefit here.
 */
export const MOUSE_REPORTING_OFF = '\x1b[?9;1000;1001;1002;1003;1004;1005;1006;1015;1016l';

/**
 * Terminal QUERIES — sequences whose whole purpose is to make the emulator send
 * a reply back up the pty. Order matters: the string-terminated forms (DCS, OSC)
 * are removed first so a CSI pattern can never match inside one of their
 * payloads.
 */
const QUERY_PATTERNS: RegExp[] = [
    // DCS queries: XTGETTCAP (`ESC P + q … ST`) and DECRQSS (`ESC P $ q … ST`).
    /\x1bP[+$][a-zA-Z][^\x1b]*(?:\x1b\\|\x07)/g,
    // OSC queries — the standard form ends the parameter list with `?`:
    // `OSC 10;? ST` (foreground), `OSC 11;? ST` (background), `OSC 4;n;? ST`
    // (palette), `OSC 52;c;? ST` (clipboard READ — Genie answers that one by
    // writing the clipboard contents into the pty). An OSC that ends in any
    // other byte (a title, an OSC 7 cwd, an OSC 52 clipboard WRITE) is history
    // and is kept.
    /\x1b\][0-9]+;[^\x07\x1b]*\?(?:\x07|\x1b\\)/g,
    // Device Attributes: DA1 `CSI c`, DA2 `CSI > c`, DA3 `CSI = c`.
    /\x1b\[[>=]?[0-9;]*c/g,
    // Device Status Report / cursor-position request: `CSI n`, `CSI 5 n`,
    // `CSI 6 n`, `CSI ? 6 n`.
    /\x1b\[\??[0-9;]*n/g,
    // DECRQM (request mode): `CSI ? Ps $ p` / `CSI Ps $ p`.
    /\x1b\[\??[0-9;]*\$p/g,
    // XTVERSION: `CSI > Ps q`. The bare `CSI Ps q` (DECSCUSR cursor style) has
    // no `>` prefix and is left alone — it renders, it does not reply.
    /\x1b\[>[0-9;]*q/g,
    // DECID — the obsolete "identify terminal", answered like DA1.
    /\x1bZ/g,
];

/**
 * Remove every terminal QUERY from replayed history, leaving all rendering
 * sequences intact. This is not an ANSI stripper (see `stripAnsi` in
 * keystrokes.ts for that, which is for making output human-readable): colours,
 * cursor motion, erases, mode changes and titles all survive, because the
 * replay still has to draw the screen the user had.
 */
export function stripReplayQueries(text: string): string {
    let out = text;
    for (const re of QUERY_PATTERNS) out = out.replace(re, '');
    return out;
}

/**
 * The bytes to actually write when replaying a pty's scrollback into a terminal:
 * the history with its questions removed, followed by a single mouse-reporting
 * disable so the pane can never be left reporting the pointer on behalf of a
 * program that is no longer there.
 *
 * Returns '' for an empty/absent replay — with no history to paint there is no
 * stale state to correct, and writing a bare reset into a pane that is about to
 * show a freshly spawned program would only fight it.
 */
export function sanitizeReplay(text: string | undefined | null): string {
    if (!text) return '';
    return stripReplayQueries(text) + MOUSE_REPORTING_OFF;
}
