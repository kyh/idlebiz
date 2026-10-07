//! What the window may show: main's own page, on the loopback origin main serves it from. Any other
//! web page opens in the browser instead, and nothing else loads, so a link in an agent-written page,
//! a dropped file or an injected script cannot navigate the founder's window away from main. The
//! same pin as kyh/inteligir's shell.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    OpenExternally,
    Deny,
}

/// The origin a window is pinned to, compared by its parts. Not `Url::origin`: the url crate
/// answers an opaque origin for any non-special scheme, so `tauri://localhost` would equal nothing,
/// and `tauri://app@evil` would carry a host of `evil` past a prefix compare.
pub fn comparable_origin(url: &Url) -> Option<String> {
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str().filter(|host| !host.is_empty())?;
    Some(match url.port_or_known_default() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

pub fn is_web_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// The origin of main's page, from the link main hands the shell: plain http on 127.0.0.1, at the
/// port main bound, and nothing else, since the window pinned to it holds the founder's approve
/// button.
pub fn page_origin(url: &Url) -> Option<String> {
    let loopback = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some_and(|port| port != 0);
    comparable_origin(url).filter(|_| loopback)
}

/// Compared by origin, never by prefix: `http://127.0.0.1:4664` prefixes `http://127.0.0.1:46640`.
/// The office draws no frame, so nothing else is allowed, `about:blank` included: WebKit asks the
/// same question of a frame's navigation and the page's own, and only the frame's could be wanted.
pub fn classify(target: &Url, pinned: &str) -> Verdict {
    if comparable_origin(target).as_deref() == Some(pinned) {
        return Verdict::Allow;
    }
    if is_web_url(target) {
        Verdict::OpenExternally
    } else {
        Verdict::Deny
    }
}

/// A script can navigate the page with no click, and every refused navigation to a web page would
/// open the browser, so a page in a loop would be a loop of launches. WebKit tells Tauri nothing of
/// the click behind a navigation, so the browser opens at most once a second instead.
pub struct ExternalOpens {
    last: Mutex<Option<Instant>>,
}

pub const EXTERNAL_OPEN_SPACING: Duration = Duration::from_secs(1);

impl ExternalOpens {
    pub const fn new() -> Self {
        Self {
            last: Mutex::new(None),
        }
    }

    /// Records the open when it is allowed.
    pub fn allow(&self, now: Instant) -> bool {
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let allowed =
            last.is_none_or(|at| now.saturating_duration_since(at) >= EXTERNAL_OPEN_SPACING);
        if allowed {
            *last = Some(now);
        }
        allowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap_or_else(|error| panic!("{value}: {error}"))
    }

    #[test]
    fn keeps_the_pinned_origin_on_any_path() {
        assert_eq!(
            classify(
                &url("http://127.0.0.1:4664/settings?tab=1"),
                "http://127.0.0.1:4664"
            ),
            Verdict::Allow
        );
        assert_eq!(
            classify(
                &url("tauri://localhost/first-run.html"),
                "tauri://localhost"
            ),
            Verdict::Allow
        );
    }

    #[test]
    fn compares_origins_not_prefixes() {
        let pinned = "http://127.0.0.1:4664";
        assert_eq!(
            classify(&url("http://127.0.0.1:46640/"), pinned),
            Verdict::OpenExternally
        );
        assert_eq!(
            classify(&url("http://localhost:4664/"), pinned),
            Verdict::OpenExternally
        );
        assert_eq!(
            classify(&url("https://127.0.0.1:4664/"), pinned),
            Verdict::OpenExternally
        );
    }

    #[test]
    fn a_login_in_the_url_is_no_origin() {
        assert_eq!(comparable_origin(&url("tauri://localhost@evil/")), None);
        assert_eq!(
            classify(&url("tauri://localhost@evil/"), "tauri://localhost"),
            Verdict::Deny
        );
        assert_eq!(
            classify(&url("http://user@127.0.0.1:4664/"), "http://127.0.0.1:4664"),
            Verdict::OpenExternally
        );
    }

    #[test]
    fn main_s_page_is_plain_http_on_loopback_at_a_port() {
        assert_eq!(
            page_origin(&url("http://127.0.0.1:52100/?handoff=n")).as_deref(),
            Some("http://127.0.0.1:52100")
        );
        for refused in [
            "https://127.0.0.1:52100/",
            "http://localhost:52100/",
            "http://127.0.0.1/",
            "http://example.com:52100/",
            "http://me@127.0.0.1:52100/",
            "tauri://localhost/",
        ] {
            assert_eq!(page_origin(&url(refused)), None, "{refused}");
        }
    }

    #[test]
    fn opens_other_web_pages_in_the_browser_and_refuses_the_rest() {
        let pinned = "http://127.0.0.1:4664";
        assert_eq!(
            classify(&url("https://example.com/"), pinned),
            Verdict::OpenExternally
        );
        assert_eq!(classify(&url("file:///etc/passwd"), pinned), Verdict::Deny);
        assert_eq!(classify(&url("javascript:alert(1)"), pinned), Verdict::Deny);
        assert_eq!(classify(&url("tauri://localhost/"), pinned), Verdict::Deny);
    }

    #[test]
    fn leaves_the_page_for_no_blank_document() {
        let pinned = "http://127.0.0.1:4664";
        assert_eq!(classify(&url("about:srcdoc"), pinned), Verdict::Deny);
        assert_eq!(classify(&url("about:blank"), pinned), Verdict::Deny);
        assert_eq!(classify(&url("about:config"), pinned), Verdict::Deny);
    }

    #[test]
    fn opens_the_browser_at_most_once_a_second() {
        let opens = ExternalOpens::new();
        let start = Instant::now();
        assert!(opens.allow(start));
        assert!(!opens.allow(start + Duration::from_millis(400)));
        assert!(opens.allow(start + EXTERNAL_OPEN_SPACING));
    }
}
