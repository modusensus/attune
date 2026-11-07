# attune · 同频

> 开源的 AI 角色都在学怎么说话。这个项目学怎么听。

attune 是一个可替换角色的实时语音对话引擎。角色是一份配置，不是一段代码；引擎里没有角色。

当前状态：**M2 语音闭环已可运行**。有人设卡、有记忆、有流式输出、有可替换的模型端点；有 TTS，有口型曲线。没有麦克风输入，没有画面。

## 跑起来

需要 Node 24 以上，不需要 `npm install`（零依赖）。

```bash
git clone https://github.com/modusensus/attune
cd attune
node src/cli.ts --character examples/example-character
```

默认是离线模式：对话循环、记忆、流式输出全都真跑，但回复是明显的占位文字——因为还没有接模型。接上任意 OpenAI 兼容端点（llama.cpp、LM Studio、Ollama、vLLM 都行）：

```bash
export ATTUNE_BASE_URL=http://127.0.0.1:1234/v1
export ATTUNE_MODEL=your-model-id
node src/cli.ts --character examples/example-character
```

`ATTUNE_API_KEY` 可选。三个变量中前两个齐备才走 HTTP，否则回落离线。

```bash
npm test          # 75 项测试（74 通过，1 项在非 Windows 上跳过）
npm run accept examples/example-character   # 十轮人设一致性验收，带语音
npm run voice     # 跑一轮并把 wav、口型曲线、元数据写到 ./out/voice-demo
```

## 听见声音

默认不出声，为的是别人 clone 下来不配任何东西也能跑通。要出声，改 `character.toml`：

```toml
[voice]
engine = "sapi"                        # Windows 自带语音，不用下载
model  = "Microsoft Huihui Desktop"    # 留 "none" 则自动挑第一个中文语音
```

或者任意 OpenAI 兼容的 `/audio/speech`：

```toml
[voice]
engine = "http"
model  = "tts-1"
```

```bash
export ATTUNE_TTS_BASE_URL=http://127.0.0.1:8880/v1
export ATTUNE_TTS_MODEL=tts-1
export ATTUNE_TTS_API_KEY=...          # 可选
```

引擎名写错不会静默回退——`unknown voice engine: gpt-sovits` 当场报错，因为配置笔误比没声音更难查。

## 口型不靠模型

`src/audio/envelope.ts` 把 wav 的 PCM 波形算成 RMS 包络，按 60fps 输出 `{at, open}` 关键帧：`open` 是 0 到 1 的张口度，静音段精确归零（指数衰减永远逼近 0 却不等于 0，而渲染器用「是不是正好 0」判断闭嘴，所以留了个死区把尾巴掐掉）。

整条链路没有神经网络，也不需要。口型对不对是能量问题，不是语义问题。

```bash
node scripts/voice-demo.ts --character examples/example-character --out ./out/voice-demo
```

留下三样东西：`reply.wav`（听）、`mouth.json`（看曲线）、`turn.json`（音频参数与曲线统计）。**返回 exit 0 不等于有 wav 出来**，所以产物必须落盘。

## 括号里的动作不念出来

写给文字聊天用的人设卡，满篇都是 `（笑）`、`*sighs*`、`【叹气】` 这类舞台提示。语音引擎会把它们逐字念出来——"左括号 笑 右括号 你还知道回来"。

`src/audio/script.ts` 在合成前把成对的括号内容剔掉（中英全半角、方头括号、星号动作都算），transcript 里原样保留。整条回复只有动作时，引擎发一个 `silent-turn` 事件而不是合成一段没人要的静音——渲染器知道这次是耸肩，不是说话。

这条对所有角色生效，不在卡里写死，因为括号不是某个角色特有的写法。

## 倾听是判断，不是检测

VAD 能回答「有没有人在出声」。它回答不了「这个停顿是句号还是换气」——而这正是「一个会等你说完的机器」和「一个在听你说话的人」之间的全部区别。

