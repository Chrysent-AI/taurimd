fn main() {
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    compile_error!("macOS builds support Apple Silicon only");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "select_root",
            "get_index",
            "query_index",
            "complete_path",
            "refresh_index",
            "get_siblings",
            "read_preview",
            "cancel_preview",
            "open_index_entry",
            "reveal_document",
            "pending_document",
            "receive_document",
            "dismiss_document",
            "select_document",
            "reload_document",
            "commit_document",
            "cancel_operation",
            "get_settings",
            "update_settings",
            "resolve_media",
            "cancel_remote_image",
            "activate_link",
            "present_reader",
            "begin_export",
            "append_export_image",
            "finish_export",
            "cancel_export",
        ]),
    ))
    .expect("native build configuration failed");
}
