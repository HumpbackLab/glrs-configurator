#![cfg(target_os = "android")]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginApi, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "org.expresslrs.androidupdater";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Plugin(#[from] tauri::plugin::mobile::PluginInvokeError),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub permission_required: bool,
    pub installer_launched: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallPayload<'a> {
    path: &'a str,
}

pub struct AndroidUpdater<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AndroidUpdater<R> {
    pub fn install(&self, path: &str) -> Result<InstallResult> {
        self.0
            .run_mobile_plugin("install", InstallPayload { path })
            .map_err(Into::into)
    }
}

pub trait AndroidUpdaterExt<R: Runtime> {
    fn android_updater(&self) -> &AndroidUpdater<R>;
}

impl<R: Runtime, T: Manager<R>> AndroidUpdaterExt<R> for T {
    fn android_updater(&self) -> &AndroidUpdater<R> {
        self.state::<AndroidUpdater<R>>().inner()
    }
}

fn init_mobile<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<AndroidUpdater<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "AndroidUpdaterPlugin")?;
    Ok(AndroidUpdater(handle))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-updater")
        .setup(|app, api| {
            let updater = init_mobile(app, api)?;
            app.manage(updater);
            Ok(())
        })
        .build()
}
