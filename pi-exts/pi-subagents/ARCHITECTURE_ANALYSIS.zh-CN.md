# pi-subagents 工作原理分析

> 分析对象：当前源码 checkout，版本 `0.84.0`，提交 `a37a2885`。
> 本文基于 README、`docs/`、内置 Agent 定义和核心 TypeScript/JavaScript 源码的静态阅读，聚焦主要执行链路，不逐项展开所有附加功能。

## 一句话概括

**父 Pi 会话仍然是总决策者；pi-subagents 负责把一次 `subagent` 工具调用变成独立的子 Pi Session，并管理它的上下文、工具权限、执行进程、工作流、状态和结果回收。**

它不是安装后自动在后台审查代码的独立服务，也不是用正则表达式把自然语言转发给固定脚本的简单 wrapper，而是一套完整的子代理运行时与编排系统。

## 总体数据流

```text
用户自然语言
    │
    ▼
父 Pi 模型决定调用 subagent
    │
    ▼
参数校验、Agent 解析、模型/工具/上下文规划
    │
    ├── 单个子代理
    │      ├── async:false → 父进程内创建子 Pi Session
    │      └── async:true  → detached runner 进程内创建子 Pi Session
    │
    └── Workflow
           → 受限 JavaScript 沙箱
           → runs.run / runs.all 通过 IPC 请求宿主
           → 最终仍走上面的子代理执行链路
    │
    ▼
子代理事件 → 状态文件 / 日志 / TUI
子代理结果 → result watcher → 唤醒父 Pi → 父模型汇总
```

## 1. 安装与加载

主要入口：

- `package.json`
- `index.ts`
- `src/extension/index.ts`

`package.json` 声明 Pi 需要加载的资源：

