use std::path::PathBuf;
use clipboard_win::raw;
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};

const CF_DIB: u32 = 8;

#[tauri::command]
pub fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    raw::open().map_err(|e| format!("Failed to open clipboard: {}", e))?;
    let result = (|| -> Result<Vec<String>, String> {
        let mut paths: Vec<PathBuf> = Vec::new();
        raw::get_file_list_path(&mut paths)
            .map_err(|e| format!("Failed to read clipboard file list: {}", e))?;
        Ok(paths.iter().filter_map(|p| p.to_str().map(String::from)).collect())
    })();
    let _ = raw::close();
    result
}

/// Read clipboard image data (e.g. from PrintScreen) and save as BMP to temp dir.
#[tauri::command]
pub fn read_clipboard_image_as_file() -> Result<String, String> {
    use std::io::Write;

    unsafe {
        if IsClipboardFormatAvailable(CF_DIB).is_err() {
            return Err("No image in clipboard".to_string());
        }

        OpenClipboard(None).map_err(|e| format!("Failed to open clipboard: {}", e))?;

        let result = (|| -> Result<String, String> {
            let handle = GetClipboardData(CF_DIB)
                .map_err(|e| format!("Failed to get clipboard data: {}", e))?;
            let ptr = handle.0 as *const u8;
            if ptr.is_null() {
                return Err("Null clipboard data".to_string());
            }

            // BITMAPINFOHEADER is 40 bytes
            let bih = std::slice::from_raw_parts(ptr, 40);
            let bi_width = u32::from_le_bytes(bih[4..8].try_into().unwrap()) as i32;
            let bi_height = u32::from_le_bytes(bih[8..12].try_into().unwrap()) as i32;
            let bi_bit_count = u16::from_le_bytes(bih[14..16].try_into().unwrap());
            let bi_size_image = u32::from_le_bytes(bih[20..24].try_into().unwrap());
            let bi_compression = u32::from_le_bytes(bih[16..20].try_into().unwrap());

            if bi_width == 0 || bi_height == 0 {
                return Err("Empty bitmap".to_string());
            }

            let row_size = ((bi_width as u64 * bi_bit_count as u64 + 31) / 32 * 4) as u32;
            let dib_data_size = if bi_size_image > 0 && bi_compression != 0 {
                bi_size_image
            } else {
                row_size * bi_height.abs() as u32
            };
            let palette_size = if bi_bit_count <= 8 { (1u32 << bi_bit_count) * 4 } else { 0 };
            let total_dib_size = 40 + palette_size + dib_data_size;

            let dib_data = std::slice::from_raw_parts(ptr, total_dib_size as usize);

            // BMP = 14-byte file header + DIB data
            let mut bmp = Vec::with_capacity((14 + total_dib_size) as usize);
            bmp.extend_from_slice(b"BM");
            bmp.extend_from_slice(&((14 + total_dib_size) as u32).to_le_bytes());
            bmp.extend_from_slice(&[0u8; 4]);
            bmp.extend_from_slice(&(14u32 + 40 + palette_size).to_le_bytes());
            bmp.extend_from_slice(dib_data);

            let temp_dir = std::env::temp_dir().join("TerminalBuddy");
            std::fs::create_dir_all(&temp_dir)
                .map_err(|e| format!("Failed to create temp dir: {}", e))?;

            let file_path = temp_dir.join(format!(
                "clipboard_{}.bmp",
                chrono::Local::now().format("%Y%m%d_%H%M%S")
            ));

            std::fs::File::create(&file_path)
                .and_then(|mut f| f.write_all(&bmp))
                .map_err(|e| format!("Failed to write file: {}", e))?;

            file_path.to_str().map(String::from).ok_or_else(|| "Invalid path".to_string())
        })();

        let _ = CloseClipboard();
        result
    }
}
