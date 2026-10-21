# CHANGELOG

本项目遵循「只追加、不删改历史条目」的记录约定。

## [v2.1.0] — 2026-10-21

### 判定层重做：对齐官方 `/v1/systemone` 协议 + 接入三种真实后端

**背景**：查证 GitHub 上的开源实现后确认，JEV 的调用形状是「一个 `state` + 一组类型化问题，并行返回带概率的结构化答案」，
而不是三个原语各发一次请求；同时存在可落地的开源路线（local-jev 浏览器 ONNX、ollaya 本地守护进程、Laya 开放权重）。

**协议层（新增 `js/jev-protocol.js`）**

- `buildQuestions()`：把业务问题编译成官方形状 —— `noul{statement}` / `score{levels[5]}` / `choice{criteria{}}`
- `stateFromItem()`：把「用户需求 + 候选信息 + 元数据」编译成 state 文本
- `normalize()`：官方答案 → p / 2-10 分 / 分类 / 概率分布 / 置信度
- 校准遵循第三方实测建议：**用 `max(probabilities)` 而不是官方 `confidence`**；`< 0.55` 标「低置信 · 建议人工复核」
- `score` 语义对齐官方「分值可落在档位之间」：优先用档位分布反算期望，只有分数时按 0 基档位插值到 2-10

**三条后端（`js/jev.js` 重写 + 新增 `js/jev-onnx.js`）**

- `local`：本地启发式，一次给出全部 3 个答案，确定性可复现，附影响信号
- `onnx`：移植 [local-jev](https://github.com/zhuanqianfish/local-jev) —— `@huggingface/transformers` + NLI 零样本模型（默认 `mDeBERTa-v3-base-mnli-xnli`，q8），WebGPU→WASM 自动回退，支持 hf-mirror 模型源与下载进度
- `remote`：经零依赖代理访问 `ollaya`（本地开源，wire-identical）/ `typesafe`（官方云端）/ `openai` / `passthrough`
- 任一真实后端失败 → 回落启发式，并在步骤详情与卡片里标注原因

**流水线（`js/pipeline.js`）**

- 判定从「每条 × 3 次请求」改为「每条 1 次调用问 3 个问题」，与官方语义一致
- 统计改为 `N 次调用 / M 个判定`；三个判定步骤共享同一次调用的耗时
- 新增低置信计数与摘要风险提示；摘要明确写出当前判定引擎

**代理（`server/jev-proxy.js` 重写）**

- 新增 `POST /api/systemone`（官方形状）、`GET /api/health`（上报上游模式/模型/限制）、保留 `POST /api/jev` 兼容
- 上游四模式：`ollaya` / `typesafe` / `openai` / `passthrough`
- 校验：问题数 ≤20、choice 选项 2–255、`state` ≤32k 字符、body ≤512KB、限流、错误脱敏、CORS 白名单

**界面**

- 设置面板新增「判定引擎」三选一、ONNX 模型/精度/模型源/加载进度、代理地址与测试连接（显示上游信息）
- 卡片新增：低置信标注、概率分布条（score 档位 / choice 选项）、判定依据显示后端名与回落原因
- 结果头部显示「判定引擎」标签与低置信计数
- 新增 `?static=1` 关闭动画（截图/投影用）、`?theme=dark` 直连深色

**测试**

- `tools/smoke-test.js` 扩到 **61 项**（新增协议层、三后端、ONNX stub、低置信、调用次数）
- 新增 `tools/proxy-test.js` **22 项**（自带假上游，验证官方形状转发、校验、兼容接口、上游不可用）

**文档**

- README 重写「关于 JEV」：官方接口样板、三原语硬限制、成本/延迟/弃权率、开源项目对照与使用方式、诚实声明
- INSTALL 重写「接真实 JEV 的三条路」+ 代理接口与安全约束
- ARCHITECTURE 追加协议层设计与后端选型记录；env.example 改为四模式模板

### 验证

- `node tools/smoke-test.js` → 通过 61 项，失败 0 项
- `node tools/proxy-test.js` → 通过 22 项，失败 0 项
- 无头 Edge：完整链路截图正常、控制台零业务报错；`transformers.js` 在 `file://` 页面动态 import 成功
- 未验证：ONNX 模型权重完整下载与推理（~280MB、依赖 HF 可达）、真实 TypeSafe / ollaya 上游（无 Key / 未装二进制）

## [v2.0.0] — 2026-10-21

### 新增 · 首次交付

**形态重写**：从 1 版的节点画布改为对话式主站（类似 DeepSeek HARNESS 的交互），并支持窄屏抽屉式布局与深色模式。

**业务闭环**

- 主动问答：需求含糊时追问一次，给 4-5 个可点选项（含"直接检索"）。
- 多源检索：GitHub（实时 API，失败回落）、百科/网页、网盘（含存活核验）、本地知识库，可任意组合。
- JEV 三原语判定：`noul` 真伪概率 → 阈值过滤；`score` 2-10 匹配分 → 排序主权重；`choice` 分类 → 结果归类。
- 排序：`composite = score × 0.7 + p × 10 × 0.3`，降序展示。
- 摘要：本地模板合成，含结论、推荐顺序、风险提示，明确区分实时/演示数据。
- 结果卡片：排名、来源、分数条、分类、可点击小链接、判定依据展开、存入知识库、导出 Markdown、重新检索。

**教学与可解释性**

- 思考过程 7 步流式展示，每步带耗时与统计（关键词数、各源条数、脱敏处数、过滤条数、分类分布）。
- 每张卡片可展开 3 次原子判定的依据与影响信号（`backend` 标注 local / remote / local-fallback）。

**右侧提示词工作台**

- 16 条内置模板，4 组（新手入门 / 信息筛选 / 提示词工程 / 知识库）。
- 点击模式可切换：直接检索 / 仅填入输入框。
- 支持新建、编辑、删除自定义提示词（本地持久化）。

**知识库**

- 新建、删除、重命名说明、逐条增删、查看；从检索结果一键存入。
- 参与检索时的回退策略：关键词命中优先，未命中回退最近条目。
- 首次打开自动写入 3 个示例库（新手课程 / JEV 使用手册 / 合规与脱敏，共 13 条）。

**安全与合规**

- 5 类敏感信息（手机号 / 身份证 / 邮箱 / 微信号 / QQ 号）在进入判定前本地脱敏，结果页显式回报处数与类型。
- 硬规则预检查：黑名单词、非 HTTPS、失效网盘链接。
- 全部外部文本经 `esc()` 转义；链接带 `noopener noreferrer`。
- 零第三方依赖，无供应链风险。

**真实 JEV 接入（可选）**

- `server/jev-proxy.js`：零依赖 Node 代理，支持 OpenAI 兼容上游（`openai` 模式）与原生 JEV HTTP 服务（`passthrough` 模式）。
- Key 仅从服务端环境变量读取，错误信息脱敏，CORS 白名单，限流与体积上限。
- 前端远程适配器支持超时与自动降级，回落时在界面标注原因。

**工程文件**

- `README.md` / `INSTALL.md` / `ARCHITECTURE.md` / `CHANGELOG.md` / `TODO.md`
- `env.example`（全占位符）、`.gitignore`
- `打开网站.bat`、`启动JEV代理.bat`
- `tools/smoke-test.js`：41 项断言的无浏览器冒烟测试

### 验证

- `node tools/smoke-test.js` → 通过 41 项，失败 0 项。
- 无头 Edge 渲染：首屏与完整检索链路截图（`docs/`），控制台零业务报错。
- 代理联调：健康检查、三协议、中文 UTF-8 往返、非法 JSON → 400、非法 protocol → 400。
