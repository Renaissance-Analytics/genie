/**
 * TIMES AS A PERSON READS THEM (the owner, 2026-10-25: "don't show the rate limit resume time in military time, use the
 * standard am/pm format and include a tooltip on hover that shows the full date and time").
 *
 * `2:31 PM` on the surface; `Sunday, October 25, 2026 at 2:31 PM` on hover — in the viewer's own time zone. ICU puts a
 * narrow no-break space before AM/PM; it is written as a plain space, so every surface (and every test) reads the same
 * characters.
 */

const plain = (s: string) => s.replace(/ /g, ' ');

/** `2:31 PM`, `9:05 AM`, `12:00 AM`. */
export function clockAmPm(at: number): string {
    return plain(new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }));
}

/** `Sunday, October 25, 2026 at 2:31 PM` — for a hover. */
export function fullDateTime(at: number): string {
    return plain(new Date(at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }));
}
