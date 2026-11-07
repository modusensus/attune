# attune · 同频

> 开源的 AI 角色都在学怎么说话。这个项目学怎么听。

attune 是一个可替换角色的实时语音对话引擎。角色是一份配置，不是一段代码；引擎里没有角色。

当前状态：**M5 两种后端都能驱动**。有人设卡、有记忆、有流式输出、有可替换的模型端点；有 TTS，有口型曲线；有麦克风输入和语音识别；有倾听层的判断与手势映射。同一份手势与口型，可以落到 3D 的 VRM 骨骼上，也可以落到 2D 的 Live2D 参数上——换的是 `[renderer] type` 一行。**还没有渲染器**——引擎算的是"这一帧该摆成什么样"，画由外面的 three.js 或 pixi-live2d-display 去画。

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
npm test          # 295 项测试（293 通过，2 项在非 Windows 上跳过）
npm run accept examples/example-character   # 十轮人设一致性验收，带语音
npm run voice     # 跑一轮并把 wav、口型曲线、元数据写到 ./out/voice-demo
npm run listen    # 倾听层三条机械验收，产物在 ./out/listen-accept
npm run asr -- --character <dir>            # 识别链路验收，产物在 ./out/asr-accept
npm run vrm -- --model <file.vrm>           # 3D 驱动验收，产物在 ./out/vrm-accept
npm run live2d -- --model <file.model3.json>  # Live2D 驱动验收，产物在 ./out/live2d-accept
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

## 耳朵也有三种接法

默认 `asr.engine = "none"`，也就是没有耳朵——**并且此时麦克风根本不会被打开**。对着一个听不见的引擎录音是演戏。

```toml
[asr]
engine = "sapi"        # Windows 自带识别器，不用下载
language = "zh-CN"
```

或者任意 OpenAI 兼容的 `/audio/transcriptions`：

```toml
[asr]
engine = "http"
model  = "whisper-1"
language = "zh"
```

```bash
export ATTUNE_ASR_BASE_URL=http://127.0.0.1:8080/v1
export ATTUNE_ASR_MODEL=whisper-1
```

或者你本机已经装了 whisper.cpp / sherpa-onnx：

```toml
[asr]
engine = "cli"
command = "whisper-cli -m models/ggml-base.bin -nt -f {audio}"
```

`{audio}` 是占位符，必须有，没有就报错。命令按引号切分后直接 spawn——**不经 shell，不做通配符展开，不做变量替换**：配置行要是能跑任意 shell，`character.toml` 就成了远程代码执行面。

### 关于 Windows 自带识别器的诚实说明

它能用，但确实是 2010 年前后的老引擎。实测（合成音喂回去，理想条件）：

| 说的 | 认成 | 字重合 |
|---|---|---|
| 外面在下雨。 | 外面在下雨 | 1.00 |
| 你说我明天还要不要开门。 | 你说我明天还要不要开门 | 1.00 |
| 今晚有人来吗？ | 今晚有人来骂 | 0.83 |
| 我刚看完一本书，结局不太好。 | 我刚看完一本书局部太好 | 0.83 |
| 我有点困了。 | 果有点困了 | 0.80 |

平均 0.89，错的都是同音字和吞掉首字。它的 `confidence` 也不像概率：0.31 和 0.59 那两句，错的那句反而更低——只是巧合，不要拿它做阈值。

所以 `npm run asr` **只报重叠度，不设及格线**。识别准确率是识别器的属性，不是接线的属性；「你的角色可以听错到什么程度」只有人能定。

真想要好耳朵，接 whisper。这也是为什么留了 `http` 和 `cli` 两条路。

### 无麦克风也能验收

```bash
node src/cli.ts --character <dir> --say-file some.wav
```

一个 wav 进去，一轮对话出来。CI 机器、远程会话、拿录音比对不同识别器，都走这条。识不出字就退出码 1 并明说「没有可接的一轮」——不会假装成功。

## 倾听是判断，不是检测

VAD 能回答「有没有人在出声」。它回答不了「这个停顿是句号还是换气」——而这正是「一个会等你说完的机器」和「一个在听你说话的人」之间的全部区别。

