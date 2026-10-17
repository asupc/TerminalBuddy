//! 手机接管期间的终端尺寸归属。电脑保留自己的尺寸，最后一个手机离开时恢复。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl TerminalSize {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self { rows: rows.clamp(1, 500), cols: cols.clamp(1, 500) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalViewport {
    pub size: TerminalSize,
    pub takeover: bool,
}

#[derive(Clone, Default)]
pub struct TerminalTakeover {
    desktop_size: Option<TerminalSize>,
    // 最近调整尺寸的手机优先；旧连接退出时不能覆盖仍在线手机的尺寸。
    mobile_sizes: Vec<(String, TerminalSize)>,
}

impl TerminalTakeover {
    pub fn viewport(&self, current: TerminalSize) -> TerminalViewport {
        TerminalViewport { size: current, takeover: !self.mobile_sizes.is_empty() }
    }

    /// 接管时只记住电脑请求的尺寸，不改变手机正在使用的 PTY。
    pub fn desktop_resize(&mut self, requested: TerminalSize) -> Option<TerminalSize> {
        if self.mobile_sizes.is_empty() {
            Some(requested)
        } else {
            self.desktop_size = Some(requested);
            None
        }
    }

    pub fn mobile_resize(&mut self, connection: &str, requested: TerminalSize, current: TerminalSize) {
        if self.mobile_sizes.is_empty() {
            self.desktop_size = Some(current);
        }
        self.mobile_sizes.retain(|(id, _)| id != connection);
        self.mobile_sizes.push((connection.to_string(), requested));
    }

    pub fn release(&mut self, connection: &str) -> Option<TerminalViewport> {
        let before = self.mobile_sizes.len();
        self.mobile_sizes.retain(|(id, _)| id != connection);
        if self.mobile_sizes.len() == before {
            return None;
        }
        if let Some((_, size)) = self.mobile_sizes.last() {
            Some(TerminalViewport { size: *size, takeover: true })
        } else {
            self.desktop_size.take().map(|size| TerminalViewport { size, takeover: false })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_adapts_and_exit_restores_original_desktop_grid() {
        let mut state = TerminalTakeover::default();
        let desktop = TerminalSize::new(40, 140);
        let phone = TerminalSize::new(32, 45);
        state.mobile_resize("phone", phone, desktop);
        assert!(state.viewport(phone).takeover);
        assert_eq!(state.release("phone"), Some(TerminalViewport { size: desktop, takeover: false }));
        assert!(!state.viewport(desktop).takeover);
    }

    #[test]
    fn desktop_resize_cannot_steal_phone_grid_and_is_restored_on_exit() {
        let mut state = TerminalTakeover::default();
        let desktop = TerminalSize::new(40, 140);
        let resized_desktop = TerminalSize::new(35, 100);
        state.mobile_resize("phone", TerminalSize::new(32, 45), desktop);
        assert_eq!(state.desktop_resize(resized_desktop), None);
        state.mobile_resize("phone", TerminalSize::new(16, 96), TerminalSize::new(32, 45));
        assert_eq!(state.release("phone").unwrap().size, resized_desktop);
        assert_eq!(state.desktop_resize(desktop), Some(desktop));
    }

    #[test]
    fn overlapping_reconnect_and_other_viewers_do_not_end_takeover() {
        let mut state = TerminalTakeover::default();
        let desktop = TerminalSize::new(40, 140);
        let phone = TerminalSize::new(32, 45);
        state.mobile_resize("old", phone, desktop);
        state.mobile_resize("new", phone, phone);
        assert_eq!(state.release("desktop-viewer"), None);
        assert_eq!(state.release("old"), Some(TerminalViewport { size: phone, takeover: true }));
        assert_eq!(state.release("old"), None);
        assert_eq!(state.release("new"), Some(TerminalViewport { size: desktop, takeover: false }));
        assert_eq!(state.release("new"), None);
    }

    #[test]
    fn active_phone_exit_returns_to_remaining_phone_before_desktop() {
        let mut state = TerminalTakeover::default();
        let desktop = TerminalSize::new(40, 140);
        let portrait = TerminalSize::new(32, 45);
        let landscape = TerminalSize::new(16, 96);
        state.mobile_resize("portrait", portrait, desktop);
        state.mobile_resize("landscape", landscape, portrait);
        assert_eq!(state.release("landscape"), Some(TerminalViewport { size: portrait, takeover: true }));
        assert_eq!(state.release("portrait"), Some(TerminalViewport { size: desktop, takeover: false }));
    }

    #[test]
    fn viewport_dimensions_are_always_valid_for_pty() {
        assert_eq!(TerminalSize::new(0, 65535), TerminalSize { rows: 1, cols: 500 });
    }
}
