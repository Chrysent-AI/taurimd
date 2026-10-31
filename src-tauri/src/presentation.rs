use crate::documents::AppError;
use serde::Deserialize;
use tauri::menu::{CheckMenuItem, MenuItem};

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Modal {
    #[default]
    None,
    Settings,
    Other,
}
#[derive(Clone, Copy, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presentation {
    pub sequence: u32,
    pub status_visible: bool,
    pub busy: bool,
    pub modal: Modal,
    pub composing: bool,
    pub page_zoom: u16,
}
impl Default for Presentation {
    fn default() -> Self {
        Self {
            sequence: 0,
            status_visible: true,
            busy: false,
            modal: Modal::None,
            composing: false,
            page_zoom: 100,
        }
    }
}
impl Presentation {
    pub fn accept(&mut self, caller: &str, next: Self) -> Result<(), AppError> {
        if caller != "reader" {
            return Err(AppError::new(
                "denied",
                "This window has no reader presentation access.",
            ));
        }
        if !(50..=300).contains(&next.page_zoom) || !next.page_zoom.is_multiple_of(10) {
            return Err(AppError::new(
                "unsupported",
                "Invalid page zoom presentation.",
            ));
        }
        if next.sequence > self.sequence {
            *self = next;
        }
        Ok(())
    }
    pub fn enabled(&self, action: &str, has_document: bool) -> bool {
        let free = !self.busy && !self.composing;
        match action {
            "zoom-in" => free && self.modal != Modal::Other && self.page_zoom < 300,
            "zoom-out" => free && self.modal != Modal::Other && self.page_zoom > 50,
            "zoom-reset" => free && self.modal != Modal::Other && self.page_zoom != 100,
            "reload" | "information" => free && self.modal == Modal::None && has_document,
            "open" | "settings" | "guide" | "about" | "status-bar" => {
                free && self.modal == Modal::None
            }
            _ => false,
        }
    }
}
pub struct ReaderMenu {
    pub actions: Vec<(&'static str, MenuItem<tauri::Wry>)>,
    pub status: CheckMenuItem<tauri::Wry>,
    pub applied: std::sync::Mutex<Presentation>,
}
impl ReaderMenu {
    pub fn apply(&self, presentation: &Presentation, has_document: bool) -> tauri::Result<()> {
        // Native check items toggle on activation; restore the applied value
        // until the reader acknowledges the change (even if saving fails).
        self.status.set_checked(presentation.status_visible)?;
        self.status
            .set_enabled(presentation.enabled("status-bar", has_document))?;
        for (id, item) in &self.actions {
            item.set_enabled(presentation.enabled(id, has_document))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presentation_wire_caller_ordering_and_menu_policy() {
        let mut applied = Presentation::default();
        let mut next: Presentation = serde_json::from_value(serde_json::json!({
            "sequence":2,"statusVisible":false,"busy":false,"modal":"none","composing":false,"pageZoom":300
        })).unwrap();
        assert!(applied.accept("other", next).is_err());
        assert!(applied.status_visible);
        applied.accept("reader", next).unwrap();
        assert!(!applied.status_visible);
        next.sequence = 1;
        next.status_visible = true;
        applied.accept("reader", next).unwrap();
        assert!(!applied.status_visible);
        assert!(!applied.enabled("zoom-in", true));
        assert!(applied.enabled("zoom-out", true));
        assert!(!applied.enabled("reload", false));
        assert!(!applied.enabled("information", false));
        assert!(applied.enabled("information", true));
        for modal in [Modal::Settings, Modal::Other] {
            applied.modal = modal;
            for action in [
                "open",
                "reload",
                "information",
                "guide",
                "about",
                "settings",
                "status-bar",
            ] {
                assert!(!applied.enabled(action, true));
            }
            assert_eq!(applied.enabled("zoom-out", true), modal == Modal::Settings);
        }
        for (busy, composing) in [(true, false), (false, true)] {
            applied.modal = Modal::None;
            applied.busy = busy;
            applied.composing = composing;
            for action in [
                "open",
                "reload",
                "guide",
                "settings",
                "status-bar",
                "zoom-out",
            ] {
                assert!(!applied.enabled(action, true));
            }
        }
        next.sequence = 3;
        next.page_zoom = 55;
        assert!(applied.accept("reader", next).is_err());
        for extra in [
            serde_json::json!({"path":"source.md"}),
            serde_json::json!({"statusVisible":"yes"}),
        ] {
            assert!(serde_json::from_value::<Presentation>(extra).is_err());
        }
    }
}
