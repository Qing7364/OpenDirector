# Agent 协作：Runtime 与 Skill 接入 开发文档

## 1. 背景与目标

最直接的出发点是为对话添加 Skill 能力。复用现有成熟组件，比自行实现技能加载、工具循环和上下文管理更高效。目标是获得可用于生产的 harness 基础，沿用工具执行、取消和诊断机制，让 OpenDirector 专注视频创作业务。

本文展开 [发展路线](roadmap.md) 的「Agent 协作」工作包，范围是 runtime、Skill、会话和执行反馈。业务边界遵循 [统一项目架构](../architecture/unified-project.md#agent-runtime-与业务执行)。完整自主编排、编辑导出和默认入口收敛仍按各自门槛验收。

## 2. 现状分析

当前代码已通过适配层接入 bundled OpenCode 和外部 CLI，共享工程工具；对话已有模型选择、技能引用、素材预览和工具详情入口。本需求整理这些能力的协作契约与验收要求，不把入口可用等同于完整任务通过验收。

| 能力 | 当前落点 | 需核对的边界 |
| --- | --- | --- |
| Runtime 执行 | `runtime.py`、`native.py` | Default 与外部 CLI 的模型、认证和预算来源不同 |
| 工程操作 | `gateway.py`、`tools.py` | 原生 Shell 不能代替工程命令、版本校验和回执 |
| 技能发现 | `skills.py`、内置技能目录 | 发现由 bundled OpenCode 完成，执行时由所选 harness 加载 |
| 对话生命周期 | API `agent.py` | 停止进程、业务操作收尾和远端任务取消分别处理 |
| 前端交互 | `AssistantPanel`、`AgentPicker`、`SkillPicker` | 选择、输入引用和实际执行信息保持一致 |

## 3. 交互规格

用户选择 Default 或外部 harness，引用素材并使用内置或分享的 Skill，直接描述创作目标。Agent 按 Skill 的方法观察素材、规划分段、处理文件并发布结果。用户无需逐段填写参数、计算每段帧数或手动确定镜头分段位置；人物替换领域积累的知识用于提高规划质量、视频质量和换人成功率，实际效果仍需审片验证。

以人物替换为例：读取工程和人物对应关系，检查媒体与执行能力，观察原片并制定分段计划，按授权生成或处理片段，将每个真实产物登记到工程并展示。用户可以检查、修改后继续委托。只要求规划或提示词时，不启动生成。

- 选择器区分 Default 与外部 harness；缺失依赖或认证时给出配置引导，不静默切换。
- `/` 或技能按钮打开选择器，技能插入光标位置，与素材引用共存，支持退格删除。
- 模型和 harness 选择随会话保存；运行中的模型名称取实际执行信息。
- 素材提供缩略图和悬停预览；等待状态和可展开的工具参数、结果用于反馈真实执行进度。
- 用户停止后保留已有回复，已完成的工程操作可继续检查和编辑。

## 4. 技术方案

| 需求 | 要求 |
| --- | --- |
| Runtime 接入 | Default 使用固定版本 bundled OpenCode；支持 OpenCode CLI、Codex、Claude Code，复用底层 Loop 和运行预算 |
| 模型选择 | Default 使用项目模型设置；外部 harness 使用原生认证与模型目录，提供配置引导并记住选择 |
| Skill | 发现内置、工作空间和工程技能；支持 `/` 选择与输入位置引用，正文由 harness 按需加载 |
| 业务操作 | 所有 harness 共用业务工具和命令，不另建一套工程状态或绕过 UI 使用的校验 |
| 媒体执行 | 原素材位置不变，每轮有独立工作目录，原生工具可通过 PATH 使用媒体处理程序 |
| 产物交付 | 使用通用 `artifact.publish` 登记真实文件，按需展示；独立分段不能用原片时间线冒充 |
| 对话交互 | 正确显示运行模型、等待状态、工具参数与结果；素材提供缩略图和悬停预览 |
| 生命周期 | 支持停止、断线清理与部分回复保存，结束后可以再次发起回复 |
| 诊断 | 保留按运行关联的原生轨迹和业务调用证据，可定位失败层和已完成操作 |

执行链路：

```text
对话、素材引用、Skill 选择
          ↓
Runtime 适配层 → 原生 harness Loop、工具与 Skill
          ↓
本轮 ToolGateway → 共用命令与应用服务
          ↓
工程提交与回执 → 查询刷新 → 对话和画布
```

每轮使用 `agent-runs/<turn-id>/work/`，原素材只读且位置不变。原生工具生成文件后，通过 `artifact.publish` 登记，再用 `canvas.show` 展示。会话和轨迹关联运行身份，不另存一份可独立修改的业务工程。

具体 runtime 配置、文件权限和轨迹机制见 [Agent 运行机制](../architecture/agent-runtime.md)。

## 5. 涉及文件

| 文件或目录 | 职责 |
| --- | --- |
| `packages/core/src/opendirector/agent/runtime.py`、`catalog.py` | Runtime 目录、可用性与原生模型选择 |
| `packages/core/src/opendirector/agent/native.py`、`process.py` | 进程启动、工作目录、原生事件与进程清理 |
| `packages/core/src/opendirector/agent/gateway.py`、`tools.py` | 工具校验、调用重放与共用业务命令 |
| `packages/core/src/opendirector/agent/skills.py`、`packages/agent/skills/` | 技能发现与内置技能资源 |
| `packages/core/src/opendirector/agent/model_gateway.py` | Default 的模型请求代理 |
| `apps/api/src/opendirector_api/agent.py` | 会话、运行入口、停止及回复持久化 |
| `scripts/agent-mcp.py` | 原生 harness 与本轮业务工具的通信桥接 |
| `src/canvas/AgentPicker.tsx`、`SkillPicker.tsx`、`ChatReferenceEditor.tsx` | 模型和技能选择、输入引用 |
| `src/canvas/AssistantPanel.tsx`、`AssistantReply.tsx`、`AssistantMedia.tsx` | 对话、工具详情与素材预览 |
| `src/canvas/useAssistantChat.ts`、`agentPreferences.ts`、`src/backend/chat.ts` | 运行事件、选择偏好和会话接口 |

## 6. 验收标准

以下场景落实路线中的能力完成标准；测试替身、真实媒体处理和真实模型调用分别说明验证范围。

- Default 与每个外部 CLI 分别验证模型路由、认证来源、工具访问和真实回复。缺失依赖或认证时提供明确错误，不静默切换 harness。
- 引用素材后输入 `/`，技能在光标位置插入，支持退格删除；发送后保留引用信息。检查重开会话后的 runtime 和模型选择。
- Skill 按需读取正文与相对资源，不依赖开发者机器的绝对路径。图片能力分别检查配置声明、实际模型请求和模型观察结果。
- 使用真实媒体生成多个独立片段，分别探测文件并发布；核对工程 Asset、来源、画布展示和重开后的可用性。仅出现节点不足以通过。
- 工具调用超过原有 24 次仍可执行；重复调用身份返回原结果，不重复修改工程；底层停止或预算耗尽不通过自动重跑绕过。
- 在执行中停止或断开连接，确认进程结束、已接受操作有回执、部分回复保存、运行占用释放，并能够开始下一轮。
- 从轨迹定位一次工具失败，区分参数拒绝、原生工具错误、模型/API 失败和运行结束，核对界面与实际回执一致。
- 对纳入本次范围的业务命令，从 UI 和 Agent 两个入口验证相同规则：对象版本、锁定和输入限制一致；用户直接修改后 Agent 读取新状态继续操作，不覆盖用户修改。
- 项目切换、重开和失败重试后，素材、来源、运行依据与回执保持一致，另一入口可以查询和继续使用；后台刷新保留未提交输入与焦点。
- 对同等创作要求的代表性任务，记录端到端耗时、人工介入、重复操作和资源消耗；工具调用次数或一次成功回复不能证明效率提高。未覆盖的真实服务、导出和质量验收明确列出。

### 测试入口

| 范围 | 测试 |
| --- | --- |
| 工具重放、校验和关闭 | `tests/test_agent_gateway.py` |
| 原生进程、模型路由与工具调用 | `tests/test_native_runtime.py` |
| 真实文件发布与来源 | `tests/test_agent_artifacts.py` |
| 会话保存与停止 | `tests/test_assistant_conversations.py` |
| 模型目录与配置状态 | `tests/test_runtime_catalog.py`、`tests/test_runtime_readiness.py` |
| 输入引用与选择恢复 | `tests/chatReferenceDOM.test.ts`、`tests/referenceMentions.test.ts`、`tests/agentPreferences.test.ts` |

环境和通用命令见 [验证指南](validation.md)。自动化测试不能代替各外部 CLI、真实模型与视频质量验收。

## 7. 风险与注意事项

| 风险 | 处理要求 |
| --- | --- |
| CLI 版本、认证与模型目录差异 | 分别验证各 harness，配置失败明确反馈 |
| 工具允许列表被误认为文件沙箱 | 区分工具权限与操作系统级隔离，工程变更仍经业务服务 |
| 引用或读取工具被误认为视觉能力 | 核对实际模型输入和观察结果，不依据缩略图或文件存在判断 |
| 停止后重试重复提交 | 保留已接受操作的回执，未知状态不能换身份盲目重发 |
| 发布成功被误认为任务完成 | 核对真实文件、工程登记、可编辑性及创作质量 |

本需求不另建 Agent Loop、工作流平台或训练数据系统，也不因接入 Skill 自动承诺 ComfyUI 集成、后台视频渲染或人物替换质量。所需外部服务和工具必须实际可用，再按用户授权执行。轨迹首先用于诊断；未来用于评测或 RL 数据，需要另行定义采集授权、脱敏、数据格式和质量标准。

## 8. 实施顺序

以下按依赖说明建设和核验顺序，不表示当前完成状态。

1. 确认共用命令、版本校验、回执与素材登记契约。
2. 接入 bundled runtime 和工具桥接，核验工作目录、预算来源与进程清理。
3. 接入外部 harness 的模型、认证和配置引导。
4. 打通 Skill 发现、选择、原生加载与资源读取。
5. 接通对话反馈、素材预览和运行轨迹，验证用户与 Agent 交错操作。
6. 用真实多段媒体任务核验持久化、停止恢复、产物和端到端效率，分别记录未覆盖范围。
