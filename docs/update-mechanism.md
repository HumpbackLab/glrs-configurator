# GLRS 更新机制

本文说明 GLRS Configurator 当前的更新机制，包括：

1. GLRS Configurator 应用自身更新。
2. LightFin Nano 接收机固件检查与下载。

两类更新共用 GitHub/Gitee 更新源选择，但发布文件、版本判断和下载流程彼此独立。

## 1. 更新源选择

更新页面允许用户选择：

- Gitee：中文界面默认选项，适合国内网络。
- GitHub：英文界面默认选项。

用户选择保存在浏览器本地存储中，应用重启后继续使用上次选择。配置器应用更新和接收机固件更新共用这个选择。

## 2. Configurator 应用更新

### 2.1 发布流程

`glrs-configurator/.github/workflows/release.yml` 在 GitHub Release 发布时执行：

1. 检出 Release 标签。
2. 构建 Windows NSIS 和 Linux DEB 安装包。
3. 使用 Tauri updater 私钥签名更新包。
4. 将安装包、签名和 `latest.json` 上传到 GitHub Release。

Release 标签必须使用应用构建流程支持的版本格式，例如：

```text
v0.1.0
```

GitHub Actions 需要配置：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

### 2.2 检查与安装

桌面端通过 Tauri updater 完成应用更新：

1. 根据当前更新源读取 `latest.json`。
2. 比较当前 Configurator 版本和远端版本。
3. 发现更新后下载并验证签名。
4. 安装更新并重新启动应用。

当前检查地址定义在 `app/src-tauri/src/lib.rs` 的 `app_updates` 模块中。

应用自动更新仅在桌面 Tauri 环境可用，浏览器开发模式不支持。

## 3. LightFin Nano 固件发布

### 3.1 GitHub 发布仓库

固件发布仓库为：

```text
https://github.com/HumpbackLab/Gyro-ELRS
```

`.github/workflows/release-lightfin-nano.yml` 在 GitHub Release 发布时执行：

1. 检出 Gyro-ELRS Release 标签。
2. 检出 `HumpbackLab/GYRO-ELRS-Targets` 硬件库。
3. 编译 `Unified_ESP32C3_2400_RX_via_WIFI`。
4. 临时设置以下 Unified 硬件配置：

   ```text
   board_config = jumper.rx_2400.lightfin-nano
   ```

5. 使用 `Generic C3 2400 LightFin Nano.json` 生成已配置固件。
6. 计算固件文件大小和 SHA-256。
7. 生成 `firmware-latest.json`。
8. 将固件和 manifest 上传到 GitHub Release。

固件按照以下格式命名：

```text
<product_name>_<release_tag>.bin
```

例如：

```text
LightFin Nano 2.4GHz RX_v0.9.0_e364.bin
```

固件版本直接使用 GitHub Release 标签。当前机制支持包含下划线的标签，例如 `v0.9.0_e364`。

### 3.2 固件 manifest

manifest 使用数组结构，以便以后增加其他产品。当前只有一个 LightFin Nano 条目：

```json
{
  "schema": 1,
  "version": "v0.9.0_e364",
  "published_at": "2026-07-15T10:00:00Z",
  "firmwares": [
    {
      "product_name": "LightFin Nano 2.4GHz RX",
      "target": "Unified_ESP32C3_2400_RX",
      "filename": "LightFin Nano 2.4GHz RX_v0.9.0_e364.bin",
      "size": 1234567,
      "sha256": "固件文件的 SHA-256",
      "sources": {
        "github": "GitHub Release 固件下载地址",
        "gitee": "Gitee 固件下载地址"
      }
    }
  ]
}
```

配置器只接受 `schema: 1`，并限制固件最大为 8 MiB。

## 4. Gitee 固件源

Gitee 固件仓库为：

```text
https://gitee.com/ncer/Gyro-ELRS
```

默认分支为：

```text
elrs_fc
```

固定文件路径为：

```text
updater/firmware-latest.json
updater/firmware/firmware-latest.bin
```

配置器读取地址为：

```text
https://raw.giteeusercontent.com/ncer/Gyro-ELRS/raw/elrs_fc/updater/firmware-latest.json
https://raw.giteeusercontent.com/ncer/Gyro-ELRS/raw/elrs_fc/updater/firmware/firmware-latest.bin
```

当前 GitHub Action 不自动同步 Gitee。每次发布后需要手动执行：

