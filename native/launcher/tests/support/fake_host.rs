//! A STAND-IN FOR genie-host AND genie-client in the launcher's tests (built only with the `test-keys` feature). As a
//! host it does what the launcher relies on: binds its endpoint, writes `host.token` and `host.json` (pid, endpoint,
//! protocol 4, its GENIE_HOST_BUILD), answers `hello` with the token by a `welcome`, `engine.ping`, and `engine.shutdown`
//! by exiting. As a client (any of `--host`, `--genie-browser`, `--open-window`, `--doctor`) it writes its arguments to
//! `<GENIE_HOME>/client-args.txt`, and its own path with what the launcher handed it (GENIE_LAUNCHER_EXE,
//! GENIE_LAUNCHER_HOST_BUILD) to `<GENIE_HOME>/client-env.txt`, and exits. As a host it prints the same, and its
//! GENIE_RESOURCES. FAKE_HOST_MODE=exit-at-boot makes the host exit at once.

use genie_launcher::local::LocalListener;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let home = PathBuf::from(std::env::var("GENIE_HOME").expect("GENIE_HOME"));
    println!("fake {} args {:?} cwd {}", std::process::id(), args, std::env::current_dir().unwrap().display());
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| "-".to_string());
    let exe = std::env::current_exe().unwrap().display().to_string();
    if args.iter().any(|a| a == "--host" || a == "--genie-browser" || a == "--open-window" || a == "--doctor") {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(home.join("client-args.txt")).unwrap();
        writeln!(f, "{}", args.join(" ")).unwrap();
        let mut e = std::fs::OpenOptions::new().create(true).append(true).open(home.join("client-env.txt")).unwrap();
        writeln!(e, "{} | exe={exe} launcher={} hostBuild={}", args.join(" "), env("GENIE_LAUNCHER_EXE"), env("GENIE_LAUNCHER_HOST_BUILD")).unwrap();
        return;
    }
    println!("fake host env exe={exe} launcher={} resources={}", env("GENIE_LAUNCHER_EXE"), env("GENIE_RESOURCES"));
    if std::env::var("FAKE_HOST_MODE").as_deref() == Ok("exit-at-boot") {
        std::process::exit(3);
    }
    let runtime = home.join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let endpoint = if cfg!(windows) { format!(r"\\.\pipe\genie-host-fake-{}", std::process::id()) } else { runtime.join("host.sock").display().to_string() };
    let listener = LocalListener::bind(&endpoint).expect("bind");
    let token = format!("t{}", std::process::id());
    std::fs::write(runtime.join("host.token"), &token).unwrap();
    let build = std::env::var("GENIE_HOST_BUILD").unwrap_or_default();
    let record = json!({"pid": std::process::id(), "endpoint": endpoint, "protocol": 4, "build": build, "startedAt": 1});
    std::fs::write(runtime.join("host.json.tmp"), record.to_string()).unwrap();
    std::fs::rename(runtime.join("host.json.tmp"), runtime.join("host.json")).unwrap();
    println!("fake host up on {endpoint}");
    loop {
        let Ok(stream) = listener.accept() else { continue };
        let token = token.clone();
        let build = build.clone();
        let runtime = runtime.clone();
        std::thread::spawn(move || {
            let mut out = stream.try_clone().unwrap();
            let mut welcomed = false;
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { return };
                let Ok(frame) = serde_json::from_str::<Value>(&line) else { return };
                if !welcomed {
                    if frame["kind"] == "hello" && frame["auth"]["token"] == token.as_str() {
                        welcomed = true;
                        let _ = writeln!(out, "{}", json!({"kind": "welcome", "connectionId": "c1", "host": "fake", "isOwner": true, "workspaceId": null, "protocol": 4, "build": build, "pid": std::process::id()}));
                        continue;
                    }
                    let _ = writeln!(out, "{}", json!({"kind": "refused", "reason": "bad token"}));
                    return;
                }
                let id = frame["id"].clone();
                match frame["method"].as_str() {
                    Some("engine.ping") => { let _ = writeln!(out, "{}", json!({"kind": "result", "id": id, "ok": true, "value": "pong"})); }
                    Some("engine.shutdown") => {
                        let _ = writeln!(out, "{}", json!({"kind": "result", "id": id, "ok": true, "value": true}));
                        let _ = out.flush();
                        let _ = std::fs::remove_file(runtime.join("host.json"));
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        println!("fake host shut down");
                        std::process::exit(0);
                    }
                    _ => { let _ = writeln!(out, "{}", json!({"kind": "result", "id": id, "ok": false, "reason": "unknown", "code": "unsupported"})); }
                }
            }
        });
    }
}
