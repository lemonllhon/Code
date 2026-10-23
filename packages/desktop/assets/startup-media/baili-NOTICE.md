# 运行包素材与许可证

本运行包的原创脚本和文档采用随附的 MIT `LICENSE`。媒体和第三方组件不因此被重新授权为 MIT。

发布者确认相关音乐和白璃参考形象已获允许公开分发、改编分享的授权，并允许音乐随公开版供使用者使用。该确认并非对全部独立转载、商业用途或再授权场景的权属审查；这些用途需确认对应授权范围，其他权利仍属于原权利人。

音乐文件标注为 **SINN3R — Awakening — 栾慧**，本包仅含采用的约 16 秒处理片段：`assets/startup-audio.m4a` 与 `startup.mp4` 内音轨，不含完整原曲。人物图像与影片依据用户提供的白龙娘参考生成和合成，不含原始参考或私人制作记录。

`vendor/mediabunny-1.61.0.mjs` 来自 [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny)，用于独立编辑/导出；采用 MPL-2.0。保留 `vendor/Mediabunny-LICENSE.txt`、`vendor/NOTICE.md` 和对应源码包 `vendor/mediabunny-1.61.0-source.tgz`。

OpenAI / Codex 名称属于各自权利人。本项目非官方，不分发官方客户端、账号或凭据。完整项目声明：[chenyi380/baili-codex](https://github.com/chenyi380/baili-codex/blob/main/ASSET-NOTICE.md)。

## LCode 版本修改（2026-10-17）

本仓库的 `baili.mp4` 从原始 Canvas 动画工程重新导出，将主标题 `Codex` 改为 `LCode`，左上角 `OPENAI / CODEX` 改为 `OPENAI / LCode`。保留原图、动画、配乐、3840×2160 / 60 fps / 16 秒规格及原有权利声明；无文字壁纸未修改。修改不表示 OpenAI 对 LCode 的认可或关联。

## 轻量播放版本（2026-10-23）

`baili-lite.mp4` 从上述 LCode 母版生成，分辨率 1920×1080、30 fps、16 秒，直接复制原音轨。保留人物、品牌、字幕和相同交接节点，降低普通窗口和受限设备的解码开销；母版与无文字壁纸不变。

`baili-fill.jpg` 从同母版第 14 秒生成 480×270 的模糊、暗化及降低饱和度的静态图，用于完整视频周围的柔和填充，不改变视频正文或配乐。
