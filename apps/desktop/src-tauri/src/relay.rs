//! The framing of the channel to main: JSON-RPC 2.0, one message per line, requests both ways
//! (`apps/desktop/src/main/relay/rpc.ts` is main's end). Pure, so every shape is tested here; the
//! process and its threads are `main_process.rs`'s.

use serde_json::{Value, json};

#[derive(Debug, PartialEq)]
pub enum Incoming {
    /// Main asks the shell for something only a native app does, and waits for the answer.
    Request {
        id: u64,
        method: String,
        params: Value,
    },
    /// Main tells the shell something, and waits for nothing.
    Notification { method: String, params: Value },
    /// Main answers a request the shell made: its result, or the sentence it failed with.
    Response {
        id: u64,
        outcome: Result<Value, String>,
    },
}

/// One line main wrote, or `None` for a line that is no message: the shell logs those.
pub fn parse_line(line: &str) -> Option<Incoming> {
    let message: Value = serde_json::from_str(line).ok()?;
    let fields = message.as_object()?;
    if fields.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    let id = fields.get("id").and_then(Value::as_u64);
    let params = || fields.get("params").cloned().unwrap_or(Value::Null);
    match (fields.get("method").and_then(Value::as_str), id) {
        (Some(method), Some(id)) => Some(Incoming::Request {
            id,
            method: method.to_owned(),
            params: params(),
        }),
        (Some(method), None) => Some(Incoming::Notification {
            method: method.to_owned(),
            params: params(),
        }),
        (None, Some(id)) => {
            let outcome = match (fields.get("result"), fields.get("error")) {
                (_, Some(error)) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("main failed with no message")
                    .to_owned()),
                (Some(result), None) => Ok(result.clone()),
                (None, None) => return None,
            };
            Some(Incoming::Response { id, outcome })
        }
        (None, None) => None,
    }
}

pub fn request_line(id: u64, method: &str, params: &Value) -> String {
    json!({ "id": id, "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

pub fn notification_line(method: &str, params: &Value) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

pub fn response_line(id: u64, outcome: &Result<Value, String>) -> String {
    match outcome {
        Ok(result) => json!({ "id": id, "jsonrpc": "2.0", "result": result }),
        Err(message) => {
            json!({ "error": { "code": -32_000, "message": message }, "id": id, "jsonrpc": "2.0" })
        }
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_requests_notifications_and_responses() {
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":3,"method":"host.open","params":{"kind":"url"}}"#),
            Some(Incoming::Request {
                id: 3,
                method: "host.open".to_owned(),
                params: json!({ "kind": "url" }),
            })
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","method":"host.relaunch","params":null}"#),
            Some(Incoming::Notification {
                method: "host.relaunch".to_owned(),
                params: Value::Null,
            })
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#),
            Some(Incoming::Response {
                id: 1,
                outcome: Ok(json!({ "ok": true })),
            })
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":1,"result":null}"#),
            Some(Incoming::Response {
                id: 1,
                outcome: Ok(Value::Null),
            })
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"no"}}"#),
            Some(Incoming::Response {
                id: 2,
                outcome: Err("no".to_owned()),
            })
        );
    }

    #[test]
    fn a_line_that_is_no_message_is_none() {
        for line in [
            "",
            "Warning: something a library printed",
            r#"{"id":1,"result":null}"#,
            r#"{"jsonrpc":"2.0","id":1}"#,
            r#"{"jsonrpc":"2.0"}"#,
            "[1,2]",
        ] {
            assert_eq!(parse_line(line), None, "{line:?}");
        }
    }

    #[test]
    fn writes_what_main_reads_back() {
        let params = json!({ "method": "getCompany" });
        assert_eq!(
            parse_line(&request_line(7, "invoke", &params)),
            Some(Incoming::Request {
                id: 7,
                method: "invoke".to_owned(),
                params,
            })
        );
        assert_eq!(
            parse_line(&notification_line("tray", &json!({ "on": true }))),
            Some(Incoming::Notification {
                method: "tray".to_owned(),
                params: json!({ "on": true }),
            })
        );
        assert_eq!(
            parse_line(&response_line(4, &Err("refused".to_owned()))),
            Some(Incoming::Response {
                id: 4,
                outcome: Err("refused".to_owned()),
            })
        );
        assert_eq!(
            parse_line(&response_line(5, &Ok(json!("on")))),
            Some(Incoming::Response {
                id: 5,
                outcome: Ok(json!("on")),
            })
        );
    }
}
