/**
 * PROSE THAT NEVER WIDENS ITS COLUMN (Tynn story #378). For a react-fancy ContentRenderer inside a column that scrolls
 * only up and down — the question window, its file drawer:
 *
 * - a code block scrolls sideways inside its own box (react-fancy gives `pre` `overflow-x: auto`; here it is also held to
 *   the column's width);
 * - a table becomes its own scroll box (`display: block`, at most the column's width, `overflow-x: auto`) — a Markdown
 *   table is not one by itself, so a wide one widened everything around it;
 * - long unbroken text wraps (`overflow-wrap: anywhere`, the rule the approval card already follows, genie#1503); a
 *   table's cells keep the ordinary rule, so a wide table scrolls rather than breaking every word into letters.
 */
export const CONTAINED_PROSE = '[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:[overflow-wrap:normal] [overflow-wrap:anywhere]';
