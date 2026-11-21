#[cfg(windows)]
use clipboard_win::raw;
#[cfg(windows)]
use crate::services::PathService;
#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
};

#[cfg(windows)]
const CF_DIB: u32 = 8;

#[cfg(windows)]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    raw::open().map_err(|e| format!("Failed to open clipboard: {}", e))?;
    let result = (|| -> Result<Vec<String>, String> {
        let mut paths: Vec<PathBuf> = Vec::new();
        raw::get_file_list_path(&mut paths)
            .map_err(|e| format!("Failed to read clipboard file list: {}", e))?;
        Ok(paths
            .iter()
            .filter_map(|p| p.to_str().map(String::from))
            .collect())
    })();
    let _ = raw::close();
    result
}

/// Read clipboard image data (e.g. from PrintScreen) and save as PNG to temp dir.
#[cfg(windows)]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn read_clipboard_image_as_file() -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("TerminalBuddy");
    let filename = format!(
        "clipboard_{}.png",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    save_clipboard_dib_as_png(&temp_dir, &filename)
}

/// 剪贴板图片存入数据目录（Claude 图片引用辅助）：
/// `@<path>` 引用要求 Claude 之后仍能读到该文件，TEMP 会被系统清理，故落到 dataPath。
#[cfg(windows)]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_clipboard_image_to_claude_cache() -> Result<String, String> {
    let dir = PathService::require_data_dir()?
        .join("ClientData")
        .join("claude-images");
    let filename = format!("img_{}.png", chrono::Utc::now().timestamp_millis());
    save_clipboard_dib_as_png(&dir, &filename)
}

/// 读取剪贴板 CF_DIB 位图并保存为 PNG 到指定目录。
#[cfg(windows)]
fn save_clipboard_dib_as_png(dest_dir: &Path, filename: &str) -> Result<String, String> {
    unsafe {
        if IsClipboardFormatAvailable(CF_DIB).is_err() {
            return Err("剪贴板中没有图片".to_string());
        }

        OpenClipboard(None).map_err(|e| format!("Failed to open clipboard: {}", e))?;

        let result = (|| -> Result<String, String> {
            let handle = GetClipboardData(CF_DIB)
                .map_err(|e| format!("Failed to get clipboard data: {}", e))?;
            let ptr = handle.0 as *const u8;
            if ptr.is_null() {
                return Err("Null clipboard data".to_string());
            }

            // Parse BITMAPINFOHEADER (40 bytes)
            let bih = std::slice::from_raw_parts(ptr, 40);
            let bi_width = u32::from_le_bytes(bih[4..8].try_into().unwrap()) as u32;
            let bi_height = i32::from_le_bytes(bih[8..12].try_into().unwrap());
            let bi_bit_count = u16::from_le_bytes(bih[14..16].try_into().unwrap());
            let bi_compression = u32::from_le_bytes(bih[16..20].try_into().unwrap());

            if bi_width == 0 || bi_height == 0 {
                return Err("Empty bitmap".to_string());
            }

            let top_down = bi_height < 0;
            let abs_height = bi_height.abs() as u32;

            // Calculate palette size
            let palette_colors = if bi_bit_count <= 8 {
                1u32 << bi_bit_count
            } else {
                0
            };
            let palette_offset = (40 + palette_colors * 4) as usize;

            // Calculate row stride (DWORD-aligned)
            let row_stride = ((bi_width as u64 * bi_bit_count as u64 + 31) / 32 * 4) as usize;
            let pixel_data_size = row_stride * abs_height as usize;

            let all_data = std::slice::from_raw_parts(ptr, palette_offset + pixel_data_size);
            let pixel_data = &all_data[palette_offset..];

            // Build RGBA image buffer
            let mut rgba = vec![0u8; (bi_width * abs_height * 4) as usize];

            match bi_bit_count {
                32 => {
                    // BGRA -> RGBA
                    for y in 0..abs_height as usize {
                        let src_row = if top_down {
                            y
                        } else {
                            abs_height as usize - 1 - y
                        };
                        for x in 0..bi_width as usize {
                            let si = src_row * row_stride + x * 4;
                            let di = (y * bi_width as usize + x) * 4;
                            rgba[di] = pixel_data[si + 2]; // R
                            rgba[di + 1] = pixel_data[si + 1]; // G
                            rgba[di + 2] = pixel_data[si]; // B
                            rgba[di + 3] = if pixel_data[si + 3] == 0 {
                                255
                            } else {
                                pixel_data[si + 3]
                            };
                        }
                    }
                }
                24 => {
                    // BGR -> RGBA
                    for y in 0..abs_height as usize {
                        let src_row = if top_down {
                            y
                        } else {
                            abs_height as usize - 1 - y
                        };
                        for x in 0..bi_width as usize {
                            let si = src_row * row_stride + x * 3;
                            let di = (y * bi_width as usize + x) * 4;
                            rgba[di] = pixel_data[si + 2]; // R
                            rgba[di + 1] = pixel_data[si + 1]; // G
                            rgba[di + 2] = pixel_data[si]; // B
                            rgba[di + 3] = 255;
                        }
                    }
                }
                _ => return Err(format!("Unsupported bit depth: {}", bi_bit_count)),
            }

            if bi_compression != 0 && bi_compression != 3 {
                return Err(format!("Unsupported compression: {}", bi_compression));
            }

            // Save as PNG
            let expected_len = (bi_width as usize)
                .checked_mul(abs_height as usize)
                .and_then(|pixels| pixels.checked_mul(4))
                .ok_or_else(|| "Image dimensions too large".to_string())?;
            if rgba.len() != expected_len {
                return Err("Failed to create image buffer".to_string());
            }

            std::fs::create_dir_all(dest_dir)
                .map_err(|e| format!("Failed to create dir: {}", e))?;
            let file_path = dest_dir.join(filename);
            let file = std::fs::File::create(&file_path)
                .map_err(|e| format!("Failed to create PNG file: {}", e))?;
            let mut encoder =
                png::Encoder::new(std::io::BufWriter::new(file), bi_width, abs_height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|e| format!("Failed to write PNG header: {}", e))?;
            writer
                .write_image_data(&rgba)
                .map_err(|e| format!("Failed to save PNG: {}", e))?;

            file_path
                .to_str()
                .map(String::from)
                .ok_or_else(|| "Invalid path".to_string())
        })();

        let _ = CloseClipboard();
        result
    }
}

// ── 非 Windows 占位实现 ──────────────────────────────────────────────────────
// 剪贴板读取依赖 Windows 剪贴板 API 与 CF_DIB 位图格式；其他平台保留同名命令，
// 保证 Tauri 命令注册表在编译期一致，调用时返回明确错误。

#[cfg(not(windows))]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    Err("读取剪贴板文件仅支持 Windows 桌面端".to_string())
}

#[cfg(not(windows))]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn read_clipboard_image_as_file() -> Result<String, String> {
    Err("读取剪贴板图片仅支持 Windows 桌面端".to_string())
}

#[cfg(not(windows))]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_clipboard_image_to_claude_cache() -> Result<String, String> {
    Err("保存剪贴板图片仅支持 Windows 桌面端".to_string())
}
