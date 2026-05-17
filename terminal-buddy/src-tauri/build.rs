fn main() {
    // Embed Windows manifest with MSIX identity for Sparse Package support
    let manifest_path = std::path::PathBuf::from("../sparse-package/TerminalBuddy.manifest");
    if manifest_path.exists() {
        let mut res = winres::WindowsResource::new();
        res.set_manifest_file(manifest_path.to_str().unwrap());
        res.compile().expect("Failed to compile Windows resources");
    }

    tauri_build::build()
}
