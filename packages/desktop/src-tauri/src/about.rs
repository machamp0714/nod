// 「nod について」に出す版情報。Contents/Resources/build-info（JSON）から作る。
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    version: String,
    commit: String,
    #[serde(default)]
    dirty: bool,
    build_time: String,
    schema_version: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct AboutText {
    /// アプリの版（例: 0.1.0）。
    pub version: String,
    /// 短縮 commit（未コミットの変更があれば +dirty）。
    pub commit: String,
    /// ビルド日時と schema 版を並べた補足。
    pub credits: String,
}

const UNKNOWN: &str = "不明";

pub fn about_text(build_info_json: Option<&str>) -> AboutText {
    let parsed = build_info_json.and_then(|s| serde_json::from_str::<BuildInfo>(s).ok());
    match parsed {
        Some(b) => {
            let short: String = b.commit.chars().take(7).collect();
            let commit = if short.is_empty() {
                UNKNOWN.to_string()
            } else if b.dirty {
                format!("{short}+dirty")
            } else {
                short
            };
            AboutText {
                version: b.version,
                commit,
                credits: format!("ビルド日時: {}\nschema: {}", b.build_time, b.schema_version),
            }
        }
        None => AboutText {
            version: UNKNOWN.to_string(),
            commit: UNKNOWN.to_string(),
            credits: format!("ビルド日時: {UNKNOWN}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_version_short_commit_and_build_time() {
        let j = r#"{"version":"0.1.0","commit":"cb0ab68aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","dirty":false,"buildTime":"2026-10-10T01:02:03.000Z","schemaVersion":12}"#;
        let a = about_text(Some(j));
        assert_eq!(a.version, "0.1.0");
        assert_eq!(a.commit, "cb0ab68");
        assert_eq!(a.credits, "ビルド日時: 2026-10-10T01:02:03.000Z\nschema: 12");
    }

    #[test]
    fn dirty_is_marked() {
        let j = r#"{"version":"0.1.0","commit":"cb0ab68aaaa","dirty":true,"buildTime":"t","schemaVersion":1}"#;
        assert_eq!(about_text(Some(j)).commit, "cb0ab68+dirty");
    }

    #[test]
    fn missing_or_broken_build_info_is_unknown() {
        for input in [None, Some("not json"), Some("{}")] {
            let a = about_text(input);
            assert_eq!(a.version, "不明");
            assert_eq!(a.commit, "不明");
        }
    }
}
