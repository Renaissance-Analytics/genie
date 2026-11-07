/*
 * A value as a JavaScript string literal, for code a script hands to a page (CodeQL js/bad-code-sanitization, Tynn #966).
 * JSON.stringify makes the string literal; the characters a page or a parser could read as something else (angle
 * brackets, a slash, and the two line separators JavaScript once treated as line ends) are written as \u escapes, so the
 * literal reads back as exactly the value and nothing more.
 */
const ESCAPES = { '<': '\\u003C', '>': '\\u003E', '/': '\\u002F', '\u2028': '\\u2028', '\u2029': '\\u2029' };

export function codeLiteral(value) {
    return JSON.stringify(String(value)).replace(/[<>/\u2028\u2029]/g, (c) => ESCAPES[c]);
}
