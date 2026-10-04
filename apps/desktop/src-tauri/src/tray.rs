//! The menu-bar icon: a template image the system colours, beside the title, tooltip and menu main
//! decides (`apps/cli/src/server/tray.ts`). It is drawn on main's first model and redrawn on each
//! one after. A click the shell can answer itself (Open, Quit) is answered here. A click on the
//! autopilot item goes to main with the state its label promised.

use serde::Deserialize;
use serde_json::json;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

use crate::{shell, window};

const TRAY_ID: &str = "office";
/// 32 px, the 2x the menu bar draws at 16 pt: the system scales it to the bar's height.
const ICON: &[u8] = include_bytes!("../icons/tray.png");

const OPEN: &str = "open";
const STATUS: &str = "status";
const AUTOPILOT_ON: &str = "autopilot-on";
const AUTOPILOT_OFF: &str = "autopilot-off";
const QUIT: &str = "quit";

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrayItem {
    Open {
        label: String,
    },
    Status {
        label: String,
    },
    Autopilot {
        label: String,
        enabled: bool,
        on: bool,
    },
    Separator,
    Quit {
        label: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct TrayModel {
    title: String,
    tooltip: String,
    items: Vec<TrayItem>,
}

fn menu<R: Runtime>(app: &AppHandle<R>, items: &[TrayItem]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for item in items {
        match item {
            TrayItem::Open { label } => {
                menu.append(&MenuItem::with_id(app, OPEN, label, true, None::<&str>)?)?;
            }
            TrayItem::Status { label } => {
                menu.append(&MenuItem::with_id(app, STATUS, label, false, None::<&str>)?)?;
            }
            TrayItem::Autopilot { label, enabled, on } => {
                let id = if *on { AUTOPILOT_ON } else { AUTOPILOT_OFF };
                menu.append(&MenuItem::with_id(app, id, label, *enabled, None::<&str>)?)?;
            }
            TrayItem::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            TrayItem::Quit { label } => {
                menu.append(&MenuItem::with_id(app, QUIT, label, true, None::<&str>)?)?;
            }
        }
    }
    Ok(menu)
}

fn clicked<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    match event.id().as_ref() {
        OPEN => window::show(app),
        AUTOPILOT_ON => shell::tell_main(app, "tray", &json!({ "on": true })),
        AUTOPILOT_OFF => shell::tell_main(app, "tray", &json!({ "on": false })),
        QUIT => app.exit(0),
        _ => {}
    }
}

fn redraw<R: Runtime>(app: &AppHandle<R>, model: &TrayModel) -> tauri::Result<()> {
    let menu = menu(app, &model.items)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
        tray.set_tooltip(Some(&model.tooltip))?;
        tray.set_title(Some(&model.title))?;
        return Ok(());
    }
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON)?)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip(&model.tooltip)
        .title(&model.title)
        .on_menu_event(|app, event| clicked(app, &event))
        .build(app)?;
    Ok(())
}

pub fn draw<R: Runtime>(app: &AppHandle<R>, model: &TrayModel) {
    if let Err(error) = redraw(app, model) {
        eprintln!("[shell] could not draw the menu-bar icon: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_model_main_sends() -> Result<(), serde_json::Error> {
        let model: TrayModel = serde_json::from_value(json!({
            "items": [
                { "kind": "open", "label": "Open Acme" },
                { "kind": "separator" },
                { "kind": "status", "label": "2 working" },
                { "enabled": true, "kind": "autopilot", "label": "Pause the office", "on": false },
                { "kind": "quit", "label": "Quit IdleBiz" }
            ],
            "title": " ● 2",
            "tooltip": "IdleBiz — 2 working"
        }))?;
        assert_eq!(model.items.len(), 5);
        assert!(matches!(
            model.items[3],
            TrayItem::Autopilot {
                on: false,
                enabled: true,
                ..
            }
        ));
        Ok(())
    }
}