`src/listen/` 用两个信号把这件事做出来，不需要模型：

- **音高走向。** 一句话收尾时基频下沉，没说完的分句末尾会上扬或持平。取有声段最后三分之一与前三分之一的基频中位数比，跌过 12% 算句号。停顿时长一样，走向不同，结论就不同。
- **出声段长度。** 别人说话时一段 120–350ms 的短促出声是「嗯」是点头，不是抢话；超过这个长度才算回合企图。

两者合成四种判断：`backchannel`（附和）、`hold`（停顿但我还在）、`turn_take`（交回合了）、`idle`（这一段根本没人说话）。

判据分三层，一层比一层苛刻：

1. **交回合要等。** 降调收尾后 700ms 静音才接话；音高没下沉的停顿要等到 1400ms。早接话是不可挽回的失礼，晚接话只是慢一点。
2. **反应要有预算。** 早期版本 94 秒里反应了 236 次，平均 0.4 秒一次——那不是专注，那是屏保。现在有全局下限（任意两类反应间隔 ≥1.5s）加上按类型的下限（hold ≥4s、backchannel ≥2.5s），实测降到 78 次。`turn_take` 完全豁免：因为刚抬过眉毛就不交回合，用户会对着墙说话。
3. **三态各自该做什么。** `listening` 才产出手势；`thinking` 期间麦克风整个忽略（那时的任何反应都叠在自己的思考上）；`speaking` 只认打断，不产手势——角色不对自己点头。

手势是形状不是数字。一个 gesture 是 `{channel, at, peak, riseMs, holdMs, fallMs}`，同一通道重叠时取最大值而不是相加：两次点头还是一条脖子，加起来 1.8 会顶穿 rig 的上限。

```bash
npm run listen
```

三条机械验收，产物在 `out/listen-accept/`：90 秒独白期间至少有 4 次反应且没有一次发生在说话结束之后；0.8 秒的中途停顿不被当成交还；打断在 200ms 内被检测到。当前实测 78 次反应（20 次 hold、19 次点头、20 次抬眉、19 次偏头），打断延迟 20ms。

**这三条是必要不充分。** 脚本能证明它没有在错误的时刻动，不能证明像不像在听——那个得你自己坐着对它说一会儿话。

## 3D 不靠装包

`src/render/vrm/` 自己解析 GLB/VRM，不 import three.js。

不是造轮子有瘾，是这条约束逼出来的：**clone 下来不装任何东西就得能跑**。three.js 的 VRM loader 要 npm install，装完还要一个 WebGL 上下文才能算骨架——那就没法在终端里、在 CI 里、在没有 GPU 的机器上验证「这个手势到底有没有让头动起来」。现在它是纯函数：给毫秒数，回一组骨骼四元数和表情权重，测试断言得出来。

支持 VRM 1.0 与 0.x 两个版本（骨骼命名、表情表、拇指三段名都不一样，解析器翻译成同一套 52 个规范名）。

**硬的地方是世界空间，不是读文件。** VRM 1.0 的头部骨骼局部旋转经常是 180°（模型是倒着建的，靠父子链把它翻正）。这时往局部 X 轴加 12° 点头，转出来是世界 -X，表现在脸上就是**歪脖子**而不是低头。所以增量必须在世界空间合成：

```
localNew = parentWorld⁻¹ · worldDelta · parentWorld · localRest
```

这条有测试钉着：把一个模型的头骨设成半转，再点一次头，反解出的增量必须还是绕世界 X 轴的 12.00°，侧倾泄漏小于 1e-6。

**没有的表情就说没有。** VRM 标准里压根没有「抬眉」这个预设，两个真实样本模型也都没自带。`brow_raise` 会被丢进 `dropped` 并写明理由，而不是偷偷用 `surprised` 顶上——后者同时睁大眼、常常张嘴，在 hold 的 0.3 强度下看起来像每四秒被吓一次。角色面无表情是合法状态，编一个动作出来才是屏保。

```bash
npm run vrm -- --model out/vrm-probe/VRM1_Constraint_Twist_Sample.vrm
```

