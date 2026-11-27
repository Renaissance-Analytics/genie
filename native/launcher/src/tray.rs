//! THE LAUNCHER'S TRAY (Tynn #1058 L5; the spec's "The tray and residence"). The launcher owns the tray: Windows'
//! notification area (`Shell_NotifyIconW`), Linux's StatusNotifierItem over D-Bus (`ksni`, no GTK). The client has none.
//!
//! The menu is the owner's direction C tray screen (sandbox/launcher-design/shots/direction-c-tray.png), as the platform's
//! own menu draws it:
//!
//!   This computer's host · running · 3 agents
//!   Open Genie / Open Genie Browser
//!   Stop (or Start) this computer's host
//!   Close Genie (agents keep running)          = "Just close the UI"
//!   Shut down everything
//!
//! Stopping anything from here asks first, every time (the owner, 2026-11-02: "Always ask"), in a window of the launcher's
//! own (`ui::ask`): what stops, named; Cancel the default. A launcher with no window to ask in opens Genie instead, where
//! the client's Quit asks. Closing the UI stops nothing, so it does not ask. The tray is never the only way to do
//! something: Open Genie is the desktop entry's, and Quit is in the client's menu.

use crate::control::{self, Context};
use crate::{host, state};
use serde_json::Value;
use std::sync::Arc;

/// Genie's own tray mark (build/tray-icon.png, 32 x 32 RGBA), the client tray's before.
pub const ICON_PNG: &[u8] = include_bytes!("../../../build/tray-icon.png");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    OpenGenie,
    OpenBrowser,
    StartHost,
    StopHost,
    CloseUi,
    ShutDown,
}

