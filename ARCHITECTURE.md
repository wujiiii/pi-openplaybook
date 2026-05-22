# openplaybook 插件架构设计

## 目标

openplaybook 是一个基于 pi 的多角色开发流程插件。它把需求讨论、架构设计、计划拆分、开发、审查、QA 和用户验收组织成可追踪的阶段化工作流。

核心目标：

- 用户通过 WebUI 看到每个阶段 channel 中的角色协作过程。
- 角色之间主要通过文件传递信息，channel 消息保持简短。
- 用户既可以和流程协调员沟通，也可以在当前阶段 channel 中 `@角色` 直接沟通。
- 编排师（orchestrator）始终可在 `control` 频道被 @，无论当前阶段是什么。
- 每个阶段都由用户显式推进，必要决策必须回到用户。
- 审查师和 QA 拥有否决权；未通过时不能进入下一子任务或下一里程碑。
- 一个项目同一时间只能有一个 active workflow。
- 角色会话在后台运行，WebUI 可查看其工作细节，但不显示终端窗口。
- 默认使用**真正的懒启动**：角色会话只在第一次收到指向它的消息时才启动，避免无谓的 token 消耗。
- 在子任务 QA 通过、里程碑批准时由系统自动 `git commit`，作者归属落在负责该阶段的角色身上。
- 支持基于 git branch/checkpoint 回退到用户批准过的阶段边界。

## 设计原则

1. 文件是事实来源  
   所有正式产物、任务状态、审查结论和用户批准状态都写入 `.openplaybook/<workflow>/`。

2. channel 是协作记录  
   channel 只保存简短消息、任务通知、产物链接和用户 `@角色` 沟通记录。角色之间不在 channel 中长篇讨论。

3. 阶段由状态机控制  
   Orchestrator 只推进合法状态转换，不替专业角色做专业判断。

4. 用户拥有阶段推进权  
   需求确认、架构确认、计划确认、里程碑验收、范围变更都必须等待用户批准。

5. 否决权优先  
   代码审查师或 QA 返回 `rejected` 时，Orchestrator 必须退回对应开发任务。

6. 项目边界优先  
   WebUI 和插件只读取当前项目根目录下的 `.openplaybook/`，不跨项目扫描工作流或角色会话。

## 系统组成

### 1. pi 扩展层

位置：

```text
packages/openplaybook/src/
```

职责：

- 注册 `/openplaybook` 或 `/opb` 命令。
- 管理 workflow 状态。
- 读写 `.openplaybook/<workflow>/` 文件。
- 向角色 session 派发任务。
- 接收用户批准、修订、状态查询命令。
- 为 WebUI 暴露 channel、任务、产物和状态数据。
- 管理项目级 active workflow 锁。
- 创建阶段 checkpoint，并支持回退到已批准阶段。

推荐命令：

```text
/opb start <name>
/opb status
/opb next
/opb approve
/opb revise <reason>
/opb message @role <message>
/opb open-ui
/opb close
/opb rollback <checkpoint>
```

### 2. Orchestrator 流程协调员

Orchestrator 是流程状态机和调度器，不是专业设计者。

固定 channel：

```text
control
```

职责：

- 在 `control` channel 和用户沟通阶段推进、阻塞项、批准请求。
- 根据 `state.json` 判断下一步。
- 给专业角色创建任务文件。
- 将任务分配消息写入对应阶段 channel。
- 检查专业角色产物是否齐全。
- 检查审查师和 QA 的通过/否决状态。
- 在需要用户决策时暂停流程。

Orchestrator 不应该：

- 代替架构师写架构。
- 代替 SQL 设计师写 schema。
- 代替审查师通过审查。
- 在用户未批准时进入下一阶段。

### 3. 角色 sessions

每个角色对应一个可恢复 pi session。首次创建时注入 persona，后续通过 session 恢复保留上下文。

角色列表：

```text
orchestrator
product_manager
architect
sql_designer
architecture_reviewer
plan_writer
plan_reviewer
frontend_developer
backend_developer
code_reviewer
qa_tester
```

角色 session 只处理分配给自己的任务。任务上下文来自任务文件和引用产物，而不是长 channel 消息。

角色 session 默认后台运行，不显示独立终端窗口。WebUI 通过工作详情视图查看其工作过程。

角色工作详情写入：

```text
.openplaybook/<workflow>/sessions/<role>/
  status.json
  transcript.jsonl
  tool-events.jsonl
  artifacts/
```

