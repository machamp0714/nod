// ウィンドウの位置・サイズの保存と、復元位置が画面内かの判定。物理ピクセルで扱う。
// 最大化・最小化・フルスクリーン・非表示の状態は保存対象に含めない。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// タイトルバー相当の帯の高さ。ここが画面内に残っていないとウィンドウを動かせない。
const TITLE_STRIP: i64 = 40;
/// 帯が画面と重なっているべき最小の幅・高さ。
const MIN_OVERLAP_W: i64 = 100;
const MIN_OVERLAP_H: i64 = 24;
/// 保存値として妥当なサイズの範囲。
const MIN_DIM: u32 = 200;
const MAX_DIM: u32 = 20_000;

fn overlap(a: (i64, i64, i64, i64), b: (i64, i64, i64, i64)) -> (i64, i64) {
    // (left, top, right, bottom)
    let w = a.2.min(b.2) - a.0.max(b.0);
    let h = a.3.min(b.3) - a.1.max(b.1);
    (w.max(0), h.max(0))
}

/// 保存された位置が、いずれかのモニターに十分重なっているか。
pub fn is_reachable(saved: &Rect, monitors: &[Rect]) -> bool {
    let x = saved.x as i64;
    let y = saved.y as i64;
    let strip = (x, y, x + saved.width as i64, y + TITLE_STRIP.min(saved.height as i64));
    monitors.iter().any(|m| {
        let mr = (m.x as i64, m.y as i64, m.x as i64 + m.width as i64, m.y as i64 + m.height as i64);
        let (w, h) = overlap(strip, mr);
        w >= MIN_OVERLAP_W && h >= MIN_OVERLAP_H
    })
}

/// 復元する矩形を決める。None は「既定のサイズ・位置（中央）で開く」。
pub fn resolve_placement(saved: Option<Rect>, monitors: &[Rect]) -> Option<Rect> {
    let s = saved?;
    if !(MIN_DIM..=MAX_DIM).contains(&s.width) || !(MIN_DIM..=MAX_DIM).contains(&s.height) {
        return None;
    }
    if is_reachable(&s, monitors) {
        Some(s)
    } else {
        None
    }
}

pub fn parse(json: &str) -> Option<Rect> {
    serde_json::from_str(json).ok()
}

pub fn serialize(r: &Rect) -> String {
    serde_json::to_string(r).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = Rect { x: 0, y: 0, width: 2560, height: 1600 };
    const RIGHT: Rect = Rect { x: 2560, y: 0, width: 1920, height: 1080 };

    fn win(x: i32, y: i32) -> Rect {
        Rect { x, y, width: 1280, height: 800 }
    }

    #[test]
    fn inside_a_monitor_is_kept() {
        assert_eq!(resolve_placement(Some(win(100, 100)), &[MAIN]), Some(win(100, 100)));
    }

    #[test]
    fn on_a_second_monitor_is_kept_only_while_it_exists() {
        assert_eq!(resolve_placement(Some(win(3000, 100)), &[MAIN, RIGHT]), Some(win(3000, 100)));
        assert_eq!(resolve_placement(Some(win(3000, 100)), &[MAIN]), None);
    }

    #[test]
    fn fully_offscreen_is_reset() {
        assert_eq!(resolve_placement(Some(win(10_000, 10_000)), &[MAIN]), None);
        assert_eq!(resolve_placement(Some(win(-5000, 0)), &[MAIN]), None);
        assert_eq!(resolve_placement(Some(win(0, -3000)), &[MAIN]), None);
    }

    #[test]
    fn only_a_sliver_visible_is_reset() {
        // 右端に 20px だけ残っている。
        assert_eq!(resolve_placement(Some(win(2540, 100)), &[MAIN]), None);
        // 十分な幅が残っていれば維持。
        assert_eq!(resolve_placement(Some(win(2400, 100)), &[MAIN]), Some(win(2400, 100)));
    }

    #[test]
    fn title_strip_below_the_screen_is_reset_even_if_origin_is_left() {
        assert_eq!(resolve_placement(Some(win(100, 1590)), &[MAIN]), None);
    }

    #[test]
    fn negative_origin_on_a_left_monitor() {
        let left = Rect { x: -1920, y: 0, width: 1920, height: 1080 };
        assert_eq!(resolve_placement(Some(win(-1500, 50)), &[MAIN, left]), Some(win(-1500, 50)));
    }

    #[test]
    fn none_saved_or_no_monitors_or_absurd_size_is_default() {
        assert_eq!(resolve_placement(None, &[MAIN]), None);
        assert_eq!(resolve_placement(Some(win(0, 0)), &[]), None);
        let tiny = Rect { x: 0, y: 0, width: 10, height: 10 };
        assert_eq!(resolve_placement(Some(tiny), &[MAIN]), None);
        let huge = Rect { x: 0, y: 0, width: 1_000_000, height: 800 };
        assert_eq!(resolve_placement(Some(huge), &[MAIN]), None);
    }

    #[test]
    fn json_round_trip_and_garbage() {
        let r = win(-10, 20);
        assert_eq!(parse(&serialize(&r)), Some(r));
        assert_eq!(parse("not json"), None);
        assert_eq!(parse("{\"x\":1}"), None);
    }
}