```
  spec:     VRM 1.0
  bones:    52 humanoid
  channels this rig cannot express: brow_raise
    brow_raise: no eyebrow expression

  PASS  none and vrm see the same channels  —  157 frames agreed
  PASS  the nod is a nod, not a shudder  —  peak 7.20 degrees
  PASS  the head comes back to rest  —  0.000 degrees at the end
  PASS  the mouth opens while speaking  —  peak aa 0.88
```

「none 和 vrm 看到同一串通道」这一条是 M4 的全部主张：**同一份配置，换 `[renderer] type` 就该换画法，不用改别的地方**。脚本验的是数值，像不像人得打开 `frames.json` 自己看。

口型进 3D 走两条路：`aa` 表情权重直接吃包络值；有下颌骨的模型再额外转 `JAW_DEGREES × mouth`。**这不是 lip sync，是包络能诚实声称的东西**——真要按音素做口型，得先有音素时间轴，那是另一件事。

## 2D 也不靠装包

`src/render/live2d/` 自己解析 `model3.json` 与 `cdi3.json`，不 import Cubism SDK，也不碰 `pixi-live2d-display`。

同一个理由：验证要能在终端里跑。`moc3` 是二进制专有格式，这里**只校验 4 字节 magic 和文件长度，不解析**——解析它等于让下游全部依赖我对格式的读法。真正上屏那一步必须由宿主加载 `live2dcubismcore`，这是 Live2D 的许可要求，我们绕不过去，也不假装绕过去了。

**驱动哪些参数，是这一层最重要的一条纪律。** 鲸鱼娘的 `cdi3` 里有 247 个参数，绝大部分是道具开关（换发型、拿手机、鲸鱼、墨镜、蛋包饭）和 `j1`–`j57` 这种编号参数。后端只写 9 个：`ParamAngleY/Z`、`ParamEyeBallX/Y`、`ParamBrowLY/RY`、`ParamEyeLOpen/ROpen`、`ParamMouthOpenY`。验收脚本拿白名单卡死，写出第 10 个参数就是失败。**编道具动效＝发明模型不会的表情。**

**「不写」和「写 0」不是一回事。** 这一条是先写错、被测试逮到才学会的：idle 帧里 `nod = 0`，实现照样写 `ParamAngleY = -0`，等于每帧把头角度按回基准，模型自带的 idle 头部小动作全被取消；眨眼同理，写 `ParamEyeLOpen = 1` 会把模型自己的眨眼动作一起关掉。现在只有 `blink > 0` 才写眼开度，只有 `nod > 0` 才写头角度，其余帧一个字段都不产出。

```bash
npm run live2d -- --model /path/to/c_0120.model3.json
```

```
  moc3:      ...c_0120.moc3  (2119552 bytes)
  textures:  2 file(s)
  params:    247 declared
  lipsync:  (group declared empty; falling back to ParamMouthOpenY)

  PASS  none and live2d see the same channels  —  157 frames agreed
  PASS  the head moves during the nod  —  peak ParamAngleY 7.20 degrees
  PASS  the nod is a nod, not a shudder  —  peak 7.20 degrees
  PASS  the head comes back to rest  —  0.000 degrees at the end
  PASS  a blink closes the eyes  —  lowest eye openness 0.00
  PASS  the eyes are left alone when nothing is blinking  —  no idle frame writes eye openness
  PASS  the mouth opens while speaking  —  peak ParamMouthOpenY 0.88 (fell back: the model declares an empty LipSync group)
  PASS  only conversation parameters are written  —  9 parameter(s), all allowed
```

`none` 和 `live2d` 看到同一串通道、`none` 和 `vrm` 也看到同一串通道——**同一份 `[mapping]`，换后端不该换动作。** M5 的全部主张就在这条，其余检查只是防止数值离谱。

### 鲸鱼娘那套模型不在仓库里

仓库里 vrm/live2d 只放代码。上面演示用的开源鲸鱼娘 Live2D（上善无形 / ZipZipPipe / 氵六青 三位作者，`assets/model/**` 为 CC BY-NC-SA 4.0 非商业）只存在于本机用户目录。**attune 是 MPL-2.0，NC 素材进来就是许可冲突**，所以验收脚本的注释里也写了一遍：模型路径由 `--model` 传，仓库一个字节都不存。

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