1. 从 GitHub Release 下载 `firmware-latest.json`。
2. 将 manifest 放到 `updater/firmware-latest.json`。
3. 下载对应版本固件。
4. 将固件重命名为 `firmware-latest.bin`。
5. 将固件放到 `updater/firmware/firmware-latest.bin`。
6. 提交并推送到 Gitee 的 `elrs_fc` 分支。

应先更新固件文件，再更新 manifest，避免用户读取到新 manifest 时对应固件尚未上传。

## 5. Configurator 固件检查

固件更新后端位于 `app/src-tauri/src/lib.rs` 的 `firmware_updates` 模块。

### 5.1 已连接设备

连接接收机后，配置器通过 `/target` 获取：

```json
{
  "product_name": "LightFin Nano 2.4GHz RX",
  "target": "Unified_ESP32C3_2400_RX",
  "version": "v0.9.0_e364 (abcdef)"
}
```

配置器使用以下字段选择 manifest 条目：

```text
product_name + target
```

只有两个字段都相同，才认为固件与设备匹配。

设备版本取 `version` 中第一个空格之前的内容。例如：

```text
v0.9.0_e364 (abcdef) -> v0.9.0_e364
```

当前版本判断采用字符串相等比较：

- 设备版本等于 manifest 版本：已经是最新版本。
- 两者不相等：提示存在可用发布版。

当前不会判断两个不同版本谁新谁旧，因此应保证 GitHub Latest Release 和 Gitee manifest 始终指向实际最新固件。

### 5.2 未连接设备

连接接收机 AP 后，电脑可能无法继续访问互联网。为解决这个问题，配置器支持两阶段流程：

1. 电脑仍然联网时，在未连接设备的情况下检查更新。
2. 因当前 manifest 只有一个固件，配置器可直接选择 LightFin Nano 条目。
3. 下载并校验固件到系统 Downloads 目录。
4. 再连接接收机 WiFi。
5. 配置器读取设备版本并与已经取得的 manifest 版本比较。
6. 使用现有手动上传表单选择已下载固件并刷写。

如果以后 manifest 中包含多个固件，而设备尚未连接，配置器不会猜测产品，会要求先连接接收机。

## 6. 固件下载与校验

用户点击“下载最新固件”后，Rust 后端执行：

1. 使用当前选择的 GitHub/Gitee URL 下载固件。
2. 检查 URL 是否属于对应的预设仓库路径。
3. 限制下载大小不超过 8 MiB。
4. 下载到临时 `.part` 文件。
5. 检查实际文件大小是否等于 manifest 的 `size`。
6. 计算并比较 SHA-256。
7. 校验通过后移动到系统 Downloads 目录。

如果 Downloads 中已经存在同名文件，新文件会自动增加数字后缀，不覆盖原文件。例如：

```text
LightFin Nano 2.4GHz RX_v0.9.0_e364 (1).bin
```

大小或 SHA-256 校验失败时，临时文件会被删除，不会提供给用户刷写。

## 7. 固件刷写

在线更新当前只负责检查和下载，不会自动刷写设备。

刷写继续使用更新页面原有流程：

1. 在固件文件输入框中选择下载的 `.bin`。
2. 配置器通过设备 `/update` 接口上传。
3. 显示上传、处理和重启进度。
4. 如果设备返回 target mismatch，用户可以选择强制刷写或取消。

这种设计保证下载固件和连接设备不需要同时具备互联网连接。

## 8. 当前限制

- 仅支持桌面 Tauri 环境中的在线固件下载。
- 浏览器开发模式不支持在线固件下载。
- 固件下载状态不会跨 Configurator 重启保存，但已下载文件仍保留在 Downloads。
- 固件版本仅做字符串相等比较，不做语义版本新旧排序。
- Gitee 固件目前需要手动同步。
- 当前没有固件数字签名，完整性依赖 HTTPS、文件大小和 SHA-256。
- 当前只发布 LightFin Nano 固件；manifest 数组结构已经为后续产品保留扩展位置。

## 9. 发布检查清单

发布新固件时：

1. 创建并发布正式 GitHub Release。
2. 等待 `release-lightfin-nano.yml` 成功完成。
3. 确认 GitHub Release 中存在版本固件和 `firmware-latest.json`。
4. 打开 GitHub manifest，确认版本、文件名、大小和 SHA-256 正确。
5. 将固件和 manifest 手动同步到 Gitee 固定路径。
6. 分别访问 GitHub/Gitee manifest 地址确认可下载。
7. 使用 Configurator 从两个源各执行一次检查与下载测试。
8. 连接 LightFin Nano，确认版本比较和手动刷写正常。
