fn main() {
    #[cfg(feature = "desktop")]
    {
        if std::env::var("PROFILE").as_deref() == Ok("release")
            && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        {
            println!("cargo:rustc-link-arg-bin=terminal-buddy=/DEBUG:NONE");
        }
        tauri_build::build()
    }
}