`transcript.jsonl` 记录角色会话消息摘要和任务响应。`tool-events.jsonl` 记录工具调用摘要、文件变更摘要和错误摘要。默认不展示敏感环境变量、token 或密钥。

### 4. WebUI

WebUI 类似 chat room，按阶段展示 channel。

推荐 channel：

```text
control
requirements
architecture
planning
development
review
```

WebUI 必须支持：

- channel 切换。
- 消息流展示。
- 产物链接展示。
- 角色工作详情视图。
- 当前 workflow 状态展示。
- 当前阶段、当前里程碑、当前阻塞项展示。
- 用户在阶段 channel 中 `@角色` 发送消息。
- 用户批准、退回、请求修订。

WebUI 访问边界：

- 只展示当前项目 `.openplaybook/` 下的 workflow。
- 只能操作当前 active workflow。
- 已完成、关闭或归档的 workflow 只读展示。
- 不展示其它项目的 pi session。
- 不直接显示后台终端窗口，只显示结构化 transcript、tool events 和 artifacts。

`@角色` 消息路由规则：

- `control` channel **始终允许 @orchestrator**，与当前阶段无关；这是用户随时向编排师询问进度或干预流程的通道。
- 其他频道在它对应的阶段处于活跃状态时可由用户发起 `@role`，目标角色必须在 `PHASE_MENTIONABLE_ROLES[当前阶段]` 内（其中每个阶段都包含 orchestrator）。
- 当前阶段 channel 中的 `@role` 消息直接写入该角色 inbox，同时在 channel 留痕。
- 非活跃阶段的频道默认只读；保守策略下只解锁 `control`，其余历史 channel 保留为只读。
- 服务端 `routePhaseMessage` 接收可选的 `channel` 参数；未传时回退到 `PHASE_CHANNEL_MAP[当前阶段]`。校验规则：`PHASE_MENTIONABLE_ROLES[当前阶段] ∪ CHANNEL_MENTIONABLE_ROLES[频道]`。
- 如果 `@role` 不在以上并集内，WebUI 给出提示，不直接派发。

每个阶段声明可沟通角色（每条 `mentionableRoles` 都包含 `orchestrator`，省略时默认追加）：

```json
{
  "phase": "architecture_design",
  "channel": "architecture",
  "mentionableRoles": [
    "architect",
    "sql_designer",
    "architecture_reviewer",
    "orchestrator"
  ]
}
```

频道层面的兜底映射 `CHANNEL_MENTIONABLE_ROLES`：

```json
{
  "control": ["orchestrator"],
  "requirements": [],
  "architecture": [],
  "planning": [],
  "development": [],
  "review": []
}
```

## 工作流生命周期

项目级目录：

```text
.openplaybook/
  active-workflow.json
  <workflow>/
```

同一个项目同一时间只能有一个 active workflow。创建新 workflow 前必须检查 `.openplaybook/active-workflow.json`。

workflow 生命周期：

```text
active
completed
closed
failed
archived
```

规则：

- `active` workflow 存在时，不允许创建新 workflow。
- `completed` 表示流程正常完成。
- `closed` 表示用户主动关闭流程。
- `failed` 表示流程异常终止，需要用户处理。
- `archived` 表示历史流程只读保存。
- `completed`、`closed`、`archived` 状态允许创建新 workflow。
- `/opb close` 会停止后台角色 session，清除 active workflow 锁，并将 channel 设为只读。

`active-workflow.json` 示例：

```json
{
  "workflow": "checkout-redesign",
  "path": ".openplaybook/checkout-redesign",
  "status": "active",
  "phase": "architecture_design",
  "createdAt": "2026-05-18T10:00:00.000Z",
  "updatedAt": "2026-05-18T10:30:00.000Z"
}
```

## 懒启动模式

角色会话**真正的懒启动**：

- `RoleSessionOrchestrator.syncPhase` 在阶段切换时只做两件事——为新阶段不可联系的角色调 `stopRuntime`，以及确保每个角色目录、`transcript.jsonl`、`tool-events.jsonl` 已初始化。**不再预启动**任何当前阶段角色。
- 角色 session 只在 `deliverUserMessage` 被调用（即首次收到指向它的用户消息）时才通过 `ensureRuntime` 真正起来，跑 bootstrap prompt、占用 token。
- 测试或将来需要"先热"某个角色时，调公共方法 `RoleSessionOrchestrator.ensureRoleRunning(paths, role, state)` 显式触发，不要回到 `syncPhase`。
- 阶段结束后，非后续阶段需要的角色进入 `stopped`。从未被 @ 过的角色一直保留在 `not_started`。
- 用户在 `control` 频道随时可 @ orchestrator；其他频道仅在它对应阶段活跃时可 @。

