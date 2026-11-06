# 调研笔记

写于 2026-11-06/07。数据为实测，会过期。

## 同类项目（GitHub，2026-11-06 实测）

| 项目 | 星 | 语言 / 许可 | 做到哪 | 倾听 |
|---|---|---|---|---|
| [moeru-ai/airi](https://github.com/moeru-ai/airi) | 51.2k | TS / MIT | 实时语音 + Live2D/VRM，Web/macOS/Win | 无 |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 14.6k | Py / MIT | 本地跨平台、语音打断、Live2D | 无 |
| [lipku/LiveTalking](https://github.com/lipku/LiveTalking) | 10.3k | Py / Apache-2.0 | 流式数字人（wav2lip/ernerf/musetalk） | 无 |
| [OpenBMB/MiniCPM-o](https://github.com/OpenBMB/MiniCPM-o) | 27k | Py / Apache-2.0 | 端到端看/听/说 | 部分 |
| [kyutai-labs/moshi](https://github.com/kyutai-labs/moshi) | 11.4k | Py / Apache-2.0 | 全双工语音基座 | 部分 |
| [elevenyellow/handcrafted-persona-engine](https://github.com/elevenyellow/handcrafted-persona-engine) | 1.4k | C# | Live2D + LLM + ASR + TTS + RVC | 无 |
| [Kedreamix/Linly-Talker-Stream](https://github.com/Kedreamix/Linly-Talker-Stream) | 153 | Py / Apache-2.0 | WebRTC 实时流式数字人 | 无 |

对 airi 的 README 做关键词计数：listening / listen / backchannel / nod / interrupt / barge / turn —— 全部 0 命中。

**结论：这一格是空的。**

## 可直接复用的零件

| 用途 | 项目 | 许可 | 说明 |
|---|---|---|---|
| 倾听 / 轮次判断 | [MaAI-Kyoto/MaAI](https://github.com/MaAI-Kyoto/MaAI) | MIT | 实时非语言行为生成：turn-taking、backchannel、head nodding，支持中英日。PyPI 包名 `maai` |
| 3D 渲染 + 动作 | [sola1039/HAST-SEC](https://github.com/sola1039/HAST-SEC) | 自制非商业许可 | three-vrm，三态机 + 表情投影写得很干净；**代码可读不可抄**（商用需授权） |
| 3D 渲染基础 | [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | MIT | VRM 加载 + 表情 + 口型 |
| 2D 渲染 | Live2D Cubism SDK | 专有（有免费额度） | 也可走 [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) |
| 语音克隆 | GPT-SoVITS / Bert-VITS2 | MIT / 各自 | 几十秒素材可克隆 |
| 全双工语音 | kyutai moshi | Apache-2.0 | 端到端，但不可控、难改人格 |

## 素材来源分档

做角色时按可信度分三档，混用会得到「大家以为的他」，不是「你的他」。

**第一档 · 官方口径**：官方 B站/微博 PV、角色曲、生日与节日语音、游戏内剧情文本与语音、官方设定集。这一档定骨架。

**第二档 · 玩家整理**：Wiki、贴吧、豆瓣小组、NGA 角色楼。可信但需核对，用来补细节，关键设定回第一档核。

**第三档 · 同人**：同人文、同人视频。别人的理解，只能当参考。

## 3D 素材现状

- **官方 MMD 模型免费，但只有 Q 版。** 官网路径：顶部导航【视听中心】→【MMD模型下载】→【前往下载】。二头身，不是游戏内正比形象。
- **正比模型基本来自游戏内提取**，非官方发布。
- **免费通用 VRM**：[VRoid Hub](https://hub.vroid.com) 上的 CC0 模型、[OpenGameArt 的 VRoid CC0 合集](https://opengameart.org/content/vroid-studio-cc0-models)。干净、合法，可以拿来跑通链路。
- **格式转换**：官方给 pmx，three-vrm 要 vrm。路线是 Blender + [MMD Tools](https://extensions.blender.org/add-ons/mmd-tools/) 导入 pmx → [VRM Add-on for Blender](https://extensions.blender.org/add-ons/vrm/) 导出 vrm。卡点通常是 VRM 要求的手指骨骼与眼睛骨骼，Q 版模型往往没有。

**结论：先拿 CC0 的 VRM 跑通 3D 后端，自己的角色模型以后再用 Blender 做。**

## 版权口径

多数二次元游戏的官方二次创作指南里都有一条例外：**仅以个人欣赏为目的使用、且不向第三方提供（包括发布到 SNS）**时，可以直接使用官方素材。

也就是说，自用通常是被官方允许的，不是「没人管」。分发、商用、做成服务是另一回事。

条款会改。逐条引用前请回该作品官方站点的 UGC 政策核对；部分厂商对 MMD 素材另有专门指南，那份常常单独成页、容易漏看。