\`src/listen/\` 用两个信号把这件事做出来，不需要模型：

- **音高走向。** 一句话收尾时基频下沉，没说完的分句末尾会上扬或持平。取有声段最后三分之一与前三分之一的基频中位数比，跌过 12% 算句号。停顿时长一样，走向不同，结论就不同。
- **出声段长度。** 别人说话时一段 120–350ms 的短促出声是「嗯」是点头，不是抢话；超过这个长度才算回合企图。

两者合成四种判断：\`backchannel\`（附和）、\`hold\`（停顿但我还在）、\`turn_take\`（交回合了）、\`idle\`（这一段根本没人说话）。

判据分三层，一层比一层苛刻：

1. **交回合要等。** 降调收尾后 700ms 静音才接话；音高没下沉的停顿要等到 1400ms。早接话是不可挽回的失礼，晚接话只是慢一点。
2. **反应要有预算。** 早期版本 94 秒里反应了 236 次，平均 0.4 秒一次——那不是专注，那是屏保。现在有全局下限（任意两类反应间隔 ≥1.5s）加上按类型的下限（hold ≥4s、backchannel ≥2.5s），实测降到 78 次。\`turn_take\` 完全豁免：因为刚抬过眉毛就不交回合，用户会对着墙说话。
3. **三态各自该做什么。** \`listening\` 才产出手势；\`thinking\` 期间麦克风整个忽略（那时的任何反应都叠在自己的思考上）；\`speaking\` 只认打断，不产手势——角色不对自己点头。

手势是形状不是数字。一个 gesture 是 \`{channel, at, peak, riseMs, holdMs, fallMs}\`，同一通道重叠时取最大值而不是相加：两次点头还是一条脖子，加起来 1.8 会顶穿 rig 的上限。

\`\`\`bash
npm run listen
\`\`\`

三条机械验收，产物在 \`out/listen-accept/\`：90 秒独白期间至少有 4 次反应且没有一次发生在说话结束之后；0.8 秒的中途停顿不被当成交还；打断在 200ms 内被检测到。当前实测 78 次反应（20 次 hold、19 次点头、20 次抬眉、19 次偏头），打断延迟 20ms。

**这三条是必要不充分。** 脚本能证明它没有在错误的时刻动，不能证明像不像在听——那个得你自己坐着对它说一会儿话。

## 一个角色长什么样

```
characters/<name>/
├── character.toml   引擎读的配置
└── persona.md       人设卡，直接写给模型看
```

```toml
[identity]
name = "小满"
persona = "persona.md"
memory_namespace = "xiaoman"

[voice]
engine = "none"        # 见上文「听见声音」
model = "none"

[renderer]
type = "none"          # M4 才用
model = "none"

[mapping]
backchannel_nod = 0.6   # 附和的点头幅度，0..1；0 表示关了
backchannel_tilt = 0.25  # 同时偏一点头
hold_brow = 0.3          # 停顿时的抬眉
hold_gaze = 0.4          # 停顿时的视线偏移
turn_take_blink = true   # 接话时眨一下眼
turn_take_brow = 0.5     # 接话时的抬眉
```

映射键写错会当场报 `unknown mapping key: backchannel_nodd`，不会静默忽略——一个看起来没反应的角色，配上一个看起来没问题的配置，是最难查的一种坏。写法合法的 0 是「这个动作关掉」，不是错误。

换目录就换人。引擎代码里不会出现任何角色名。

## 现在到哪一步

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 架构与调研 | 完成 |
| M1 | 文本闭环：人设卡 + LLM + 记忆 | 完成 |
| M2 | 语音闭环：TTS + 口型 | 完成（ASR 未接） |
| M3 | 倾听层：音频帧 + 判断 + 三态机 + 参数映射 | 完成（MaAI 未接） |
| M4 | 3D：VRM 后端 | 未开始 |

M1 的出口标准是「能连续对话 10 轮不掉人设」。机械那一半由 `npm run accept` 检查（无漂移词、无原样复述、无重复、长度可朗读），另一半靠人读 transcript——脚本不会替你宣布人设还在。

M2 的出口标准是「能说话，有口型」。`npm run accept` 一并检查：每轮真的合成了音频、音频不是空的、口型曲线存在且峰值大于 0.1（静音引擎豁免，它本来就该全闭）。脚本仍然只报机械部分，最后一行写着「听一遍，曲线跟得上字吗」。

**ASR 还没接。** 本机没有可用的离线识别件，接口留了缝但没实现，所以现在只能打字。这是 M2 的缺口，不是已完成的部分。

**倾听层现在用的是自写判断，不是 MaAI。** 音高走向 + 出声段长度这套规则守住了 `CueTracker` 的接口，MaAI 接进来时替换的是同一个对象，下游一行不用改——但**它还没接**，所以别把「接口兼容」当成「已经可用」。

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