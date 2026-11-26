//! THE COMPONENT REGISTRY: every program the launcher starts, and how each one updates. The owner, 2026-11-26: "the
//! launcher will by default launch the host, client and browser but once we have GApps working the launcher will list and
//! launch those as well", and "each item in the launcher should be able to receive updates on its own. host updates
//! always come with a UI update but ui, browser and Gapps can update without genie host needing to upgrade or shutdown."
//!
//! So each component is its own track with its own package and manifest. Only the host's update restarts the host, and a
//! host package names the client build it ships with (the manifest's `withClient`), which the updater (L6) applies with
//! it. A GApp joins this list as one more `Kind::Window`-like entry on a track of its own; nothing here is GApp-specific
//! yet. The launcher's own track is not a component: it is the program reading this list.

use crate::layout::Track;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Runs without a window, detached, and outlives every client (the host).
    Service,
    /// A program with windows, started when a person or a host asks for one (the client, the browser; GApps later).
    Window,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Component {
    pub id: &'static str,
    pub track: Track,
    pub kind: Kind,
    /// The arguments it is started with, before any the caller adds.
    pub args: &'static [&'static str],
    /// Its update stops and restarts the host (drain, swap, restore). Only the host's.
    pub restarts_host: bool,
    /// The track whose build its package names and is applied with (a host ships with its client).
    pub ships_with: Option<Track>,
}

pub const COMPONENTS: [Component; 3] = [
    Component { id: "host", track: Track::Host, kind: Kind::Service, args: &[], restarts_host: true, ships_with: Some(Track::Client) },
    Component { id: "client", track: Track::Client, kind: Kind::Window, args: &[], restarts_host: false, ships_with: None },
    Component { id: "browser", track: Track::Browser, kind: Kind::Window, args: &["--genie-browser"], restarts_host: false, ships_with: None },
];

pub fn component(id: &str) -> Option<&'static Component> {
    COMPONENTS.iter().find(|c| c.id == id)
}

/// The component a track's packages are for.
pub fn of_track(track: Track) -> Option<&'static Component> {
    COMPONENTS.iter().find(|c| c.track == track)
}
