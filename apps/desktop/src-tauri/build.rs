// The shell answers the page no command: the page calls main on main's own origin. With no
// capability granting a plugin's commands either, `removeUnusedCommands` drops every one of them.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri_build::try_build(tauri_build::Attributes::new())?;
    Ok(())
}
