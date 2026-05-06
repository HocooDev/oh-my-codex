---
name: task-closeout-review
description: 在每次任务结束时执行统一的收尾复核，并按当前用户语言环境输出。显式汇报是否需要更新项目 Memory、全局或项目 Skill、以及相关规则入口。支持 OMX 项目自动检测：若检测到 OMX，Memory 写入 .omx/notepad.md MANUAL section，并评估是否需要更新 AGENTS.md。
---

# Task Closeout Review

## 定位
- 这是一个常驻的任务收尾 Skill。
- 在每次任务结束、准备给出最终回复前，必须执行一次。
- 它负责检查并汇报；对于 OMX 项目，在得到用户批准后可直接写入 memory 和 AGENTS.md。

## 触发规则
- 只要本次请求被当作一个任务处理并准备结束，就必须执行本 Skill。
- 代码修改、文档更新、配置调整、构建测试、排障、调研、方案评审、纯问答结论都要执行。
- 仅对纯寒暄、无任务目标的闲聊可视为不适用。

---

## 第一步：OMX 检测（优先于其他判断）

在执行其他复核前，先判断当前工作目录是否为 OMX 项目：

**检测条件（满足任意一项即为 OMX 项目）：**
- 存在 `.omx/` 目录
- 存在 `.codex/` 目录且内含 OMX 相关文件（`config.toml` 含 `oh-my-codex` / `omx_state` 等标记）
- 当前目录的 `AGENTS.md` 含有 `<!-- OMX:RUNTIME:START -->` 标记

**检测方式：**
```bash
# 检查 .omx 目录是否存在
ls .omx/ 2>/dev/null && echo "OMX detected"

# 或检查 config.toml
grep -l "oh-my-codex\|omx_state" .codex/config.toml 2>/dev/null
```

若检测结果为 OMX 项目，进入 **OMX 分支**；否则进入 **标准分支**。

---

## OMX 分支

### OMX Memory 复核

OMX 项目的持久 Memory 分两层，对应不同的写入策略：

| 层次 | 文件 | 写入时机 | CLI 命令 |
|------|------|---------|---------|
| 会话笔记（手动永久区） | `.omx/notepad.md` `## MANUAL` | 任务产出了跨 session 有价值的结论 | `omx notepad write-manual` |
| 项目事实（项目级） | `.omx/project-memory.json` | 发现了稳定的技术栈、构建命令、关键约束 | `omx project-memory add-directive` / `add-note` |

**判断是否需要写入 MANUAL：**
若本次任务产出了以下任一类内容，建议写入 `notepad.md ## MANUAL`：
- 排障结论或 workaround（下次遇到同类问题可直接复用）
- 需要跨 session 记住的临时约束或决策
- 与 OMX 配置相关的关键发现（如 `models` block 的实际行为）

**写入操作（获得用户批准后执行）：**
```bash
omx notepad write-manual --input '{"content":"[任务日期] 结论摘要"}'
```

**判断是否需要写入 project-memory：**
若发现了项目级稳定事实（技术栈、构建方式、代码约定、长期有效的架构决策），建议写入 `project-memory.json`：
```bash
omx project-memory add-directive --input '{"directive":"...", "priority":"high"}'
omx project-memory add-note --input '{"category":"architecture", "content":"..."}'
```

### OMX AGENTS.md 复核

检查当前项目的 `AGENTS.md`（根目录或 `.codex/AGENTS.md`）：

**若 AGENTS.md 不存在：**
- 汇报「建议执行 `omx agents-init` 初始化项目 AGENTS.md」
- 若得到用户批准，执行：
  ```bash
  omx agents-init
  ```
  并根据本次任务所了解的项目信息，补充项目描述、技术栈、构建命令等内容到生成的文件。

**若 AGENTS.md 已存在：**
- 判断本次任务是否揭示了需要写入 AGENTS.md 的新知识：
  - 新发现的项目约定、关键模块路径、禁止操作
  - 需要所有 session 都遵守的路由规则
  - 新增的 Skill 路由入口
- 若有，生成具体的追加内容（diff 形式），等待用户确认后写入。

**AGENTS.md 内容规范（OMX 项目）：**

生成或追加内容时遵循以下结构：
```markdown
## 项目上下文
- 技术栈：...
- 构建命令：...
- 关键路径：...

## 约定与约束
- ...

## Skill 路由
- 当用户提到 X 时，使用 $skill-name
```

### OMX Skill / Rule 复核

与标准分支相同，判断是否需要新增或更新全局/项目 Skill。

---

## 标准分支（非 OMX 项目）

### 1. Memory 复核
- 若当前项目存在 `./.agent/MEMORY_INDEX.md`，或项目 `AGENTS.md` / `Local_Agent.md` 明确声明它为主入口，则按 Harness-aware 项目处理。
- 若本次任务产出了可复用的项目知识、稳定约束、关键决策、排障结论或长期有效命令，应判断是否建议更新 `MEMORY_INDEX.md` 或 cards。
- 未经用户批准，不得自动写入新结构；只能汇报"建议更新"或"无需更新"。
- 若项目尚未接入 Harness，则应明确汇报 `Memory: 不适用（项目未接入 Harness）`，不得静默跳过。
- 若任务明确涉及旧 `CURSOR_MEMORY.md` / `GLOBAL_MEMORY.md` 迁移，应改为手动读取 `legacy-memory-migration`。

