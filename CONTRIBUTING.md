# 参与贡献 · CONTRIBUTING

本项目是教学向项目，欢迎按下面的流程改代码、提 PR。
目标读者包括学生：**照着这里的规矩做一遍，就等于走了一遍真实团队协作流程。**

---

## 1. 本地怎么跑

```text
双击 打开网站.bat          （或直接双击 index.html）—— 无需安装、无需构建
```

改代码后至少跑一遍测试：

```powershell
node tools\smoke-test.js     # 61 项：脱敏 / JEV 协议层 / 三后端 / 流水线 / 追问 / 知识库 / 提示词
node tools\proxy-test.js     # 22 项：代理端到端（自带假上游，不联网）
```

> 提交前两条都必须绿。CI 也会在 Node 18 / 20 / 22 上重复跑一遍（见 `.github/workflows/ci.yml`）。

## 2. 目录与职责

| 路径 | 职责 | 改动注意 |
|---|---|---|
| `js/jev-protocol.js` | 官方协议层：业务问题 → JEV 问题；答案 → 界面结构 | **改这里必须同步** `app.js` 的展示、`pipeline.js` 的字段、`smoke-test.js` 的断言 |
| `js/jev.js` | 判定调度：local / onnx / remote 三后端 + 降级 | 新增后端请实现 `systemone()` 并在 `backend()` 里注册 |
| `js/jev-onnx.js` | 浏览器本地推理（移植 local-jev） | 只负责"跑模型"，不要混入业务判断 |
| `server/jev-proxy.js` | 零依赖代理：ollaya / TypeSafe / OpenAI 兼容 / passthrough | **密钥只能从环境变量读**，不得回显、不得写进代码 |
| `js/pipeline.js` | 7 步流水线 | 步骤 id 是界面契约，改名会破坏历史会话渲染 |
| `js/app.js` | 界面主控（对话/卡片/设置/弹层） | 用户与外部文本一律走 `Core.esc()` |
| `js/sources.js` | 检索与脱敏预检查 | 脱敏必须在"进入判定之前" |
| `docs/` | 截图（README 引用） | 改界面后建议更新 |

## 3. 硬规则（CI 之外的人工检查）

1. **禁止硬编码任何密钥 / Token / 私钥**。占位符统一 `YOUR_API_KEY_HERE`，真实值只放本地 `.env`（已被 `.gitignore` 忽略）。
2. **XSS**：任何进入 DOM 的外部文本必须 `Core.esc()`；脱敏占位符由 `Core.mask.html()` 白名单还原，不要手拼 HTML。
3. **脱敏前置**：手机号 / 身份证 / 邮箱 / 微信号 / QQ 号在进入判定与展示之前替换，并回报屏蔽处数。
4. **诚实标注**：模拟数据必须标 `simulated`；真实后端失败必须回落并写明原因，不得冒充。
5. **编码**：所有文件 UTF-8 无 BOM；缩进 2 空格（`.bat` 用 CRLF，见 `.gitattributes`）。
6. **零依赖**：网站与代理都不引第三方 npm 包（CI 无需 `npm install`）。加依赖前先讨论。

## 4. 分支与提交

```bash
git checkout -b feat/你的功能名        # 或 fix/ chore/ docs/
# 改代码 → 跑两条测试 → 提交
git add -A
git commit -m "feat: 一句话说清改了什么"
git push -u origin feat/你的功能名
```

提交信息参考现有风格：`feat:` 新功能、`fix:` 修 bug、`docs:` 文档、`chore:` 工程杂项、`test:` 测试。

## 5. 提 PR（本项目要演示的流程）

1. 推送分支后，在 GitHub 上点 **Compare & pull request**，或用命令行：
   ```bash
   gh pr create --base main --head feat/你的功能名 \
     --title "feat: 一句话标题" \
     --body "改了什么 / 为什么改 / 怎么验证（贴测试输出）"
   ```
2. PR 模板要求写清三件事：**改了什么、为什么、怎么验证**。
3. CI 变绿 + 至少一个人 Review 通过后再合并（Squash merge 保持 `main` 干净）。

## 6. 想加一种新的 JEV 后端？

照着下面四条改，不需要动界面：

1. 在 `js/jev.js` 里写一个 `viaXxx(item, demand, questions, opts)`，返回 `{ answers, meta, backend, simulated, usage }`；
2. `answers` 用官方形状：`{ 问题名: {noul:0~1} | {score, probabilities} | {choice, probabilities} }`；
3. 在 `systemone()` 的分支里注册，并在 `backendLabel()` 里给中文名；
4. 在 `tools/smoke-test.js` 补一组断言（可注入 stub，不必真连服务）。

> 判定结果一律走 `JEVProtocol.normalize()` 归一，不要在界面里自己算阈值或置信度。

## 7. 教学场景建议（产教融合）

- **第一次练手**：改一条提示词模板（`js/promptlib.js`），跑测试，提 PR。
- **第二次**：调 `jev.js` 的启发式权重，观察同一需求的排序变化。
- **第三次**：按第 6 节加一个后端（例如你们自己部署的模型服务），用 stub 测试兜住逻辑。
