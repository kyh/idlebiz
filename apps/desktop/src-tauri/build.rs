// The app manifest names every command the shell answers, so each one is an `allow-*` permission a
// capability must grant: no window reaches a command nothing granted it, and `removeUnusedCommands`
// drops the rest from the binary. The page has one, the relay to main (`src/commands.rs`).
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["main_invoke"])),
    )?;
    Ok(())
}