[asr]
engine = "none"        # 见上文「耳朵也有三种接法」

[renderer]
type = "none"          # none / vrm / live2d
model = "none"         # type = "vrm" 指向 .vrm；type = "live2d" 指向 .model3.json

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
| M2 | 语音闭环：TTS + 口型 | 完成 |
| M2.5 | 听觉：麦克风 + 可替换识别器 | 完成 |
| M3 | 倾听层：音频帧 + 判断 + 三态机 + 参数映射 | 完成（MaAI 未接） |
| M4 | 3D：VRM 后端（解析 + 骨骼/表情驱动） | 完成（渲染器未接） |
| M5 | 2D：Live2D 后端（model3 解析 + 参数驱动） | 完成（渲染器未接） |

M1 的出口标准是「能连续对话 10 轮不掉人设」。机械那一半由 `npm run accept` 检查（无漂移词、无原样复述、无重复、长度可朗读），另一半靠人读 transcript——脚本不会替你宣布人设还在。

M2 的出口标准是「能说话，有口型」。`npm run accept` 一并检查：每轮真的合成了音频、音频不是空的、口型曲线存在且峰值大于 0.1（静音引擎豁免，它本来就该全闭）。脚本仍然只报机械部分，最后一行写着「听一遍，曲线跟得上字吗」。

M2.5 的出口标准是「说一句话，角色听见并按它回答」。`npm run asr` 检查机械部分：五句话全部认出了非空文字、识别结果真的进了引擎、引擎真的回了话。准确率部分只报数字——Windows 自带识别器平均字重合 0.89，会说错同音字，这是识别器的属性，不是接线的属性。

**流式识别没做，也没打算现在做。** `AsrProvider` 是整句接口。流式的形状（带修正的假设流）是另一套契约，而引擎的输入本来就是「一轮说完的话」——现在编一个没人兑现的流式接口，等于先承诺。

**不用 VAD 切句，用 push-to-talk。** 决定「一句话说完了」正是本项目用自己的音高判断在做的事，不该在还没听到音高之前先交给 VAD 判掉。

**M4 / M5 只算姿态，不画。** 引擎输出的是「这一帧头转多少度、嘴张多大、用哪个表情」，坐标系里还没有相机、材质、光照。要看见画面，得有个宿主页面拿 three.js 把骨骼贴上去，或者拿 pixi-live2d-display 把参数灌进去——那是下一步，不是借口。另外**没有渲染器的加载器**：`backendFor` 认的是我们自己解出来的 rig 结构，不是 three.js 的 VRM 对象，也不是 Cubism 的 model 对象，宿主那边得自己把两边对上。

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
- **不做商用、不做托管服务。** 许可允许商用，但这个项目的定位是非商业研究与自用。

## 许可

[Mozilla Public License 2.0](LICENSE)（MPL-2.0），Copyright (c) 2026 modusensus。

选它而不是 MIT，是因为这个仓库最值钱的东西是**判断**——什么时候该点头、什么时候该闭嘴、什么时候该把话头交回去。这些判断都写在具体文件里。MPL 是文件级 copyleft：

- 你改了 `src/listen/session.ts`，那个文件（以及你改出来的衍生文件）要继续以 MPL 公开；
- 但你可以把 attune 整个拼进一个闭源产品，只要不去改我们这几个文件，或者改了也把那几个文件放出来；
- 不要求你的整个产品开源（这是它和 GPL/AGPL 的关键差别）。

一句话：**改我们的文件要公开，用我们的文件不必。**

按 MPL-2.0 附录 A，许可通知放在根目录的 `LICENSE`，不往每个文件头上塞同一段话——39 个源文件开头都贴一遍版权声明是噪音，附录 A 明确允许把通知放在接收者大概率会看的位置。

注意 MPL-2.0 只覆盖仓库里的代码。演示用的鲸鱼娘 Live2D 属于另一条链（CC BY-NC-SA 4.0 非商业 + Live2D Inc. 的 Cubism SDK 专有许可），它不在这个仓库里，也不受这份许可授权。