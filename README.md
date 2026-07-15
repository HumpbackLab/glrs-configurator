# Gyro ELRS Configurator

ELRS 飞控接收机配置工具。基于 Tauri v2 构建，支持 Windows、Linux 和 Android 平台。

本工具通过 HTTP API 对 ELRS 接收机进行配置，并通过 MSP v2 over TCP 协议实现实时调试数据轮询与 3D 姿态可视化。

## 功能

- **设备配置** — 运行时选项、模型/接收机参数、PWM 输出映射、飞控 PID / 混控器 / 板载方向
- **实时状态** — 主循环性能、PWM ISR 概况、传感器检测、VBAT 电压
- **MSP 调试** — 通过 TCP (端口 5761) 轮询姿态数据，支持 3D 飞机模型实时渲染
- **WiFi 管理** — 家庭网络扫描与连接、AP/STA 模式切换
- **固件更新** — 支持 LightFin Nano 在线版本检查与下载、OTA 固件上传与强制更新

应用与固件的发布、检查、下载和镜像机制详见 [GLRS 更新机制](docs/update-mechanism.md)。

## 快速开始

### 环境要求

- Node.js 18+
- Rust 工具链 (stable)
- Tauri v2 系统依赖 ([参考官方文档](https://v2.tauri.app/start/prerequisites/))

### 安装与运行

```bash
cd app
npm install
npm run tauri dev      # Tauri 开发模式 (前端 + Rust 后端)
```

单独运行前端 (浏览器开发):

```bash
npm run dev            # Vite 开发服务器, localhost:5200
```

浏览器模式下 HTTP 请求通过 Vite 代理转发至设备 IP (通过 `?target=` 查询参数指定)，绕过 CORS 限制。

### 构建

```bash
npm run tauri build    # 生产构建
```

构建产物位于 `app/src-tauri/target/release/bundle/`。

### 发布与应用自动更新

发布 GitHub Release 后，`.github/workflows/release.yml` 会从 Release 标签构建对应版本，上传 Windows NSIS、Linux DEB、更新签名和 `latest.json`。Release 标签必须使用 `vX.Y.Z` 或 `X.Y.Z` 格式。

自动更新包使用 Tauri 签名密钥验证。发布前需要在 GitHub 仓库 Actions secrets 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri updater 私钥的完整内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；无密码密钥可留空

私钥不得提交到仓库，且必须安全备份；丢失私钥后，已安装的应用将无法升级到使用新密钥签名的版本。

配置器的更新页面允许选择 Gitee 或 GitHub 更新源。首次运行时，中文界面默认使用 Gitee，英文界面默认使用 GitHub；用户手动选择后会记住该设置。

#### 同步 GitHub Release 到 Gitee

`scripts/sync-github-release-to-gitee.sh` 可将指定 GitHub Release 的说明和全部附件同步到 Gitee。脚本依赖 `curl`、`jq` 和 `base64`，同名附件会被替换；`latest.json` 内的安装包地址会自动改写为 Gitee 下载地址。

```bash
export GITEE_TOKEN="你的 Gitee 私人令牌"
./scripts/sync-github-release-to-gitee.sh \
  HumpbackLab/glrs-configurator \
  your-gitee-owner/glrs-configurator \
  v0.1.0
```

如需为 Tauri 提供不随 tag 改变的更新地址，可同时将改写后的 `latest.json` 发布到 Gitee 仓库固定路径：

```bash
export GITEE_MANIFEST_BRANCH=master
export GITEE_MANIFEST_PATH=updater/latest.json
./scripts/sync-github-release-to-gitee.sh \
  HumpbackLab/glrs-configurator \
  your-gitee-owner/glrs-configurator \
  latest
```

此时稳定地址为 `https://raw.giteeusercontent.com/your-gitee-owner/glrs-configurator/raw/master/updater/latest.json`。目标仓库必须是公开仓库，桌面客户端才能在不携带令牌的情况下检查和下载更新。

## 连接到设备

1. 将电脑/手机连接到 ELRS 接收机的 WiFi 热点 (默认 IP: `10.0.0.1`)
2. 在应用顶部输入框中输入设备 IP 地址，点击 **Connect**
3. 连接成功后，各配置面板将自动加载设备数据

> **Android 注意**: 连接设备 AP 时，系统可能提示"该网络无法访问互联网"。请选择保持连接。

## 配置面板说明

| 面板 | 功能 |
|------|------|
| **Status** | 设备信息、接收机状态、传感器、主循环/PWM ISR 性能 |
| **Runtime** | WiFi 自动开启间隔、UART 波特率、首次连接锁定、AirPort 模式 |
| **Model** | 绑定存储方式、绑定短语 → UID 生成、Model Match、串口协议、SBUS 故障保护 |
| **PWM** | 每个输出引脚的模式、输入通道、反相、脉冲宽度、故障保护配置 |
| **Flight** | 速率/角度 PID、CH5 电机解锁、混控器矩阵、板载方向 (欧拉角 + 3D 预览) |
| **Debug** | MSP 调试轮询 (需 Tauri 环境)、姿态数据、3D 飞机姿态实时渲染 |
| **Hardware JSON** | 硬件定义 JSON 编辑器 |
| **WiFi** | 家庭网络扫描、连接、AP/STA 模式切换 |
| **Update** | 固件 OTA 上传、当前固件下载 |

## 技术架构

```
app/
├── index.html                 # 单页入口
├── vite.config.js             # Vite 配置 + ELRS HTTP 代理中间件
├── src/
│   ├── main.js                # 前端主程序 (原生 JS SPA)
│   └── styles.css             # 全部样式
├── public/
│   └── models/                # GLTF 3D 模型
└── src-tauri/
    ├── src/
    │   ├── main.rs            # Tauri 入口
    │   └── lib.rs             # Rust 后端: MSP v2 TCP 客户端
    ├── Cargo.toml
    └── tauri.conf.json        # 窗口配置、CSP、打包设置
```

- **前端** — 原生 JavaScript，无框架。单一 `state` 对象驱动，`render()` 全量替换 DOM。
- **后端 (Rust)** — 三个 Tauri 命令: `msp_debug_connect` / `msp_debug_disconnect` / `msp_debug_poll`。MSP v2 帧编解码 + CRC8-DVB-S2 校验。
- **3D 渲染** — Three.js，程序化备用模型 + GLTF 加载。
- **代理** — Vite 中间件 `/__elrs_proxy__/` 将浏览器请求转发至设备 HTTP API。

## 设备 HTTP API

ELRS 接收机提供以下 HTTP 接口 (JSON 格式):

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/target` | 设备信息 |
| GET/POST | `/config` | 配置读写 |
| GET/POST | `/options.json` | 运行时选项 |
| GET/POST | `/hardware.json` | 硬件定义 |
| GET | `/status.json` | 运行时状态 |
| GET/POST | `/channels` | RC 通道模拟 (WiFi 模式) |
| POST | `/reboot` | 重启设备 |
| POST | `/reset` | 重置模型/硬件设置 |
| POST | `/update` | 固件上传 |
| GET | `/networks.json` | WiFi 扫描结果 |
| POST | `/sethome` | 保存家庭 WiFi 凭据 |

## 项目状态

当前处于早期开发阶段 (Milestone 1)。详情参见 `task-breakdown.md` 和 `docs/phase-0-baseline.md`。

## 许可证

与 ExpressLRS 项目保持一致。
