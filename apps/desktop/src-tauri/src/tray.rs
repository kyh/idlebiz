//! The menu-bar icon: a template image the system colours, beside the title, tooltip and menu main
//! decides (`apps/cli/src/server/tray.ts`). It is drawn on main's first model and redrawn on each
//! one after. A click the shell can answer itself (Open, Quit) is answered here. A click on the
//! autopilot item goes to main with the state its label promised.

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

use crate::protocol::{self, TrayClick, TrayItem, TrayModel};
use crate::{shell, window};

const TRAY_ID: &str = "office";
/// 32 px, the 2x the menu bar draws at 16 pt: the system scales it to the bar's height.
const ICON: &[u8] = include_bytes!("../icons/tray.png");

const OPEN: &str = "open";
const STATUS: &str = "status";
const AUTOPILOT_ON: &str = "autopilot-on";
const AUTOPILOT_OFF: &str = "autopilot-off";
const QUIT: &str = "quit";

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
            TrayItem::Separator {} => menu.append(&PredefinedMenuItem::separator(app)?)?,
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
        AUTOPILOT_ON => shell::tell_main(app, protocol::TRAY_CLICK, &TrayClick { on: true }),
        AUTOPILOT_OFF => shell::tell_main(app, protocol::TRAY_CLICK, &TrayClick { on: false }),
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