impl Action {
    pub const ALL: [Action; 6] = [Action::OpenGenie, Action::OpenBrowser, Action::StartHost, Action::StopHost, Action::CloseUi, Action::ShutDown];
    pub fn id(self) -> u32 {
        Action::ALL.iter().position(|a| *a == self).unwrap_or(0) as u32 + 100
    }
    /// The name `launcher.trayAct` takes: openGenie, openBrowser, startHost, stopHost, closeUi, shutDown.
    pub fn parse(name: &str) -> Option<Action> {
        match name {
            "openGenie" => Some(Action::OpenGenie),
            "openBrowser" => Some(Action::OpenBrowser),
            "startHost" => Some(Action::StartHost),
            "stopHost" => Some(Action::StopHost),
            "closeUi" => Some(Action::CloseUi),
            "shutDown" => Some(Action::ShutDown),
            _ => None,
        }
    }
    pub fn from_id(id: u32) -> Option<Action> {
        id.checked_sub(100).and_then(|i| Action::ALL.get(i as usize).copied())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    /// A line that says something and does nothing.
    Label(String),
    Do { action: Action, label: String, enabled: bool },
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum HostView {
    /// No host on this computer (the client profile).
    #[default]
    NotHere,
    Stopped,
    Running { agents: Option<u64> },
}

/// What the tray shows: the local host, how many client windows are open, and whether the Genie Browser is installed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct View {
    pub host: HostView,
    pub windows: usize,
    pub browser: bool,
}

fn agents(n: u64) -> String {
    format!("{n} {}", if n == 1 { "agent" } else { "agents" })
}

/// The host's line, as the mockup's header says it.
pub fn host_line(v: &View) -> String {
    match &v.host {
        HostView::NotHere => "No host on this computer".to_string(),
        HostView::Stopped => "This computer’s host · stopped".to_string(),
        HostView::Running { agents: Some(n) } => format!("This computer’s host · running · {}", agents(*n)),
        HostView::Running { agents: None } => "This computer’s host · running".to_string(),
    }
}

pub fn tooltip(v: &View) -> String {
    format!("Genie · {}", host_line(v))
}

/// The menu, top to bottom.
pub fn menu(v: &View) -> Vec<Item> {
    let mut items = vec![Item::Label(host_line(v)), Item::Separator, Item::Do { action: Action::OpenGenie, label: "Open Genie".to_string(), enabled: true }];
    if v.browser {
        items.push(Item::Do { action: Action::OpenBrowser, label: "Open Genie Browser".to_string(), enabled: true });
    }
    match v.host {
        HostView::Running { .. } => {
            items.push(Item::Separator);
            items.push(Item::Do { action: Action::StopHost, label: "Stop this computer’s host".to_string(), enabled: true });
        }
        HostView::Stopped => {
            items.push(Item::Separator);
            items.push(Item::Do { action: Action::StartHost, label: "Start this computer’s host".to_string(), enabled: true });
        }
        HostView::NotHere => {}
    }
    items.push(Item::Separator);
    let keep = matches!(v.host, HostView::Running { .. });
    items.push(Item::Do { action: Action::CloseUi, label: if keep { "Close Genie (agents keep running)" } else { "Close Genie" }.to_string(), enabled: v.windows > 0 });
    items.push(Item::Do { action: Action::ShutDown, label: "Shut down everything".to_string(), enabled: true });
    items
}

/// What a question lists as stopping, from the host's own count (`engine.activity`); nothing when it did not say.
pub fn stopping(activity: Option<&Value>) -> Vec<String> {
    let Some(a) = activity else { return Vec::new() };
    let mut out = Vec::new();
    for (key, one, many) in [("agents", "agent", "agents"), ("terminals", "terminal", "terminals"), ("processes", "kept process", "kept processes"), ("services", "service", "services")] {
        if let Some(n) = a[key].as_u64().filter(|n| *n > 0) {
            let what = if key == "agents" {
                let names: Vec<&str> = a["agentNames"].as_array().map(|v| v.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                if names.is_empty() { format!("{n} {}", if n == 1 { one } else { many }) } else { format!("{n} {}: {}", if n == 1 { one } else { many }, names.join(", ")) }
            } else {
                format!("{n} {}", if n == 1 { one } else { many })
            };
            out.push(what);
        }
    }
    out
}

/// A question the launcher asks before it stops anything from the tray.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub title: String,
    pub lead: String,
    pub stops: Vec<String>,
    pub note: String,
    pub confirm: String,
}

/// "Shut down everything", asked: what stops, and whether Genie comes back at the next sign-in.
pub fn shut_down_question(activity: Option<&Value>, starts_at_logon: bool) -> Question {
    let stops = stopping(activity);
    let lead = if stops.is_empty() { "Nothing is running. Genie, its host and its tray close.".to_string() } else { "Genie, its host and its tray close. This stops:".to_string() };
    let note = if starts_at_logon { "Genie starts again when you sign in." } else { "Genie stays closed until you open it again." }.to_string();
    Question { title: "Shut down everything?".to_string(), lead, stops, note, confirm: "Shut down everything".to_string() }
}

/// "Stop this computer's host", asked.
pub fn stop_host_question(activity: Option<&Value>) -> Question {
    let stops = stopping(activity);
    let lead = if stops.is_empty() { "Nothing is running on the host.".to_string() } else { "The host stops, and with it:".to_string() };
    Question { title: "Stop this computer’s host?".to_string(), lead, stops, note: "Genie stays in the tray; Start this computer’s host brings it back.".to_string(), confirm: "Stop the host".to_string() }
}

/// The tray's view now.
pub fn view(ctx: &Context) -> View {
    let roots = &ctx.roots;
    let st = state::read(&roots.state_file()).ok();
    let has = |t: &str| st.as_ref().and_then(|s| s.track(t).and_then(|t| t.current.clone())).is_some();
    let running = host::read_record(roots).filter(|r| crate::spawn::pid_alive(r.pid)).is_some();
    let host = if running {
        HostView::Running { agents: host::activity(roots).and_then(|a| a["agents"].as_u64()) }
    } else if has("host") {
        HostView::Stopped
    } else {
        HostView::NotHere
    };
    View { host, windows: control::attached_pids(ctx).len(), browser: has("browser") }
}

fn ask(q: Question) -> Option<bool> {
    #[cfg(feature = "ui")]
    {
        crate::ui::ask(q)
    }
    #[cfg(not(feature = "ui"))]
    {
        let _ = q;
        None
    }
}

fn open_genie(ctx: &Context) {
    control::opened(&ctx.roots);
    let started = crate::components::component("client").ok_or_else(|| "no client component".to_string()).and_then(|c| control::start_component(&ctx.roots, c, vec!["--open-window".to_string()]));
    if let Err(why) = started {
        eprintln!("genie: tray: Open Genie: {why}");
    }
}

/// One of the menu's actions, on its own thread (the menu's thread never waits on a host or a question).
pub fn act(ctx: Arc<Context>, action: Action) {
    std::thread::spawn(move || {
        eprintln!("genie: tray: {action:?}");
        match action {
            Action::OpenGenie => open_genie(&ctx),
            Action::OpenBrowser => {
                if let Err(why) = crate::components::component("browser").ok_or_else(|| "no browser component".to_string()).and_then(|c| control::start_component(&ctx.roots, c, Vec::new())) {
                    eprintln!("genie: tray: Open Genie Browser: {why}");
                }
            }
            Action::StartHost => {
                let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
                if let Err(why) = host::ensure_host(&ctx.roots, &crate::keys::trusted_keys(&ctx.roots)) {
                    eprintln!("genie: tray: Start this computer's host: {why}");
                }
            }
            Action::StopHost => match ask(stop_host_question(host::activity(&ctx.roots).as_ref())) {
                Some(true) => {
                    let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
                    match host::stop_host(&ctx.roots) {
                        Ok(v) => eprintln!("genie: tray: the host stopped ({v})"),
                        Err(why) => eprintln!("genie: tray: Stop this computer's host: {why}"),
                    }
                }
                Some(false) => {}
                None => open_genie(&ctx),
            },
            Action::CloseUi => {
                if let Err(why) = control::close_ui(&ctx) {
                    eprintln!("genie: tray: Close Genie: {why}");
                }
            }
            Action::ShutDown => {
                let at_logon = crate::logon::read_settings(&ctx.roots).setting;
                match ask(shut_down_question(host::activity(&ctx.roots).as_ref(), at_logon)) {
                    Some(true) => control::shut_down(&ctx),
                    Some(false) => {}
                    None => open_genie(&ctx),
                }
            }
        }
    });
}

/// The menu as words, one item a line (`launcher.trayMenu` and the launcher's log): what the tray offers now.
pub fn menu_text(items: &[Item]) -> Vec<String> {
    items
        .iter()
        .map(|i| match i {
            Item::Label(t) => format!("[{t}]"),
            Item::Separator => "---".to_string(),
            Item::Do { label, enabled, .. } => if *enabled { label.clone() } else { format!("{label} (unavailable)") },
        })
        .collect()
}

/// The tray put up, on its own thread, and kept current (every 5 s, and on every menu opening).
pub fn start(ctx: Arc<Context>) {
    #[cfg(windows)]
    std::thread::spawn(move || win::run(ctx));
    #[cfg(unix)]
    std::thread::spawn(move || linux::run(ctx));
}

/// The tray taken away before the launcher exits (Windows leaves a dead icon until the pointer passes over it).
pub fn remove() {
    #[cfg(windows)]
    win::remove();
}

/// Shows the menu as a click on the icon does (`launcher.trayMenu` with GENIE_LAUNCHER_TRAY_PROBE=1: the VM rows'
/// screenshots). Linux's menu is drawn by the desktop's tray, which only a pointer opens: `false` there.
pub fn show_menu() -> bool {
    #[cfg(windows)]
    {
        win::post_show_menu()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Whether `launcher.trayMenu` may show the menu (a VM row's screenshot), as GENIE_TRAY_PROBE does for the client.
pub fn probe_enabled() -> bool {
    std::env::var("GENIE_LAUNCHER_TRAY_PROBE").as_deref() == Ok("1")
}

/// RGBA pixels of a non-interlaced 8-bit RGBA PNG (the tray mark): `(width, height, rgba)`.
pub fn decode_png_rgba(png: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if png.len() < 8 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let (mut at, mut w, mut h, mut idat) = (8usize, 0u32, 0u32, Vec::new());
    while at + 8 <= png.len() {
        let len = u32::from_be_bytes(png[at..at + 4].try_into().ok()?) as usize;
        let kind = &png[at + 4..at + 8];
        let data = png.get(at + 8..at + 8 + len)?;
        match kind {
            b"IHDR" => {
                w = u32::from_be_bytes(data[0..4].try_into().ok()?);
                h = u32::from_be_bytes(data[4..8].try_into().ok()?);
                if data[8] != 8 || data[9] != 6 || data[12] != 0 {
                    return None;
                }
            }
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        at += 12 + len;
    }
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&idat).ok()?;
    let stride = w as usize * 4;
    let mut out = vec![0u8; stride * h as usize];
    for y in 0..h as usize {
        let line = raw.get(y * (stride + 1)..(y + 1) * (stride + 1))?;
        let filter = line[0];
        for x in 0..stride {
            let a = if x >= 4 { out[y * stride + x - 4] as i32 } else { 0 };
            let b = if y > 0 { out[(y - 1) * stride + x] as i32 } else { 0 };
            let c = if x >= 4 && y > 0 { out[(y - 1) * stride + x - 4] as i32 } else { 0 };
            let v = line[1 + x] as i32;
            let pred = match filter {
                0 => 0,
                1 => a,
                2 => b,
                3 => (a + b) / 2,
                4 => {
                    let p = a + b - c;
                    let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
                    if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c }
                }
                _ => return None,
            };
            out[y * stride + x] = ((v + pred) & 0xff) as u8;
        }
    }
    Some((w, h, out))
}

#[cfg(windows)]
mod win {
    use super::{act, menu, tooltip, view, Action, Item, ICON_PNG};
    use crate::control::Context;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::{Arc, OnceLock};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::UI::Shell::{Shell_NotifyIconGetRect, Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW, NOTIFYICONIDENTIFIER};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    static WINDOW: AtomicIsize = AtomicIsize::new(0);
    static CTX: OnceLock<Arc<Context>> = OnceLock::new();
    static TASKBAR_CREATED: OnceLock<u32> = OnceLock::new();
    const WM_TRAY: u32 = WM_APP + 1;
    const WM_SHOW_MENU: u32 = WM_APP + 2;
    const ICON_ID: u32 = 1;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn data(hwnd: HWND) -> NOTIFYICONDATAW {
        let mut d: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        d.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        d.hWnd = hwnd;
        d.uID = ICON_ID;
        d
    }

    fn set_tip(d: &mut NOTIFYICONDATAW, text: &str) {
        let w: Vec<u16> = text.encode_utf16().take(d.szTip.len() - 1).collect();
        d.szTip[..w.len()].copy_from_slice(&w);
        d.szTip[w.len()] = 0;
    }

    fn add(hwnd: HWND) {
        let icon = unsafe { CreateIconFromResourceEx(ICON_PNG.as_ptr(), ICON_PNG.len() as u32, 1, 0x0003_0000, 0, 0, LR_DEFAULTCOLOR) };
        let mut d = data(hwnd);
        d.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        d.uCallbackMessage = WM_TRAY;
        d.hIcon = if icon.is_null() { unsafe { LoadIconW(std::ptr::null_mut(), IDI_APPLICATION) } } else { icon };
        set_tip(&mut d, "Genie");
        if unsafe { Shell_NotifyIconW(NIM_ADD, &d) } == 0 {
            eprintln!("genie: the tray icon could not be added");
        }
    }

    pub fn remove() {
        let hwnd = WINDOW.load(Ordering::SeqCst) as HWND;
        if !hwnd.is_null() {
            let d = data(hwnd);
            unsafe { Shell_NotifyIconW(NIM_DELETE, &d) };
        }
    }

    pub fn post_show_menu() -> bool {
        let hwnd = WINDOW.load(Ordering::SeqCst) as HWND;
        !hwnd.is_null() && unsafe { PostMessageW(hwnd, WM_SHOW_MENU, 0, 0) } != 0
    }

    /// Where the menu opens: at the icon (its rectangle), else at the pointer.
    fn anchor(hwnd: HWND, at_pointer: bool) -> POINT {
        let mut p = POINT { x: 0, y: 0 };
        if !at_pointer {
            let id = NOTIFYICONIDENTIFIER { cbSize: std::mem::size_of::<NOTIFYICONIDENTIFIER>() as u32, hWnd: hwnd, uID: ICON_ID, guidItem: unsafe { std::mem::zeroed() } };
            let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            if unsafe { Shell_NotifyIconGetRect(&id, &mut r) } == 0 {
                return POINT { x: (r.left + r.right) / 2, y: r.top };
            }
        }
        unsafe { GetCursorPos(&mut p) };
        p
    }

    fn show_menu(hwnd: HWND, at_pointer: bool) {
        let Some(ctx) = CTX.get() else { return };
        let items = menu(&view(ctx));
        eprintln!("genie: tray menu: {}", super::menu_text(&items).join(" | "));
        unsafe {
            let m = CreatePopupMenu();
            for item in &items {
                match item {
                    Item::Label(t) => {
                        AppendMenuW(m, MF_STRING | MF_GRAYED, 0, wide(t).as_ptr());
                    }
                    Item::Separator => {
                        AppendMenuW(m, MF_SEPARATOR, 0, std::ptr::null());
                    }
                    Item::Do { action, label, enabled } => {
                        AppendMenuW(m, MF_STRING | if *enabled { 0 } else { MF_GRAYED }, action.id() as usize, wide(label).as_ptr());
                    }
                }
            }
            let p = anchor(hwnd, at_pointer);
            SetForegroundWindow(hwnd);
            let chosen = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_RIGHTALIGN, p.x, p.y, 0, hwnd, std::ptr::null());
            PostMessageW(hwnd, WM_NULL, 0, 0);
            DestroyMenu(m);
            if let Some(a) = Action::from_id(chosen as u32) {
                act(Arc::clone(ctx), a);
            }
        }
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if Some(&msg) == TASKBAR_CREATED.get() {
            add(hwnd);
            return 0;
        }
        match msg {
            WM_TRAY => {
                match lparam as u32 {
                    WM_RBUTTONUP | WM_CONTEXTMENU => show_menu(hwnd, true),
                    WM_LBUTTONUP => {
                        if let Some(ctx) = CTX.get() {
                            act(Arc::clone(ctx), Action::OpenGenie);
                        }
                    }
                    _ => {}
                }
                0
            }
            WM_SHOW_MENU => {
                show_menu(hwnd, false);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn run(ctx: Arc<Context>) {
        let _ = CTX.set(Arc::clone(&ctx));
        unsafe {
            let class = wide("GenieLauncherTray");
            let instance = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW { style: 0, lpfnWndProc: Some(proc), cbClsExtra: 0, cbWndExtra: 0, hInstance: instance, hIcon: std::ptr::null_mut(), hCursor: std::ptr::null_mut(), hbrBackground: std::ptr::null_mut(), lpszMenuName: std::ptr::null(), lpszClassName: class.as_ptr() };
            RegisterClassW(&wc);
            let _ = TASKBAR_CREATED.set(RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()));
            // A hidden top-level window, not a message-only one: only top-level windows hear TaskbarCreated (Explorer
            // restarted), which puts the icon back.
            let hwnd = CreateWindowExW(0, class.as_ptr(), wide("Genie").as_ptr(), WS_OVERLAPPED, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), instance, std::ptr::null());
            if hwnd.is_null() {
                eprintln!("genie: the tray's window could not be made");
                return;
            }
            WINDOW.store(hwnd as isize, Ordering::SeqCst);
            add(hwnd);
            // The tooltip kept current.
            let tip_ctx = Arc::clone(&ctx);
            let tip_hwnd = hwnd as isize;
            std::thread::spawn(move || loop {
                let mut d = data(tip_hwnd as HWND);
                d.uFlags = NIF_TIP;
                set_tip(&mut d, &tooltip(&view(&tip_ctx)));
                #[allow(unused_unsafe)]
                unsafe {
                    Shell_NotifyIconW(NIM_MODIFY, &d);
                }
                std::thread::sleep(std::time::Duration::from_secs(5));
            });
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

#[cfg(unix)]
mod linux {
    use super::{act, decode_png_rgba, menu, tooltip, view, Item, View, ICON_PNG};
    use crate::control::Context;
    use std::sync::Arc;

    struct GenieTray {
        ctx: Arc<Context>,
        view: View,
        icon: Vec<ksni::Icon>,
    }

    impl ksni::Tray for GenieTray {
        fn id(&self) -> String {
            "genie-launcher".to_string()
        }
        fn title(&self) -> String {
            "Genie".to_string()
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            self.icon.clone()
        }
        fn tool_tip(&self) -> ksni::ToolTip {
            ksni::ToolTip { title: tooltip(&self.view), ..Default::default() }
        }
        fn activate(&mut self, _x: i32, _y: i32) {
            act(Arc::clone(&self.ctx), super::Action::OpenGenie);
        }
        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            menu(&self.view)
                .into_iter()
                .map(|item| match item {
                    Item::Label(label) => ksni::MenuItem::Standard(ksni::menu::StandardItem { label, enabled: false, ..Default::default() }),
                    Item::Separator => ksni::MenuItem::Separator,
                    Item::Do { action, label, enabled } => ksni::MenuItem::Standard(ksni::menu::StandardItem {
                        label,
                        enabled,
                        activate: Box::new(move |t: &mut GenieTray| act(Arc::clone(&t.ctx), action)),
                        ..Default::default()
                    }),
                })
                .collect()
        }
    }

    pub fn run(ctx: Arc<Context>) {
        // StatusNotifierItem's pixmap: ARGB32 in network byte order.
        let icon = decode_png_rgba(ICON_PNG)
            .map(|(w, h, rgba)| vec![ksni::Icon { width: w as i32, height: h as i32, data: rgba.chunks(4).flat_map(|p| [p[3], p[0], p[1], p[2]]).collect() }])
            .unwrap_or_default();
        let first = view(&ctx);
        eprintln!("genie: tray menu: {}", super::menu_text(&menu(&first)).join(" | "));
        let service = ksni::TrayService::new(GenieTray { ctx: Arc::clone(&ctx), view: first, icon });
        let handle = service.handle();
        // Its own thread, its error said (no session bus: no tray), never a panic: the launcher's release build aborts on one.
        std::thread::spawn(move || {
            if let Err(e) = service.run() {
                eprintln!("genie: the tray could not be put up (StatusNotifierItem over D-Bus): {e}");
            }
        });
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let v = view(&ctx);
            handle.update(move |t: &mut GenieTray| t.view = v.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn labels(items: &[Item]) -> Vec<String> {
        menu_text(items)
    }

    #[test]
    fn the_menu_with_the_host_running_and_a_window_open_is_the_mockups() {
        let v = View { host: HostView::Running { agents: Some(3) }, windows: 1, browser: true };
        assert_eq!(
            labels(&menu(&v)),
            vec!["[This computer’s host · running · 3 agents]", "---", "Open Genie", "Open Genie Browser", "---", "Stop this computer’s host", "---", "Close Genie (agents keep running)", "Shut down everything"]
        );
        assert_eq!(tooltip(&v), "Genie · This computer’s host · running · 3 agents");
    }

    #[test]
    fn with_no_window_open_close_genie_has_nothing_to_close() {
        let v = View { host: HostView::Running { agents: Some(1) }, windows: 0, browser: false };
        let m = labels(&menu(&v));
        assert!(m.contains(&"Close Genie (agents keep running) (unavailable)".to_string()), "{m:?}");
        assert!(m.contains(&"[This computer’s host · running · 1 agent]".to_string()), "{m:?}");
        assert!(!m.iter().any(|l| l.contains("Browser")), "no browser installed: {m:?}");
    }

    #[test]
    fn a_stopped_host_offers_start_and_a_client_only_computer_offers_neither() {
        let stopped = labels(&menu(&View { host: HostView::Stopped, windows: 1, browser: true }));
        assert!(stopped.contains(&"Start this computer’s host".to_string()), "{stopped:?}");
        assert!(stopped.contains(&"Close Genie".to_string()), "{stopped:?}");
        let none = labels(&menu(&View { host: HostView::NotHere, windows: 1, browser: false }));
        assert!(!none.iter().any(|l| l.contains("this computer’s host") && !l.starts_with('[')), "{none:?}");
        assert_eq!(none[0], "[No host on this computer]");
        assert_eq!(none.last().map(String::as_str), Some("Shut down everything"));
    }

    #[test]
    fn every_action_has_its_own_menu_id_and_back() {
        for a in Action::ALL {
            assert_eq!(Action::from_id(a.id()), Some(a));
        }
        assert_eq!(Action::from_id(0), None);
        assert_eq!(Action::from_id(99), None);
    }

    #[test]
    fn shut_down_everything_asks_naming_what_stops_and_whether_genie_comes_back() {
        let a = json!({"agents": 2, "agentNames": ["genie", "tynn"], "terminals": 1, "processes": 0, "services": 3});
        let q = shut_down_question(Some(&a), false);
        assert_eq!(q.title, "Shut down everything?");
        assert_eq!(q.confirm, "Shut down everything", "the confirm button names the action");
        assert_eq!(q.stops, vec!["2 agents: genie, tynn", "1 terminal", "3 services"]);
        assert_eq!(q.note, "Genie stays closed until you open it again.");
        assert_eq!(shut_down_question(None, true).note, "Genie starts again when you sign in.");
        assert!(shut_down_question(None, true).stops.is_empty());
        let s = stop_host_question(Some(&json!({"agents": 1, "agentNames": ["a"]})));
        assert_eq!(s.confirm, "Stop the host");
        assert_eq!(s.stops, vec!["1 agent: a"]);
    }

    #[test]
    fn the_tray_mark_decodes_to_32_by_32_pixels_that_are_not_all_clear() {
        let (w, h, rgba) = decode_png_rgba(ICON_PNG).expect("the mark decodes");
        assert_eq!((w, h), (32, 32));
        assert_eq!(rgba.len(), 32 * 32 * 4);
        assert!(rgba.chunks(4).filter(|p| p[3] > 0).count() > 50, "the mark has visible pixels");
    }
}
