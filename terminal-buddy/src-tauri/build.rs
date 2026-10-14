fn main() {
    #[cfg(feature = "desktop")]
    {
    println!("cargo:rerun-if-changed=resources/vscode-terminal");
    tauri_build::build()
    }
}
