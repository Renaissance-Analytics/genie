//! A Windows command line from arguments, quoted the way CommandLineToArgvW and the MSVC runtime read it back
//! (genie-launch.c's `append_arg`, kept). Pure, so it is tested on every OS.

pub fn quote_arg(arg: &str) -> String {
    let _ = arg;
    todo!("L2")
}

pub fn command_line(args: &[String]) -> String {
    args.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ")
}
