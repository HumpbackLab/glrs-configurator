fn main() {
    tauri_plugin::Builder::new(&["install"])
        .android_path("android")
        .build();
}
