# INSTALL.md — 安装、运行与验收

## 1. 环境要求

| 用途 | 要求 |
|---|---|
| 打开网站 | 任意现代浏览器：Edge / Chrome / Firefox / Safari 16+ |
| 运行测试（可选） | Node.js 18+（本机已验证 v24.21.0） |
| 跑真实模型（可选） | 路线 B：Ollaya（一个二进制）；路线 C：TypeSafe API Key；路线 A：浏览器下载模型 |

> 网站本体不需要 npm install、不需要打包、不需要数据库。

## 2. 启动（仅本机，默认形态）

```text
双击  2版\打开网站.bat        （或直接双击 2版\index.html）
```

**自检清单**：左侧有 3 个示例知识库；中间有欢迎页与 4 张示例卡；右侧「提示词」有 16 条模板；
顶栏徽章显示 `演示数据` / `JEV · 本地模拟` / `知识库 3 个 · 13 条`。
点任意示例卡 → 1 秒内出现 7 步思考过程 → 结果摘要 → 至少 3 张卡片。

## 3. 接真实 JEV：三条路

> 判定层已对齐官方 `POST /v1/systemone`（`{state, model, questions}` → `{answers}`）。
> 三种后端在界面「检索设置 → 判定引擎」里切换；真实后端不可用会自动回落启发式并在界面标注原因。

### 路线 A：浏览器 ONNX（移植 local-jev，无需服务端）

1. 界面「检索设置 → 判定引擎」选 **浏览器 ONNX 模型**
2. 模型默认 `MoritzLaurer/mDeBERTa-v3-base-mnli-xnli`（多语言含中文），精度 `q8`
3. 点「加载 / 下载模型」，首次约 200–300MB，之后走浏览器缓存
4. 加载成功后跑一次检索，卡片「判定依据 → 后端」会显示 `浏览器 ONNX 推理（local-jev 方案）`

若 HuggingFace 不可达：把「模型源」切到 `hf-mirror.com 镜像`，或把模型 id 换成你本地能访问的镜像仓库。
若 WebGPU 不可用会自动回退 WASM（慢一些但能跑）。加载失败不会影响使用，会自动回落启发式。

### 路线 B：本地开源服务（推荐，真模型、零 Key）

Ollaya 是「决策模型的 Ollama」，它对外暴露的 `/v1/systemone` **与 TypeSafe 完全同形**，所以官方 SDK / 本项目代理都能直接对接。

```bash
# 1) 安装 ollaya（一个二进制）
curl -fsSL https://ollaya.dev/install.sh | sh

# 2) 拉一个模型：中文场景用 laya:multilingual（CPU 可跑，5 个问题约 516ms）
ollaya pull laya:multilingual

# 3) 启动守护进程（默认监听 127.0.0.1:11435）
ollaya serve
```

```powershell
# 4) 配置并启动本项目的代理
cd 'D:\网站检索\2版'
copy env.example .env
#    .env 里保持：
#      JEV_UPSTREAM_MODE=ollaya
#      JEV_BASE_URL=http://127.0.0.1:11435
#      JEV_MODEL=laya:multilingual
node server\jev-proxy.js
```

5. 界面「检索设置 → 判定引擎」选 **本地开源服务 / 官方 API**，地址填 `http://127.0.0.1:8787/api/systemone`
6. 点「测试连接」→ 显示 `连接成功 · 上游：ollaya · http://127.0.0.1:11435 · laya:multilingual`
7. 跑检索，思考过程里会显示 `后端：本地开源服务 / 官方 API`

> 也可以不用代理，直接 `TYPESAFE_BASE_URL=http://localhost:11435` 让官方 SDK 指向 ollaya —— 本项目用代理是为了统一四类上游 + 隐藏 Key。

### 路线 C：TypeSafe 官方 API

```powershell
cd 'D:\网站检索\2版'
copy env.example .env
notepad .env
```

```ini
JEV_UPSTREAM_MODE=typesafe
JEV_BASE_URL=https://api.typesafe.ai
JEV_MODEL=jev-latest          # 生产建议 pin 到具体版本，如 jev-1.13.0
JEV_API_KEY=YOUR_API_KEY_HERE
```

然后 `node server\jev-proxy.js`，界面里同样选「本地开源服务 / 官方 API」，地址 `http://127.0.0.1:8787/api/systemone`。

> 官方 Key 只在服务端 `.env` 里，浏览器拿不到；代理启动日志会显示「API Key 已从环境变量读取」但不会打印内容。
> 官方服务对中国大陆的可用性以官方条款为准（第三方媒体称未开放，官方条款无明文地区限制）。

### 路线 D（进阶）：任意 OpenAI 兼容 / passthrough

