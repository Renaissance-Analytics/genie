/** A secret, reported for a log: whether it is there and how long it is, never any of its characters (CodeQL js/clear-text-logging, Tynn #966). */
export function secretNote(value) {
    if (value === null || value === undefined) return 'none';
    return `present, ${String(value).length} characters`;
}
