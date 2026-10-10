// WebView の遷移先の判定。自分の sidecar の origin（http://127.0.0.1:<ポート>）だけをアプリ内で開き、
// 外部の http(s) は既定ブラウザへ渡し、それ以外（file・about・mailto など）は拒否する。
use url::{Host, Url};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum NavDecision {
    /// アプリ内の WebView で開く（自分の origin）。
    Allow,
    /// 既定ブラウザで開く（アプリ内では遷移しない）。
    OpenExternal,
    /// 何もしない。
    Deny,
}

fn is_loopback_v4(url: &Url) -> bool {
    matches!(url.host(), Some(Host::Ipv4(ip)) if ip.octets() == [127, 0, 0, 1])
}

/// http://127.0.0.1:<port> と同じ origin か。userinfo 付きは別物として扱う。
pub fn is_own_origin(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && is_loopback_v4(url)
        && url.port_or_known_default() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn decide(url: &Url, own_port: u16) -> NavDecision {
    if is_own_origin(url, own_port) {
        return NavDecision::Allow;
    }
    match url.scheme() {
        "http" | "https" if url.host().is_some() => NavDecision::OpenExternal,
        _ => NavDecision::Deny,
    }
}

/// 「ブラウザで開く」に渡してよい URL か。http(s) の 127.0.0.1 のみ（userinfo なし）。
pub fn is_openable_local_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && is_loopback_v4(url)
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn own_origin_accepts_same_host_and_port_with_any_path() {
        assert!(is_own_origin(&u("http://127.0.0.1:4700/"), 4700));
        assert!(is_own_origin(&u("http://127.0.0.1:4700/issues/NOD-1?x=1#h"), 4700));
    }

    #[test]
    fn own_origin_rejects_other_port_host_scheme() {
        assert!(!is_own_origin(&u("http://127.0.0.1:4701/"), 4700));
        assert!(!is_own_origin(&u("http://localhost:4700/"), 4700));
        assert!(!is_own_origin(&u("https://127.0.0.1:4700/"), 4700));
        assert!(!is_own_origin(&u("http://127.0.0.2:4700/"), 4700));
        assert!(!is_own_origin(&u("http://example.com/"), 4700));
        assert!(!is_own_origin(&u("file:///etc/hosts"), 4700));
        assert!(!is_own_origin(&u("about:blank"), 4700));
    }

    #[test]
    fn own_origin_rejects_confusing_urls() {
        // userinfo に 127.0.0.1:4700 を置いて、実際のホストは別のもの。
        let evil = u("http://127.0.0.1:4700@evil.example/");
        assert!(!is_own_origin(&evil, 4700));
        assert_eq!(decide(&evil, 4700), NavDecision::OpenExternal);
        // 自分の origin でも userinfo が付けば別扱い。
        assert!(!is_own_origin(&u("http://user:pw@127.0.0.1:4700/"), 4700));
        assert!(Url::parse("http://127.0.0.1:4700.evil.example/").is_err());
        assert!(!is_own_origin(&u("http://127.0.0.1.evil.example:4700/"), 4700));
        assert!(!is_own_origin(&u("http://127.0.0.1:47000/"), 4700));
    }

    #[test]
    fn default_port_is_compared_by_known_default() {
        assert!(is_own_origin(&u("http://127.0.0.1/"), 80));
        assert!(!is_own_origin(&u("http://127.0.0.1/"), 4700));
    }

    #[test]
    fn decide_routes_external_http_to_browser_and_denies_the_rest() {
        assert_eq!(decide(&u("http://127.0.0.1:4700/a"), 4700), NavDecision::Allow);
        assert_eq!(decide(&u("https://example.com/"), 4700), NavDecision::OpenExternal);
        assert_eq!(decide(&u("http://127.0.0.1:4701/"), 4700), NavDecision::OpenExternal);
        assert_eq!(decide(&u("file:///etc/hosts"), 4700), NavDecision::Deny);
        assert_eq!(decide(&u("about:blank"), 4700), NavDecision::Deny);
        assert_eq!(decide(&u("mailto:a@example.com"), 4700), NavDecision::Deny);
        assert_eq!(decide(&u("javascript:alert(1)"), 4700), NavDecision::Deny);
    }

    #[test]
    fn openable_local_url_is_loopback_http_only() {
        assert!(is_openable_local_url(&u("http://127.0.0.1:4700/x")));
        assert!(is_openable_local_url(&u("https://127.0.0.1:8443/")));
        assert!(!is_openable_local_url(&u("http://example.com/")));
        assert!(!is_openable_local_url(&u("http://127.0.0.1:4700@evil.example/")));
        assert!(!is_openable_local_url(&u("file:///tmp/x")));
        assert!(!is_openable_local_url(&u("about:blank")));
    }
}