### 2. Skill / Rule 复核
- 若本次任务暴露出可跨项目复用的稳定流程、反复出现的工具坑、需要长期保留的防错约束或可模板化操作，应判断是否建议新增或更新 Skill。
- 若问题本质是 bootstrap、`AGENTS.md`、command、rule 的入口配置缺口，也应归入本项汇报。
- 一次性项目细节、仅当前任务有效的临时信息，不应上升为 Skill。

---

## 输出要求

### 输出语言选择（必须先做）

在生成收尾区块前，先识别当前用户语言环境：

1. 优先使用用户本轮请求的主要语言。
2. 若本轮请求混合多种语言，使用用户任务表达中占主导地位的自然语言。
3. 若无法明确判断，使用最终回复正文采用的语言。
4. 代码标识符、文件路径、命令、`Skill` 名称、`OMX`、`AGENTS.md`、`Notepad (MANUAL)`、`Project Memory` 等专有名词可保持原文。

最终回复中必须追加一个可见区块，该区块不得省略。中文语言环境下标题固定为 `## 任务后复核`，并使用下面的中文固定格式；非中文语言环境下，应使用对应语言的标题、字段名、枚举值和原因说明，并保持字段顺序与语义一致。

**中文 / OMX 项目输出格式：**

```markdown
## 任务后复核
- 已触发 Skill: `task-closeout-review`
- 项目状态: `OMX`
- Notepad (MANUAL): `无需更新` / `建议更新` / `已更新`
- Project Memory: `无需更新` / `建议更新` / `已更新`
- AGENTS.md: `无需更新` / `建议更新` / `已更新` / `建议初始化`
- Skill: `无需更新` / `建议更新` / `已更新`
- 状态: `仅汇报，未执行` / `已执行`
- 原因: 一句话说明判断依据
```

**中文 / 非 OMX 项目输出格式：**

```markdown
## 任务后复核
- 已触发 Skill: `task-closeout-review`
- 项目状态: `Harness-aware` / `非 Harness` / `未确认`
- Memory: `无需更新` / `建议更新` / `已更新` / `不适用`
- Skill: `无需更新` / `建议更新` / `已更新` / `不适用`
- 状态: `仅汇报，未执行` / `已执行`
- 原因: 一句话说明判断依据
```

**English / OMX project output format:**

```markdown
## Task Closeout Review
- Triggered Skill: `task-closeout-review`
- Project status: `OMX`
- Notepad (MANUAL): `No update needed` / `Update recommended` / `Updated`
- Project Memory: `No update needed` / `Update recommended` / `Updated`
- AGENTS.md: `No update needed` / `Update recommended` / `Updated` / `Initialization recommended`
- Skill: `No update needed` / `Update recommended` / `Updated`
- Status: `Report only, not executed` / `Executed`
- Reason: One sentence explaining the decision
```

**English / non-OMX project output format:**

```markdown
## Task Closeout Review
- Triggered Skill: `task-closeout-review`
- Project status: `Harness-aware` / `Non-Harness` / `Unconfirmed`
- Memory: `No update needed` / `Update recommended` / `Updated` / `N/A`
- Skill: `No update needed` / `Update recommended` / `Updated` / `N/A`
- Status: `Report only, not executed` / `Executed`
- Reason: One sentence explaining the decision
```

**其他语言输出格式：**

- 将标题、字段名、状态枚举和原因说明自然翻译为当前用户语言。
- 保持上述模板的字段顺序和语义，不得删减字段。
- 专有名词、代码标识符、路径、命令和 Skill 名称可保持原文。
- 若某个状态枚举难以自然翻译，优先选择简短、明确、可与中文/英文含义一一对应的表达。

- 若本次还实际触发了其他相关 Skill，可在对应语言的 `已触发 Skill` / `Triggered Skill` 字段中并列列出。
- 若已得到用户明确批准并完成了写入，对应字段写为 `已更新` / `Updated` / 对应语言的“已更新”；否则写为 `建议更新` / `Update recommended` / 对应语言的“建议更新”，或 `无需更新` / `No update needed` / 对应语言的“无需更新”。

---

## 执行顺序
1. 临近任务结束时，先回顾本次实际产出与结论。
2. 识别当前用户语言环境，确定收尾区块使用的语言。
3. **执行 OMX 检测**，确定走 OMX 分支还是标准分支。
4. 判断是否需要更新 Memory（OMX：notepad MANUAL + project-memory；标准：MEMORY_INDEX）。
5. （OMX 专属）判断是否需要生成或更新 AGENTS.md。
6. 判断是否需要更新 Skill / command / rule。
7. 如本次任务还要求写工作日志，先完成日志动作，再输出对应语言的收尾复核区块。

## 禁止事项
- 不得因为"没有更新动作"就省略复核区块。
- 不得把"建议更新"伪装成"已更新"。
- 不得未获批准就自动写入任何持久化文件（无论是 OMX 还是标准分支）。
- 不得把 legacy 迁移任务静默并入日常收尾检查。
- OMX 分支中，不得绕过 `omx notepad` / `omx project-memory` CLI，直接操作原始文件。
- 不得在非中文语言环境下强制输出中文字段；中文语言环境仍必须使用既有中文固定格式。
- 不得混用多种自然语言；但代码标识符、路径、命令、Skill 名称和专有名词可保持原文。