```json
{
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

加载后，扩展主要注册：

- `subagent`：启动和管理子代理。
- `subagents_enable`：按需启用完整工具。
- `bg_wait`：等待没有原生完成通知的后台工作。
- `contact_supervisor` / `subagent_supervisor`：父子代理协调。
- 一组 `/subagents-*` 命令。
- FleetView、状态 widget、结果 watcher。
- 内置 agents、skills 和 prompt templates。

`index.ts` 会检查 `PI_SUBAGENT_CHILD`。在普通子代理环境中，它不会再次加载完整的父级扩展，避免每个子代理都递归带上一整套 UI、watcher 和编排运行时。被明确允许继续 fanout 的子代理，则通过专门的 child hooks 获得受限的 `subagent` 工具。

### 为什么有 `subagents_enable`

当前版本为了降低初始工具 schema 成本并照顾 prompt cache，新会话有时先只暴露一个很小的 `subagents_enable` 工具。

父模型在获得委派授权后调用它，下一次模型请求才会看到完整的 `subagent` 工具。它只启用工具，**不会启动任何子代理**。

设计上，只有用户当前请求或适用的用户/项目指令授权后才会委派；任务复杂、文件较多或存在专业角色，本身并不构成自动委派的理由。

## 2. Agent 是子会话配置，不是独立程序

内置角色位于 `agents/*.md`，例如：

- `agents/scout.md`
- `agents/worker.md`
- `agents/reviewer.md`
- `agents/oracle.md`

每个 Agent 基本由两部分组成：

```markdown
---
name: reviewer
tools: read, grep, find, ls, watchdog_diff, contact_supervisor
thinking: high
systemPromptMode: replace
---

You are a disciplined review subagent...
```

即：

```text
YAML frontmatter：模型、工具、权限、上下文、输出等配置
                +
Markdown 正文：这个角色自己的 system prompt
```

发现与合并逻辑主要位于 `src/agents/agents.ts`，优先级大致为：

```text
内置 Agent < 包提供 Agent < 用户 Agent < 项目 Agent < 运行时 Agent
```

因此，同名项目 Agent 可以覆盖内置 Agent。

典型角色：

| Agent | 作用 | 主要特征 |
|---|---|---|
| `scout` | 快速侦察代码库 | 输出压缩后的代码上下文，供后续角色使用 |
| `worker` | 实现和修复 | 有编辑工具，默认 fresh context |
| `reviewer` | 只读代码审查 | 不修改仓库，强调证据和 findings |
| `oracle` | 决策复核 | 默认 fork context，检查决策漂移和隐藏假设 |
| `delegate` | 通用委派 | 行为更接近父会话 |

是否使用 `reviewer`、`scout` 或 `worker`，不是扩展用正则解析自然语言决定的，而是父模型根据工具说明、Agent catalog 和用户请求决定的。

## 3. 单个子代理的执行链路

核心调用链：

```text
src/extension/index.ts
  → executePublic()
  → src/runs/foreground/subagent-executor.ts
  → runSinglePath() 或 runAsyncPath()
  → buildInProcessChildLaunch()
  → childSessionFactory.create()
  → Pi SDK createAgentSession()
```

关键模块：

| 文件 | 职责 |
|---|---|
| `src/extension/index.ts` | 工具注册、生命周期、事件、UI 和 watcher 接线 |
| `src/runs/foreground/subagent-executor.ts` | 公共参数规范化、管理动作和总执行路由 |
| `src/runs/shared/child-launch.ts` | 生成子代理启动计划和运行时配置 |
| `src/runs/shared/child-session.ts` | 包装 Pi SDK 的 AgentSession |
| `src/runs/foreground/execution.ts` | 前台运行、事件处理、输出和验收 |

启动前会解析：

- Agent 和模型。
- system prompt、skills、memory。
- 工作目录或独立 worktree。
- 可用工具和扩展。
- fresh/fork 上下文。
- 超时、预算、输出 schema、acceptance gate。
- 是否允许继续创建下一级子代理。

随后通过 Pi SDK 创建一个新的 `AgentSession`，并发送类似下面的任务：

```text
Task: <父代理交给它的任务>
```

运行时会订阅子 Session 的事件，收集：

- 助手消息。
- 工具调用及输出。
- token 和费用。
- 当前进度。
- 错误和中断状态。
- session/transcript 文件。

最后提取最终回答，处理输出文件、结构化结果和验收检查，再返回给父会话。

### fresh 与 fork

| 模式 | 含义 |
|---|---|
| `fresh` | 子代理只看到角色提示和任务 brief，是“冷启动”。 |
| `fork` | 从父 Session 分叉，继承父会话历史，再追加子代理任务。 |

`fork` 不是实时共享内存，而是**启动时复制/分叉历史**。代码还尽量保留父请求的 prompt 前缀，以复用模型 provider 的 prompt cache。

默认情况下，子代理没有 `subagent` 工具，不能无限创建下一级代理。只有显式授权并拥有相应工具时才可以，而且还受 nesting depth、capability ceiling 和 fanout budget 限制。

## 4. 前台与后台执行

| 特性 | `async:false` | `async:true`（当前默认，可配置） |
|---|---|---|
| 子 Session 所在进程 | 父 Pi 进程 | detached runner 进程 |
| 父工具调用 | 等子代理完成 | 启动后立即返回 run id |
| 结果返回 | 直接作为工具结果 | 稍后通过完成通知进入父会话 |
| 进度展示 | 当前对话内流式更新 | 状态文件、FleetView、async widget |
| 适用场景 | 后续步骤必须立刻等待结果 | 并行审查、后台研究、长任务 |

前台子代理不会自动继承父会话的全部 ambient extensions，只加载解析后的子代理扩展和 hooks；父进程注册的模型 providers 则可以按实现继承。

### 后台执行过程

相关代码：

- `src/runs/background/async-execution.ts`
- `src/runs/background/subagent-runner-bootstrap.ts`
- `src/runs/background/subagent-runner.ts`

主要过程：

1. 父进程把完整的运行配置序列化成 JSON。
2. `spawnRunner()` 启动一个脱离父进程生命周期的 runner。
3. 父进程 `unref()` runner，并立即返回类似 `Async: reviewer [<run-id>]` 的启动回执。
4. runner 使用同一套 `ChildSessionFactory` 创建子 Pi Session。
5. runner 持续写入运行产物：

   ```text
   status.json
   events.jsonl
   output-<n>.log
   subagent-log-<id>.md
   ```

6. 完成后写出结果文件。
7. 父进程的 `result-watcher.ts` 通过 `fs.watch` 或轮询发现结果。
8. `notify.ts` 调用 Pi 的 `sendMessage()`，生成 `subagent-notify` 消息并按需唤醒父模型。
9. 父模型读取结果，继续汇总、修复或向用户报告。

因此，它不是每个子代理都启动一次 `pi` CLI。准确地说：

> 每个独立后台 run 有一个 runner host；原生 Pi 子 Session 在这个 runner 内通过 SDK 创建，同一个 run 的多个 Session 可以共享该 host。

文件既是状态存储，也是跨进程通信机制，不需要额外运行一个中央服务器。

## 5. Workflow 的串行与并行编排

核心文件：

- `src/workflows/scripted-workflow.ts`
- `src/workflows/workflow-script-worker.ts`
- `workflow-script-process.cjs`
- `workflow-script-worker.cjs`

示例：

```js
const scan = await runs.run("scan", {
  agent: "scout",
  task: "Analyze auth flow"
});

const reviews = await runs.all([
  { key: "correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
  { key: "tests", agent: "reviewer", task: "Review tests: " + scan.output }
]);

return reviews.map(result => result.output);
```

执行分为两层。

### 沙箱层

脚本先由 Acorn 做静态校验，然后在受限 JavaScript 环境中执行。

Node 下会启动权限受限的进程和 worker：

- 没有普通文件系统访问。
- 没有宿主全局对象。
- 不能随意 `import()`。
- 不能直接调用任意 Pi 工具。
- 只能通过受控 API 与宿主通信。

### 宿主层

脚本中的 `runs.run(...)` 和 `runs.all(...)` 会变成 IPC 消息发给宿主。宿主收到后：

- `runs.run`：调用一次相同的子代理 executor。
- `runs.all`：批量启动并等待多个子代理。
- 串行依赖：由普通 JavaScript `await` 控制。
- 并行：由 Promise 和批量 launch 控制。
- 结果：转换成 plain JSON 再送回脚本。
- 稳定 key：用于跟踪结果、识别重复调用以及中断后的复用。

因此，workflow 并没有另一套子代理实现：

> **Workflow 只是编排器，真正干活的仍然是统一的 child executor。**

`workflow: "parallel"` 是预置的 named workflow resource，本质上相当于扩展已经写好的 `runs.all()` 模板；`workflow: true` 和脚本文件路径则允许调用方提供自己的编排逻辑。

## 6. 父子控制与协调

### 父控制子：steer / interrupt / stop

相关代码：

- `src/runs/background/control-channel.ts`
- `src/runs/background/subagent-runner.ts`

父侧把控制请求原子写入 run 目录：

```text
control-inbox/
  steer-requests/
  stop-requests/
  interrupt.json
```

runner 监听这些文件，然后调用子 Session 的：

- `steer()`：运行中插入指导。
- `followUp()`：排队后续消息。
- `abort()`：中断或停止。

`resume` 利用保留下来的 Session 文件和 recovery descriptor 继续原子会话，而不是简单把旧文本复制给一个全新的代理。

### 子请求父：contact_supervisor

相关代码：

- `src/intercom/native-supervisor-channel.ts`

子代理调用：

```text
contact_supervisor({ reason: "need_decision", ... })
```

会写入 request 文件并等待 reply。父侧 watcher 发现后唤醒父 Pi，父模型通过下面的工具写回答案：

```text
subagent_supervisor({
  action: "reply",
  replyTo: "<request-id>",
  message: "..."
})
```

请求绑定到具体的父 Session 和子 run，因此同一目录里的另一个 Pi 会话不会误收这些请求。

`steer` 与 supervisor reply 不是一回事：前者是父对子的运行指导，后者是对子代理某个明确请求的关联答复。

## 7. 一次 reviewer 调用的完整例子

假设父模型调用：

```json
{
  "agent": "reviewer",
  "task": "Review this diff"
}
```

实际发生的是：

1. 找到 `agents/reviewer.md`。
2. 生成只读的 system prompt 和工具计划。
3. 创建独立 run id、Session 路径和运行目录。
4. 默认启动 detached runner，并立即给父模型返回启动回执。
5. runner 创建 reviewer 的独立 Pi Session。
6. reviewer 使用 `read/grep/find/ls` 等工具审查代码。
7. 工具调用和进度写入事件、日志和 `status.json`。
8. FleetView 读取状态并展示，不必每次把完整进度塞进父模型上下文。
9. reviewer 结束后产生最终结果。
10. 父进程 watcher 发现结果并唤醒父 Pi。
11. 父模型决定直接汇报、让 worker 修复，或再做一轮复审。

如果改成并行审查，则父模型提交一个 parallel workflow，多个 reviewer 通过 `runs.all` 批量启动；每个 reviewer 仍有自己的上下文、工具权限、Session 和结果。

## 8. 主源码地图

| 目录或文件 | 主要职责 |
|---|---|
| `index.ts` | 包入口、版本检查、父子运行模式选择 |
| `src/extension/` | Pi 工具注册、schema、配置、激活和扩展生命周期 |
| `src/agents/` | Agent 发现、覆盖、prompt、skills、memory 和运行时注册 |
| `src/runs/foreground/` | 前台执行路由、事件流和结果处理 |
| `src/runs/background/` | detached runner、状态、控制、结果和恢复 |
| `src/runs/shared/` | 前后台共用的 Session、工具计划、权限、输出和 worktree 逻辑 |
| `src/workflows/` | 脚本校验、沙箱 IPC、串并行编排和 workflow receipt |
| `src/intercom/` | 原生 supervisor 请求/回复通道 |
| `src/tui/` | FleetView、进度和 transcript 渲染 |
| `src/missions/` | 持久化任务记录、计划和调度 |
| `src/watchdog/` | 可选的对抗性变更审查与子代理监督 |
| `agents/` | 内置角色定义 |
| `prompts/` | 可复用的编排提示模板 |
| `skills/` | 面向父模型的使用规则和编排指导 |

## 9. 外围能力与主链路的关系

以下功能很重要，但不是理解核心机制的前置条件：

- **Worktree**：隔离多个写入型子代理的工作目录，减少并发修改冲突。
- **Acceptance / structured output / gate**：不只相信子代理一句“完成了”，而是检查输出、文件或验证命令等证据。
- **Watchdog**：可选的变更审查和运行监督，不是默认后台自动审查器。
- **Missions / schedules**：持久化任务记录、定时和周期执行。
- **External CLI runners**：通过 adapters 接入 Claude Code、Codex、Cursor 等外部执行器，并复用 Pi 的 run/status/result 模型；它们不等同于原生 Pi 子 Session。
- **TUI / observability**：读取状态与事件产物，提供 Fleet、transcript、stop/steer 等操作界面。

## 结论

最核心的理解可以压缩成五句话：

1. **父 Pi 是 orchestrator，子代理是独立 Pi Session。**
2. **Agent Markdown 决定“它是谁、能用什么工具”，executor 决定“它怎样运行”。**
3. **前台复用父进程，后台使用 detached runner；两者复用同一个 Session 抽象。**
4. **Workflow 沙箱只负责编排，真正的子代理启动仍回到统一 executor。**
5. **文件产物负责跨进程状态与控制，Pi 消息机制负责把完成结果重新交还给父模型。**