- `JEV_UPSTREAM_MODE=openai`：把三个问题编译成一次 JSON 输出请求（适配 vLLM / Ollama / llama.cpp 拉起的任意模型），`JEV_UPSTREAM_URL=http://127.0.0.1:11434`
- `JEV_UPSTREAM_MODE=passthrough`：直接把 `{state, model, questions}` 透传给自定义 JEV 服务

### 3.5 代理接口

```http
GET  /api/health
→ { ok, wire:"typesafe/v1/systemone", upstream:{mode, base, model, keyConfigured}, limits:{maxQuestions:20, maxStateChars:32000} }

POST /api/systemone
body: { state, model?, questions:{ 名字:{type:"noul|score|choice", ...} } }
→ { ok, model, answers:{ 同名key:{...} }, usage, ms, upstream }

POST /api/jev        （兼容旧版单问题：{protocol, question|criteria|options, state}）
```

安全约束：只监听 `127.0.0.1`；CORS 仅放行本机来源与 `file://`（Origin: null）；body ≤512KB、问题 ≤20 个、`state` ≤32k 字符、每 IP 240 次/分钟；错误信息脱敏（不回显 Key）。

## 4. 验收

```powershell
cd 'D:\网站检索\2版'
node tools\smoke-test.js     # 期望：通过 61 项，失败 0 项
node tools\proxy-test.js     # 期望：通过 22 项，失败 0 项（自带假上游，不联网）
```

`smoke-test` 覆盖：脱敏、官方协议层（问题编译/答案归一/置信校准）、三后端（启发式 / ONNX-stub / 远程回落）、7 步流水线、追问、知识库、提示词库。
`proxy-test` 覆盖：健康检查、官方形状转发（state/model/questions）、校验（非法 protocol / 选项不足 / 问题过多 / state 过长）、兼容接口、上游不可用。

手工回归（建议每次改动后跑一遍）：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 点欢迎页「找一套能上手的工作流框架」 | 7 步完成；结果 ≥3 条；卡片有匹配分/真伪/分类/链接 |
| 2 | 展开卡片「JEV 判定依据」 | 3 个问题 + 概率分布条 + 后端名（local/onnx/remote） |
| 3 | 输入「帮我找点东西」 | 出现追问气泡与可点选项 |
| 4 | 切换到浏览器 ONNX 后点「加载模型」 | 有下载进度；成功显示设备与模型名；失败有明确报错且检索仍可用（回落） |
| 5 | 配好路线 B 后点「测试连接」 | 显示上游 mode / 地址 / 模型 |
| 6 | 阈值拖到 0.90 再检索 | 结果变少；全被筛掉时出现「阈值放宽」提示 |
| 7 | 检索含手机号/微信号的网盘结果 | 出现 `［已屏蔽：手机号］`，绿色提示条显示屏蔽处数 |
| 8 | 点卡片「存入知识库」 | 左侧库条数 +1，刷新后仍在 |
| 9 | 刷新页面 | 会话 / 设置 / 知识库都保留 |

## 5. 常见问题

**Q：ONNX 模式一直失败？** → 看「加载 / 下载模型」按钮旁的报错。常见原因：HuggingFace 不可达（换 hf-mirror）、内存不足（换 `q8` 或更小模型）、浏览器太旧。失败会自动回落启发式，不影响流程。

**Q：代理报 `上游 HTTP 404`？** → 上游不是 `/v1/systemone` 形状，或 `JEV_BASE_URL` 少了端口/多了路径。ollaya 默认 `http://127.0.0.1:11435`。

**Q：ollaya 装不上 / 拉不到模型？** → 先 `ollaya list` 看模型是否拉到；`laya:multilingual` 是 CPU 友好档，`winnow:e4b` 需要 NVIDIA GPU。

**Q：实时检索报错？** → GitHub 未登录限流 60 次/小时，界面会标注回落原因并自动用演示数据。

**Q：网盘/网页为什么是演示数据？** → 无公开、可跨域、免鉴权的搜索接口。本版如实标注，不伪造实时结果（见 TODO 的 P0）。

**Q：中文判定准吗？** → 官方模型 CJK「能用但不同等」；开源 Laya 有 `multilingual` 档。低置信条目会被显式标注，别直接采信。

**Q：`.env` 会不会被提交？** → `.gitignore` 已忽略 `.env*`（保留 `env.example`）。

## 6. 部署分级（当前默认第 1 级）

| 级别 | 状态 |
|---|---|
| 1. 仅本机调试 | ✅ **本次交付形态**：静态文件 + 代理只监听 `127.0.0.1` |
| 2. 局域网可用 | ⏳ 需你明确指令后提供（`0.0.0.0` 绑定 + 防火墙） |
| 3. 临时穿透演示 | ⏳ 需你明确指令（非生产、链路不可控，会加警示） |
| 4. 永久公网部署 | ⏳ 需你明确指令（反代 + SSL + 备案 + 必须先做鉴权） |

> 按 SOP 部署分级纪律：未收到明确指令前，不提供任何对外监听、隧道或反向代理配置。
