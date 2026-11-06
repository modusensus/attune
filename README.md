# attune · 同频

> 开源的 AI 角色都在学怎么说话。这个项目学怎么听。

attune 是一个可替换角色的实时语音对话引擎。角色是一份配置，不是一段代码；引擎里没有角色。

当前状态：**M1 文本闭环已可运行**。有人设卡、有记忆、有流式输出、有可替换的模型端点；没有语音，没有画面。

## 跑起来

需要 Node 24 以上，不需要 \`npm install\`（零依赖）。

\`\`\`bash
git clone https://github.com/modusensus/attune
cd attune
node src/cli.ts --character examples/example-character
\`\`\`

默认是离线模式：对话循环、记忆、流式输出全都真跑，但回复是明显的占位文字——因为还没有接模型。接上任意 OpenAI 兼容端点（llama.cpp、LM Studio、Ollama、vLLM 都行）：

\`\`\`bash
export ATTUNE_BASE_URL=http://127.0.0.1:1234/v1
export ATTUNE_MODEL=your-model-id
node src/cli.ts --character examples/example-character
\`\`\`

\`ATTUNE_API_KEY\` 可选。三个变量中前两个齐备才走 HTTP，否则回落离线。

\`\`\`bash
npm test          # 37 项单元测试
npm run accept    # 十轮人设一致性验收
\`\`\`

## 一个角色长什么样

\`\`\`
characters/<name>/
├── character.toml   引擎读的配置
└── persona.md       人设卡，直接写给模型看
\`\`\`

\`\`\`toml
[identity]
name = "小满"
persona = "persona.md"
memory_namespace = "xiaoman"

[voice]
engine = "none"        # M2 才用
model = "none"

[renderer]
type = "none"          # M4 才用
model = "none"

[mapping]
backchannel_nod = 0.6  # 倾听层信号 → 渲染参数，M3 才用
\`\`\`

换目录就换人。引擎代码里不会出现任何角色名。

## 现在到哪一步

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 架构与调研 | 完成 |
| M1 | 文本闭环：人设卡 + LLM + 记忆 | 完成 |
| M2 | 语音闭环：ASR + TTS + 口型 | 未开始 |
| M3 | 倾听层：MaAI 接入 + 三态机 + 参数映射 | 未开始 |
| M4 | 3D：VRM 后端 | 未开始 |

M1 的出口标准是「能连续对话 10 轮不掉人设」。机械那一半由 \`npm run accept\` 检查（无漂移词、无原样复述、无重复、长度可朗读），另一半靠人读 transcript——脚本不会替你宣布人设还在。

## 为什么做这个

2026 年 4 月，Anuttacon 发布了 LPM（Large Performance Model）论文，核心主张是「会说话不等于像人，人味藏在倾听里」，并提出表演三难困境：表现力 / 实时性 / 长期身份一致，三者难兼得。

开源侧的现状是：airi、Open-LLM-VTuber、LiveTalking、handcrafted-persona-engine 这些项目全都在优化**说话**——TTS 质量、口型、打断。没有一个项目把**倾听**当成主功能。

而零件其实已经有了。MaAI 是一个 MIT 许可的实时非语言行为生成器，能输出 turn-taking 与 backchannel 概率，支持中英日。只是没有任何渲染引擎把它接进去。

attune 就做这一格。

## 看什么

- [架构草案](docs/ARCHITECTURE.md) — 五环链路、三态机、角色配置格式、延迟预算
- [调研笔记](docs/RESEARCH.md) — 同类项目实测、可复用的零件、素材来源分档

## 不做什么

- **不训练模型。** 全部用现成开源件。
- **仓库里不放任何游戏角色素材。** 零 IP，一个立绘都不带。
- **不做商用、不做托管服务。** 许可为 MIT，但定位是非商业研究与自用。

## 许可

MIT，见 [LICENSE](LICENSE)。
