//! A Windows command line from arguments, quoted the way CommandLineToArgvW and the MSVC runtime read it back
//! (genie-launch.c's `append_arg`, kept). Pure, so it is tested on every OS.

pub fn quote_arg(arg: &str) -> String {
    let plain = !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\u{0b}' | '"'));
    if plain {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut slashes = 0usize;
    for c in arg.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            // Backslashes before a quote are doubled, and the quote itself escaped.
            out.extend(std::iter::repeat('\\').take(slashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat('\\').take(slashes));
        }
        slashes = 0;
        out.push(c);
    }
    // Backslashes before the closing quote are doubled.
    out.extend(std::iter::repeat('\\').take(slashes * 2));
    out.push('"');
    out
}

pub fn command_line(args: &[String]) -> String {
    args.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ")
}
