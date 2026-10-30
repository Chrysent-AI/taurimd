fn main() {
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    compile_error!("macOS builds support Apple Silicon only");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "select_document",
            "reload_document",
            "commit_document",
            "cancel_operation",
            "get_settings",
            "update_settings",
        ]),
    ))
    .expect("native build configuration failed");
}
