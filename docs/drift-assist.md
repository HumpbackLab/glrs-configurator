# 漂移辅助 / Drift assistance

新版接收机固件在 `/config` 提供 `fc_drift` 时，“飞控”页面会显示可折叠的漂移辅助设置，新手和专家模式均可使用。旧固件显示不支持，也不会收到新增参数。

未连接时也显示开关与参数，使用默认值或当前已载入的配置供预览调节；连接后读取接收机的实际参数，保存须在连接后执行。只有连接成功并确认配置缺少 `fc_drift` 时才显示“不支持”提示。

- 已解锁时，CH3 油门降至 0%（988μs）后可保存，无需关闭解锁开关或 CH7 共存开关，需要配套新版接收机固件。未解锁时也可保存。无法到达该油门值时，断开遥控链路、进入仅 Wi-Fi 模式后保存。默认由 CH8 高位控制介入；接收机必须处于 RATE 角速度模式。
- 油门 CH3 和转向 CH4 必须使用车辆混控：正系数纯油门电机输出、纯偏航舵机输出。相应 PWM 输出须选择混控来源。
- 可调介入偏差、渐进区间、最大减油比例、介入和恢复时间常数。恢复默认只更新表单，保存后才写入接收机。
- “漂移辅助开关”独立提供启用、控制通道和生效区间，与 Wi-Fi 共存使用相同区间控件，新手／专业模式都能设置。默认关闭、CH8、1700–2100μs，不允许与已启用的解锁／Wi-Fi 通道冲突。漂移区间保留 1μs 精度，原有模式和 Wi-Fi 区间继续使用 25μs 步进。
- 开关采用与“射频 + WiFi 共存”一致的普通卡片。专业模式中直接位于共存卡片下方，参数区紧随其后；新手模式中位于安装方向设置之后。
- 新手和专家模式的辅助参数默认都显示 1–10 档感度，风格与 PID 感度一致，默认 5 档。手动调整感度时，最大减油比例为档位 × 3%（3–30%）；响应参数保持原值。不拖动滑条时也会保留详细配置的精确减油比例。专家模式可勾选“使用详细参数配置”，显示全部参数及调节说明；切换显示方式保留当前表单参数，不自动套用感度值。恢复默认会同时重置独立开关及隐藏参数。
- 状态区显示目标／实测偏航角速度、手动／辅助油门、减油比例及未生效原因；数据通过现有连接检查定时器刷新，用于观察趋势。
- Profile 导出、导入及社区配置沿用同一格式，新增 `flight.drift`。旧 Profile 默认关闭辅助。

This is an experimental yaw-rate-based throttle reduction aid for forward-only cars. It never adds throttle above the manual request and does not estimate tire slip or vehicle sideslip angle. Defaults must be validated on the actual vehicle.

The configurator writes settings to the receiver over its existing HTTP API; it does not depend on LetsFly. The receiver continues to run assistance without an open configurator. New fields are omitted when saving to firmware that does not expose `fc_drift`.

## Checks

```sh
cd app
node --test src/drift.test.js
npm run build
```

Browser checks with a mocked receiver cover beginner-mode saving, expert-mode channel conflict validation, resetting parameters, the card at phone width, and old-firmware behavior. Rust `cargo check --offline` and the Windows NSIS build were also run. The local test installer is built without updater signature artifacts; production release signing configuration remains unchanged.

2026-10-14 review: the independent switch was checked in both modes, including enable/disable, CH8 defaults, 1us range preservation, save/readback, reset, ARM/Wi-Fi channel conflicts and old-firmware compatibility. Original mode/Wi-Fi range controls retain their 25us step. Beginner validation errors now use the existing error-message handler. Five configurator tests and 56 receiver Native regression cases passed (CRSF, drift, FHSS, FIFO, mapping, MSP bridging/VTX, stubborn transfer and telemetry). Previously documented failing MSP/CRC/OTA suites and the empty crash-detection directory were excluded; this is not a full Native suite pass. Physical radio coexistence and vehicle behavior still require device testing.

2026-10-15 PR review: five configurator unit tests, Rust offline checking and the Windows NSIS build passed. Browser checks repeated the switch/layout, original mode/Wi-Fi controls, offline preview and old-firmware scenarios. Profile export/import preserved the full drift configuration and exact values; a profile with an arm-channel conflict was rejected without a write. No phone-app changes are required to use these receiver/configurator features.
