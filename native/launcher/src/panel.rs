//! THE TRAY PANEL AND THE LAUNCH PAD'S MODEL (Tynn #1058, #1514/#1515). RED STUB: the tests come first.
use crate::tray::{Action, View};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Facts {
    pub view: View,
    pub paired: Vec<String>,
    pub at_logon: bool,
    pub host_started_ms: Option<u64>,
    pub now_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    Act(Action),
    Logon,
    Pad,
    Host(String),
}

pub fn panel(_f: &Facts) -> Value {
    Value::Null
}
pub fn panel_text(_p: &Value) -> Vec<String> {
    Vec::new()
}
pub fn pad(_f: &Facts) -> Value {
    Value::Null
}
pub fn pick(_id: &str) -> Option<Pick> {
    None
}
pub fn uptime(_ms: u64) -> String {
    String::new()
}
pub fn host_name(_url: &str) -> String {
    String::new()
}
pub fn read_paired(_runtime: &std::path::Path) -> Vec<String> {
    vec!["stub".to_string()]
}
pub fn place(_anchor: (i32, i32), _work: Rect, _size: (i32, i32), _margin: i32) -> (i32, i32) {
    (-1, -1)
}