角色状态：

```json
{
  "role": "architect",
  "phase": "architecture_design",
  "status": "not_started",
  "sessionId": null,
  "currentTask": null,
  "lastHeartbeatAt": null
}
```

允许状态：

```text
not_started
starting
running
waiting
idle
done
failed
stopped
```

WebUI 上"角色状态"栏使用 `roleColors[role]` 表示角色身份（圆点的颜色），状态本身仅以文字呈现（不再用颜色或动画区分 running / failed / done 等）。

## 文件结构

每个 workflow 使用独立目录：

```text
.openplaybook/<workflow>/
  state.json
  roles/
    orchestrator.json
    architect.json
    ...
  channels/
    control.jsonl
    requirements.jsonl
    architecture.jsonl
    planning.jsonl
    development.jsonl
    review.jsonl
  inbox/
    architect.jsonl
    backend_developer.jsonl
    ...
  tasks/
    requirements/
    architecture/
    planning/
    development/
    review/
  artifacts/
    requirements.md
    architecture.md
    schema.sql
    architecture-review.md
    milestone-001-review.md
    milestone-001-qa.md
  decisions/
    0001-scope.md
    0002-architecture-option.md
  sessions/
    architect/
      status.json
      transcript.jsonl
      tool-events.jsonl
      artifacts/
  summaries/
    requirements.md
    architecture.md
    planning.md
  checkpoints/
    requirements-approved.json
    architecture-approved.json
    planning-approved.json
```

## 状态机

推荐状态：

```text
draft
requirements_discussion
requirements_approval
architecture_design
architecture_review
architecture_approval
planning
planning_review
planning_approval
development
subtask_review
subtask_qa
milestone_review
milestone_approval
done
blocked
```

状态转换规则：

- `requirements_approval` 必须由用户批准后进入 `architecture_design`。
- `architecture_review` 必须由审查师通过后进入 `architecture_approval`。
- `architecture_approval` 必须由用户批准后进入 `planning`。
- `planning_review` 必须由计划审查师通过后进入 `planning_approval`。
- `planning_approval` 必须由用户批准后进入 `development`。
- 每个子任务必须经过代码审查和 QA。
- 每个里程碑必须经过里程碑审查和用户验收。

## state.json

示例：

```json
{
  "workflow": "checkout-redesign",
  "status": "active",
  "phase": "development",
  "round": 1,
  "currentMilestone": "M1",
  "currentTask": "M1-T2",
  "awaitingUserApproval": false,
  "blockedBy": null,
  "roles": {
    "architect": {
      "sessionId": "pi-session-id",
      "status": "idle"
    }
  },
  "milestones": [
    {
      "id": "M1",
      "status": "in_progress",
      "tasks": ["M1-T1", "M1-T2"]
    }
  ]
}
```

## 阶段摘要

每个阶段结束时生成一份摘要，供用户快速确认：

```text
.openplaybook/<workflow>/summaries/<phase>.md
```

摘要包含：

- 本阶段目标。
- 关键决策。
- 产物列表。
- 未解决问题。
- 审查和 QA 状态。
- 是否等待用户批准。

## channel 消息协议

channel 消息必须简短。详细内容放入文件。

示例：

```json
{
  "id": "msg_001",
  "ts": "2026-05-18T10:00:00.000Z",
  "channel": "architecture",
  "from": "architect",
  "to": ["sql_designer", "architecture_reviewer"],
  "type": "artifact_ready",
  "text": "架构草案已完成，详情请看 artifacts/architecture.md。",
  "refs": ["artifacts/architecture.md"]
}
```

用户 `@角色` 消息示例：

```json
{
  "id": "msg_021",
  "ts": "2026-05-18T10:30:00.000Z",
  "channel": "architecture",
  "from": "user",
  "to": ["architect"],
  "type": "user_message",
  "text": "@architect 这个方案是否支持后续多租户？",
  "refs": []
}
```

## 任务协议

每个任务是一个 markdown 文件，包含任务目标、输入、输出、验收标准和状态文件路径。

示例：

