//! The page's one command. Every call the window makes (`src/shared/ipc-channels.ts`) is relayed to
//! main as it came, and main's answer, a refusal included, comes back as the value: main parses the
//! payload, so the shell never reads it. Main's events come the other way as Tauri events, under
//! each channel's own name (`host.rs`).

use serde_json::{Map, Value};
use tauri::{AppHandle, Runtime};

use crate::shell;

#[tauri::command]
pub async fn main_invoke<R: Runtime>(
    app: AppHandle<R>,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let main = shell::main(&app).ok_or_else(|| "IdleBiz is still starting.".to_owned())?;
    let mut call = Map::new();
    call.insert("method".to_owned(), Value::String(method));
    // a call with no payload carries none: main reads a missing one, never a null, as nothing
    if let Some(payload) = payload {
        call.insert("payload".to_owned(), payload);
    }
    main.request("invoke", &Value::Object(call)).await
}