```text
tasks/development/M1-T2-backend-api.md
```

任务完成后，角色只在 channel 中写简短消息：

```text
我完成了 M1-T2 后端 API，实现详情请看 tasks/development/M1-T2-backend-api.md 和 artifacts/M1-T2-backend.md。
```

## 审查和 QA 协议

审查师和 QA 输出结构化结论：

```json
{
  "status": "rejected",
  "blockingIssues": [
    "缺少错误响应映射",
    "未覆盖用户验收路径"
  ],
  "requiredFixes": [
    "补充后端异常处理",
    "增加对应测试"
  ],
  "refs": [
    "artifacts/milestone-001-review.md"
  ]
}
```

`status` 只能是：

```text
approved
rejected
needs_user_decision
```

## 自动提交策略

为了让 git 历史与 workflow 阶段对齐，openplaybook 在两个明确节点会自动 `git commit`，由 `src/commits.ts` 的 `commitWorktreeIfDirty` 完成；commit author 直接表达"谁负责"：

| 触发点 | 责任角色 | commit 信息 |
|---|---|---|
| `subtask_qa` 审核通过（进入 `milestone_review` 之前） | 最近活跃的开发者（按 `sessions/<role>/status.json.lastUpdatedAt` 选 `frontend_developer` 或 `backend_developer`） | `subtask(<owner>): qa passed for <workflow>` |
| `milestone_approval` 用户批准（进入 `done` 之前） | `orchestrator` | `milestone(orchestrator): <workflow>` |
| `requirements_approval / architecture_approval / planning_approval` | —（产物多为 markdown，沿用 `createCheckpoint` 已记录的 HEAD hash） | — |

行为细节：

- 干净 worktree → 返回 `{ committed: false, reason: "clean" }`，不留空 commit。
- 非 git 仓库 → 返回 `{ committed: false, reason: "not_a_git_repo" }`。
- git 失败（hook、merge conflict 等）→ 不抛异常，记录 `git_failed: <detail>`，并在 `control.jsonl` 追加一条系统消息。**不阻断阶段转换**。
- author / email 来自 `ROLE_COMMIT_IDENTITY`，统一使用 `<role>@openplaybook.local`。

## git checkpoint 和阶段回退

openplaybook 可以基于 git branch 或 commit checkpoint 支持阶段回退。

建议只在用户批准过的阶段边界创建 checkpoint：

```text
requirements-approved
architecture-approved
planning-approved
milestone-001-approved
```

checkpoint metadata 示例：

```json
{
  "name": "architecture-approved",
  "phase": "architecture_approval",
  "commit": "abc123",
  "branch": "openplaybook/checkout-redesign/architecture-approved",
  "stateSnapshot": "checkpoints/architecture-approved-state.json",
  "createdAt": "2026-05-18T11:00:00.000Z"
}
```

回退规则：

- 只能回退到用户批准过的 checkpoint。
- 回退前必须提示用户确认。
- 回退代码时必须同步回退 workflow state。
- 回退后，目标 checkpoint 之后的 channel 变为只读历史。
- 回退后，后续阶段角色 session 标记为 `stopped`。
- 回退事件必须写入 `control.jsonl`。
- 不允许自动丢弃用户未确认的工作树变更。

## MVP 边界

第一版不需要自动完成所有复杂调度。

MVP 必须支持：

- 创建 workflow。
- 项目同一时间只允许一个 active workflow。
- 创建 channel JSONL。
- 创建 state.json。
- 生成角色任务文件。
- 用户在 WebUI 中查看 channel。
- 用户在 channel 中 `@角色` 发送消息；控制台始终可 @ orchestrator。
- WebUI 只能查看当前项目 workflow。
- WebUI 能查看后台角色 session 的工作详情（含 transcript / tool events 分页加载）。
- WebUI 提供目录提示面板，向用户解释 `.openplaybook/` 各文件含义。
- 真正的懒启动：角色 session 只在被 @ 时启动。
- Orchestrator 根据状态推进阶段。
- 审查师和 QA 能阻止推进。
- `subtask_qa` 通过与 `milestone_approval` 批准时自动 `git commit`，author 体现责任角色。
- 关闭 workflow 并释放 active workflow 锁。

MVP 暂不支持：

- 并行多 workflow 复杂资源调度。
- 自动解决审查冲突。
- 自动合并多角色代码分支。
- 跨仓库任务执行。
- 自动无确认 git 回退。
