# claude-session-store 技术设计文档

Nov 19, 2026 · @Pax

## 1. 背景与目标

在同一个项目里每次新开 Claude Code，它都会自动带上最近两轮对话，不用再从头解释。实现方式是：退出时把最近两轮存进本地 SQLite，下次启动时由 SessionStart hook 把它们作为背景注入；同时保留一份可以 `--resume` 的裁剪版会话作为备用。

**目标**

- 退出 Claude Code 时自动保存：原始 session ID、最近两轮的文字记录、一个只含最近两轮的裁剪版 session ID。
- 在同一项目（git 仓库根目录，没有 git 就按目录）下直接运行 `claude`，自动注入最近两轮，用户不需要改变启动习惯。
- 项目没有快照时，`claude` 照常全新启动，不注入任何内容。用 claude --resume、claude --continue 或会话内 /resume 打开的会话一律不注入，因为它们已带有真实历史。
- 打开后没有提问就退出，不生成新快照，不覆盖上一次的记录。
- 工具调用和工具输出压缩成一行，只保留用户提问和 Claude 的文字回答原文。
- 以 npm 包形式发布，`npm i -g` 后运行一次 `ccstore install` 即可生效。

**非目标**

- 不做多台电脑同步，数据只在本机。
- 不做语义摘要或向量检索，存的是原文，不经过模型改写。
- 不改变 Claude Code 自身的会话管理，原始会话文件只读不改。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 轮（turn） | 用户亲手输入的一条提问，加上 Claude 对它的全部回复（含中间的工具调用）。工具结果、斜杠命令及其输出、压缩摘要、hook 注入的内容都不算提问。 |
| 原始会话 | 用户刚刚退出的那个 Claude Code 会话，对应 `~/.claude/projects/<目录>/<session_id>.jsonl`。 |
| 裁剪版会话 | 本工具生成的新会话文件，只含最近两轮，工具输出已压缩，标题带「\[裁剪版·最近2轮\]」，可以用 `claude --resume` 打开。 |
| 快照（snapshot） | 每次退出写入 store 的一条记录：原始 session ID、裁剪版 session ID、两轮内容等。 |
| 项目键（project\_key） | 判断“同一项目”的依据：git 仓库根目录的真实路径；不在 git 仓库里就是启动目录的真实路径。 |
| 注入 | SessionStart hook 输出 `additionalContext`，Claude Code 把它作为系统提醒放进新会话的开头。 |

## 3. 总体架构

整个工具由两个 hook 和一个本地数据库组成，用户日常只用 `claude`，不需要包装命令。

&#91;embedded content: 整体架构 · 退出与启动两条链路\]

退出时 SessionEnd hook 把最近两轮存成快照；启动时 SessionStart hook 按项目键取出最新快照并注入。裁剪版会话只在需要时用 `ccstore resume` 手动打开。

| 组件 | 职责 |
| --- | --- |
| `ccstore hook session-end` | SessionEnd hook 入口：读 transcript、提取两轮、生成裁剪版会话、写快照 |
| `ccstore hook session-start` | SessionStart hook 入口：查最新快照，输出 `additionalContext` |
| `src/transcript.js` | 解析 jsonl、追踪当前分支、识别真实提问、切分轮次 |
| `src/compress.js` | 把工具调用和输出压缩成一行文字 |
| `src/store.js` | SQLite 读写（Node 内置 `node:sqlite`，零依赖） |
| `src/install.js` | 把两个 hook 合并进 `~/.claude/settings.json`，可重复执行，可卸载 |

## 4. 项目识别

项目键优先取 git 仓库根目录，取不到就用启动目录，两者都先转成真实路径。

1. 读 hook 输入里的 `cwd`。
2. 执行 `git -C <cwd> rev-parse --show-toplevel`，超时 2 秒。成功就用它的输出。
3. 失败（不是 git 仓库、没装 git、超时）就用 `cwd`。
4. 用 `fs.realpathSync` 展开符号链接、去掉末尾斜杠，得到 `project_key`。

结果：在 `repo/` 和 `repo/src/` 下启动算同一项目。没建 git 的目录只认完全相同的路径。以后给这个目录 `git init`，项目键不变（根目录就是它自己）。

git worktree 会被当成独立项目，因为 `--show-toplevel` 返回的是工作树自己的路径。这通常是想要的行为：不同分支的对话不串。

启动目录本身（`cwd`）也存进快照，因为裁剪版会话只能在生成它的那个目录下 resume：Claude Code 按启动目录去 `~/.claude/projects/` 下找会话文件。

## 5. 退出流程（SessionEnd）

Claude Code 任何方式结束会话都会触发 SessionEnd，只有“这次有新提问”时才写快照。

hook 从 stdin 收到的 JSON（字段已对照官方文档和本机 Claude Code 2.1.328 核实）：

```json
{"session_id": "...", "transcript_path": "~/.claude/projects/<目录>/<id>.jsonl", "cwd": "/path", "hook_event_name": "SessionEnd", "reason": "prompt_input_exit"}
```

`reason` 可能是 `clear`、`resume`、`logout`、`prompt_input_exit`、`other` 等。所有取值都按同样流程处理：`/clear` 和 `/resume` 切换也意味着一段对话结束了，值得保存。

**步骤**

1. 环境变量 `CCSTORE_DISABLE=1` 时直接退出。
2. 读 transcript，按第 6 节解析出当前分支上的全部轮次。
3. **清扫过期快照**（第 10 节保留策略的时间层）：删除全库超过 `maxAgeDays` 天的快照及其裁剪版文件。放在这一步意味着即使本轮没有新提问、不写快照，清扫也照常执行。
4. **判断有没有新提问。** 一个提问算“新”，当且仅当它的消息 uuid 不在该项目已有快照里。没有新提问就退出，不写任何东西。这同时覆盖了两种情况：打开就退出；用 `ccstore resume` 打开裁剪版后没问任何问题就退出（裁剪版保留了原消息的 uuid）。
5. 按第 7 节得到要保存的两轮。
6. 按第 6 节渲染成文字（工具已压缩）。
7. 按第 9 节生成裁剪版会话文件。
8. 在一个事务里写入快照，然后按保留策略清理该项目的旧快照（条数层）。

SessionEnd 默认只有 1.5 秒预算。安装时给这个 hook 设 `timeout: 30`，Claude Code 会把预算提高到这个值。实际耗时预计在 200 毫秒以内。

hook 永远以退出码 0 结束。出错时只写日志 `~/.claude-session-store/hook.log`，不影响 Claude Code 退出。

## 6. transcript 解析与工具压缩

用户提问和 Claude 的文字回答保留原文，每次工具调用连同输出压成一行，thinking 块不进文字版。

**解析**

1. 逐行读 jsonl，跳过解析失败的行。
2. 从最后一条带 `uuid` 的记录沿 `parentUuid` 往回走，得到当前分支。索引要包含**所有**带 uuid 的记录（`user`、`assistant`、`attachment`、`system`），否则链会在 hook 注入的 attachment 处断掉。
3. 在分支上找真实提问：`type` 为 `user`，不是 `isMeta` / `isCompactSummary`，内容不含 `tool_result`，文字不以 `<command-`、`<local-command-`、`<system-reminder>`、`Caveat:` 开头，也不含本工具的注入标记 `<ccstore-context`。
4. 以每个真实提问为起点切分轮次，直到下一个真实提问为止。

每轮的结构：

```json
{"promptUuid": "...", "sessionId": "...", "at": "2026-11-19T07:30:12Z", "user": "用户提问原文", "items": [{"kind": "text", "text": "Claude 的文字"}, {"kind": "tool", "line": "[运行了 Bash: npm test，输出已省略]"}]}
```

**工具压缩规则**

每个 `tool_use` 按工具名生成一行；对应的 `tool_result` 如果 `is_error` 为真，行尾加「（出错）」，否则丢弃。参数超过 120 字符时截断并加「…」。

| 工具 | 压缩后的一行 |
| --- | --- |
| Bash | `[运行了 Bash: <command>，输出已省略]` |
| Read | `[读取了文件 <file_path>]` |
| Write | `[写入了文件 <file_path>]` |
| Edit / MultiEdit / NotebookEdit | `[编辑了文件 <file_path>]` |
| Grep / Glob | `[搜索了 <pattern>]` |
| WebSearch | `[网页搜索: <query>]` |
| WebFetch | `[打开了网页 <url>]` |
| Task / Agent | `[派出子任务: <description>]` |
| TodoWrite / Task\* | `[更新了任务列表]` |
| 其他（含 MCP） | `[调用了 <工具名>]`，有可读的首个字符串参数就附上 |

**渲染成注入文字**

```text
<ccstore-context project="/path/to/repo" saved="2026-11-19 07:42">
以下是你与用户在本项目中最近 2 轮对话的记录，由 claude-session-store 在上次退出时保存，作为背景参考。工具调用已压缩，工具输出未保留，需要时请重新读取。

### 第 1 轮（2026-11-19 07:30）
用户：...
Claude：...
[运行了 Bash: npm test，输出已省略]
...
</ccstore-context>
```

提示语里的“工具输出未保留，需要时请重新读取”很重要：它让 Claude 知道文件内容可能已变，不会凭记忆改代码。

## 7. 两轮跨会话合并

这次会话不足两轮时，用上一个快照补齐，保证记忆不会退化成只剩一轮。

注入的背景不算真实对话。如果用户启动后只问了一个问题就退出，新会话里只有一轮。合并规则（N = 配置的轮数，默认 2）：

1. `current` = 这次 transcript 当前分支上的全部轮次。
2. `current` ≥ N 轮：取最后 N 轮。
3. `current` < N 轮：从该项目最新快照的轮次里，去掉 `promptUuid` 已在 `current` 里的，取最后 N − len(current) 轮放在前面。
4. 按时间顺序排列，每轮保留自己的 `sessionId`，注入和查看时能看出哪轮来自哪次会话。

示例：上次快照是 \[A, B\]，这次只问了 C，则新快照为 \[B, C\]；这次问了 C、D、E，则新快照为 \[D, E\]。

用 `ccstore resume` 打开裁剪版时，transcript 里本来就有上次的两轮，第 2 条直接满足，不需要合并。

## 8. 启动流程（SessionStart 注入）

只在全新启动时注入（matcher `startup`），文字控制在 9000 字符以内。

**为什么只用 `startup`**

| source | 是否注入 | 原因 |
| --- | --- | --- |
| `startup` | 是 | 全新启动，正是要恢复记忆的场景 |
| `resume` | 否 | 已有真实历史，再注入会重复 |
| `clear` | 否（可配置） | 用户执行 `/clear` 是想要干净的上下文 |
| `compact` | 否 | 压缩摘要已包含之前的内容 |
| `fork` | 否 | rewind 分叉出的会话已有历史 |

**需求：通过 `claude --resume` 启动的会话不注入。** Claude Code 对 `claude --resume <id>`、`claude --resume`（选择列表）、`claude --continue` 以及会话内 `/resume` 切换，都以 `source: "resume"` 触发 SessionStart。hook 有两层保证：安装时 matcher 只写 `startup`，resume 根本不会调用本工具；hook 代码里也再检查一次 `source`，不是 `startup`（或配置允许的 `clear`）就直接退出。`ccstore resume` 内部同样走 `claude --resume`，所以打开备用裁剪版时也不会重复注入。

**步骤**

1. `CCSTORE_FRESH=1` 或 `CCSTORE_DISABLE=1` 时不输出任何内容。
2. 算出项目键，查该项目 `created_at` 最新的一条快照。
3. 没有快照：不输出，Claude Code 正常全新启动。
4. 有快照：用存的两轮重新渲染（保证当前的 `maxChars` 配置生效），输出：

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "<ccstore-context ...>...</ccstore-context>"}}
```

**长度控制**

本机 Claude Code 2.1.328 的代码里，SessionStart hook 如果输出纯文字，超过 10,000 字符的部分会被截掉并标注“还有未显示内容”；本工具输出的是 JSON（additionalContext），在这个版本里没有找到对它的截断，超长时大概率原样注入。默认 `maxChars` 设为 9000，留出余量。超出时按以下顺序缩减，直到放得下：

1. **用户提问永远不截断。** 只截 Claude 的回答。
2. 先截上一轮的回答，再截最新一轮的回答：保留开头约 60% 和结尾约 40%，中间替换为「…（中间省略 N 字）…」，每个回答最少保留 300 字。
3. 两个回答都截到 300 字后仍然超出，就把回答整段替换为「（回答过长，已省略）」，同样先上一轮、后最新一轮。
4. 如果只是两个提问本身就超过上限，不再做任何截断，原样输出并在 `hook.log` 里记一条提示；hook 正常结束、不报错，是否截断交给 Claude Code 决定（当前版本对 JSON 输出未见截断）。

工具行本身很短，先合并连续的同类行（如「\[读取了 5 个文件: a.ts, b.ts …\]」），再考虑截断正文。

**跳过注入**

- 临时不要记忆：`CCSTORE_FRESH=1 claude`。
- 长期关闭：`ccstore uninstall`，或配置里设 `"enabled": false`。
- 当前项目不再使用：`ccstore forget`，删除该项目的全部快照。

## 9. 备用裁剪版会话

每次写快照时同时生成一个只含最近两轮的会话文件，标题写明「\[裁剪版·最近2轮\]」，用 `ccstore resume` 打开。

**生成**

1. 从当前分支的倒数第 N 个真实提问开始截取到末尾，包含其间的 attachment、system 记录。
2. 若按第 7 节用到了上一个快照的轮次，就从上一个裁剪版的 jsonl 里取出对应轮次的记录拼在前面，并把后一段第一条的 `parentUuid` 改指向前一段的最后一条。
3. 第一条记录的 `parentUuid` 设为 `null`。
4. 每条记录的 `sessionId` 换成新生成的 UUID；消息自身的 `uuid` 不变，用于第 5 节的“新提问”判断。
5. 压缩工具：`tool_result` 的内容替换为第 6 节的那一行文字，保留 `tool_use_id` 和 `is_error`，保证调用与结果仍然配对；`tool_use` 的字符串参数超过 500 字符时截断（如 Write 的整个文件内容）。记录里附带的 `toolUseResult` 字段删除。
6. thinking 块原样保留，因为它带签名，改动可能导致 API 拒绝。

**标注**

- 文件末尾追加 `{"type":"custom-title","customTitle":"[裁剪版·最近2轮] <最后一个提问的前 40 字>","sessionId":"<新 ID>"}`。Claude Code 用 `/rename` 时写的就是这种记录（已在本机 2.1.328 核实），在 `/resume` 列表里会显示这个标题。
- store 里该字段叫 `trimmed_session_id`，`ccstore list` 中标为「裁剪版」。

**存放与恢复**

- 文件写在原始 transcript 所在目录（`dirname(transcript_path)`），这样在同一启动目录下 `claude --resume <id>` 就能找到。
- 内容同时存进数据库。Claude Code 默认会清理较旧的会话文件（`cleanupPeriodDays`），`ccstore resume` 发现文件不在时从数据库写回原位。
- `ccstore resume [快照编号]`：切到快照记录的 `cwd`，确保文件存在，然后执行 `claude --resume <trimmed_session_id>`。不带编号时取当前项目最新一条。

## 10. 数据存储

一个 SQLite 文件、一张快照表，用 Node 内置的 `node:sqlite`，不依赖任何需要编译的原生模块。

**位置**

- 目录：`~/.claude-session-store/`，可用环境变量 `CCSTORE_HOME` 覆盖。放在 `~/.claude` 外面，避免被 Claude Code 的清理逻辑或卸载流程波及。
- 文件：`store.db`（权限 600，只有当前用户可读）、`config.json`、`hook.log`。
- 打开时设 `journal_mode=WAL`、`busy_timeout=5000`，两个 Claude 窗口同时退出也不会报锁错误。

**表结构**

```sql
CREATE TABLE snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key        TEXT NOT NULL,   -- git 根目录或启动目录（真实路径）
  cwd                TEXT NOT NULL,   -- 实际启动目录，resume 裁剪版时要切回这里
  source_session_id  TEXT NOT NULL,   -- 退出时的原始 session ID
  source_transcript  TEXT NOT NULL,   -- 原始 jsonl 路径
  trimmed_session_id TEXT NOT NULL,   -- 裁剪版·最近 N 轮的新 session ID
  trimmed_transcript TEXT NOT NULL,   -- 裁剪版 jsonl 路径
  trimmed_jsonl      BLOB NOT NULL,   -- 裁剪版文件内容，文件被清理后用于恢复
  turns_json         TEXT NOT NULL,   -- 结构化的轮次（第 6 节格式）
  turn_count         INTEGER NOT NULL,
  prompt_uuids       TEXT NOT NULL,   -- 本快照涵盖的提问 uuid，JSON 数组
  end_reason         TEXT,            -- SessionEnd 的 reason
  claude_version     TEXT,
  created_at         TEXT NOT NULL    -- ISO 8601
);
CREATE INDEX idx_snapshots_project ON snapshots(project_key, created_at DESC);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version 等
```

注入文字不单独存，每次从 `turns_json` 现渲染，改配置后立即生效。

“新提问”判断（第 5 节）查的是该项目全部快照的 `prompt_uuids`。

**保留策略**：双层，防止 `store.db` 和裁剪版文件无限增长。

- **条数层**：每个项目保留最近 50 条快照（`keepPerProject`），写入快照后由 `Store.prune()` 执行。这一层按条数裁剪时**不删** `~/.claude/projects/` 里的裁剪版文件，让 Claude Code 自己清理。
- **时间层**：全库删除 `created_at` 早于 `now - maxAgeDays`（默认滚动 30 天）的快照，由 `purgeExpired()` 执行。触发点在 SessionEnd 保存路径的第 3 步——每次会话结束都清扫，即使本轮没写快照；`ccstore prune [--days N]` 可随时手动触发。这一层**连同被删快照的裁剪版会话文件一并删除**（路径在行的 `trimmed_transcript` 字段里，文件缺失不报错），否则这些文件会泄漏。
- 过期判断不对 `created_at` 做日期解析：写入和 cutoff 都用 `Date.prototype.toISOString()`，ISO 8601 字符串字典序即时间序，SQL 里直接 `<` 比较。

**配置 `config.json`**

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `turns` | `2` | 保存和注入的轮数 |
| `maxChars` | `9000` | 注入文字上限 |
| `injectOnClear` | `false` | `/clear` 后是否也注入 |
| `keepPerProject` | `50` | 每个项目保留的快照数 |
| `maxAgeDays` | `30` | 快照最长保留天数（滚动窗口），过期即连裁剪版文件一起删除 |
| `writeTrimmedSession` | `true` | 是否生成备用裁剪版会话 |

## 11. CLI 命令

命令名 `ccstore`。日常不需要用它，它只用于安装、查看和备用恢复。

| 命令 | 作用 |
| --- | --- |
| `ccstore install` | 把两个 hook 合并进 `~/.claude/settings.json`，先备份原文件；重复执行不会重复添加 |
| `ccstore uninstall` | 只删除本工具添加的 hook，不动其他配置；加 `--purge` 同时删除数据目录 |
| `ccstore status` | 安装状态、Node 版本、数据库位置、当前目录的项目键、下次启动会不会注入 |
| `ccstore list [--all]` | 当前项目的快照列表（编号、时间、轮数、原始 ID、裁剪版 ID、最后一个提问）；`--all` 列出所有项目 |
| `ccstore show [编号]` | 打印注入文字，和 Claude 看到的一致；默认最新一条 |
| `ccstore resume [编号]` | 打开备用裁剪版会话（第 9 节） |
| `ccstore forget [--yes]` | 删除当前项目的全部快照 |
| `ccstore prune [--days N]` | 立即执行保留策略的时间层：删除超过 N 天（默认取 `maxAgeDays`）的快照及其裁剪版文件 |
| `ccstore save` | 手动对当前目录最近的会话做一次快照，用于安装前已有的会话 |
| `ccstore hook <session-end\|session-start>` | 内部入口，由 hook 调用 |

`install` 写入的 hook 使用绝对路径（`process.execPath` + 脚本路径），不依赖 hook 运行时的 PATH，用 nvm 的环境也能正常工作：

```json
{
  "hooks": {
    "SessionStart": [{"matcher": "startup", "hooks": [{"type": "command", "command": "\"/usr/local/bin/node\" \"/usr/local/lib/node_modules/claude-session-store/bin/ccstore.js\" hook session-start", "timeout": 10}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "\"/usr/local/bin/node\" \"/usr/local/lib/node_modules/claude-session-store/bin/ccstore.js\" hook session-end", "timeout": 30}]}]
  }
}
```

每条命令都带 `ccstore` 标记，卸载时靠它识别。`injectOnClear` 为真时 matcher 写成 `startup|clear`。

## 12. npm 包结构、安装与卸载

包名 `claude-session-store`，零运行时依赖，要求 Node.js ≥ 22.13（`node:sqlite` 从这个版本起不再需要启动参数）。

```text
claude-session-store/
├── package.json          # bin: { ccstore: bin/ccstore.js }, engines: node >=22.13
├── README.md
├── bin/ccstore.js        # CLI 入口，分发子命令
├── src/
│   ├── paths.js          # 数据目录、配置、日志
│   ├── project.js        # 项目键
│   ├── transcript.js     # 解析、分支、轮次
│   ├── compress.js       # 工具压缩
│   ├── render.js         # 注入文字与长度控制
│   ├── trim.js           # 裁剪版 jsonl
│   ├── store.js          # SQLite
│   ├── hooks.js          # session-end / session-start
│   ├── install.js        # settings.json 合并与卸载
│   └── commands.js       # list / show / resume / forget / status / save
└── test/                 # node:test 单元测试 + 假 HOME 端到端测试
```

**安装**

```bash
npm install -g claude-session-store
ccstore install
```

不在 `postinstall` 里自动改 `settings.json`：npm 的安装脚本在很多环境下被禁用，而且静默修改用户配置不好。`ccstore install` 会打印它改了什么、备份在哪。

发布前也可以本地安装：`npm install -g ./claude-session-store-0.1.0.tgz`。

**升级**：`npm update -g claude-session-store` 后再运行一次 `ccstore install`，刷新 hook 里的绝对路径。

**卸载**

```bash
ccstore uninstall          # 加 --purge 同时删除 ~/.claude-session-store
npm uninstall -g claude-session-store
```

顺序很重要：先 `ccstore uninstall` 再删包。如果先删了包，hook 指向的脚本不存在，Claude Code 会在启动和退出时报 hook 错误（不影响使用），重新安装后运行 `ccstore uninstall` 即可清除。

## 13. 边界情况与错误处理

任何错误都不能阻碍 Claude Code 启动或退出：hook 永远退出码 0，错误写进 `hook.log`。

| 情况 | 处理 |
| --- | --- |
| 打开后没提问就退出 | 没有新提问，不写快照 |
| resume 裁剪版后没提问就退出 | 提问 uuid 都已在快照里，不写快照 |
| 用 `claude --resume` / `--continue` 启动 | source 为 `resume`，不注入 |
| 项目没有任何快照 | 不注入，正常全新启动 |
| 会话里用过 rewind | 只取最后一条记录所在的分支 |
| 会话中发生过 `/compact` | 压缩摘要不算提问；若压缩后不足两轮，按第 7 节用旧快照补齐 |
| 两个窗口同一项目先后退出 | 各写一条快照，后退出的成为最新；WAL + busy\_timeout 避免锁冲突 |
| transcript 不存在或为空 | 记日志，跳过 |
| transcript 里有解析不了的行 | 跳过该行，继续 |
| 单轮内容超长 | 按第 8 节保留头尾截断，数据库里仍存完整文字 |
| 非交互模式 `claude -p` | 同样会触发 hook；默认跳过，识别方式是 transcript 里的 `entrypoint` 标记为 `sdk-*`，避免脚本调用覆盖交互记忆 |
| 子代理（subagent）会话 | 只处理主会话的 transcript，子代理 transcript 不读 |
| Node 版本过低 | `ccstore install` 拒绝安装并提示；已装的 hook 在启动时发现版本不对就静默退出 |
| 数据库损坏 | 重命名为 `store.db.corrupt-<时间>`，新建空库，记日志 |

## 14. 测试计划

全部用 `node --test` 运行，端到端测试把 `HOME` 和 `CCSTORE_HOME` 指向临时目录，不碰真实配置。

| 类别 | 用例 |
| --- | --- |
| 解析 | 普通会话切轮；工具结果不算提问；斜杠命令、system-reminder、压缩摘要、注入标记不算提问；rewind 后只取当前分支；链上夹着 attachment 时不断链；坏行被跳过 |
| 压缩 | 表中每种工具的输出行；出错标注；参数截断；连续同类行合并 |
| 渲染 | 不超 `maxChars`；截断顺序符合第 8 节；开头带 `<ccstore-context` 标记 |
| 合并 | 上次 \[A,B\] + 这次 \[C\] → \[B,C\]；这次 \[C,D,E\] → \[D,E\]；去重 |
| 裁剪版 | 首条 `parentUuid` 为 null；`sessionId` 全部替换；tool\_use 与 tool\_result 一一配对；末尾有 custom-title；跨快照拼接后链完整 |
| 项目键 | git 子目录 → 根目录；非 git 目录 → 自身；符号链接展开 |
| SessionEnd | 有新提问写快照；无提问不写；resume 裁剪版后无提问不写；`-p` 会话跳过；异常时退出码仍为 0 |
| 保留 | cutoff 边界两侧的行删留正确；过期行连同裁剪版文件删除、未过期不动；同一批数据二次清扫为空操作；裁剪版文件已缺失不报错；`prune --days` 非法参数退出码 1；`status` 显示保留策略 |
| SessionStart | `startup` 且有快照 → 输出 JSON；`resume` / `clear` / `compact` / `fork` → 无输出；无快照 → 无输出；`CCSTORE_FRESH=1` → 无输出 |
| 安装 | 空 settings 文件；已有其他 hook 时合并不覆盖；重复安装不重复；卸载只删自己的；备份文件存在 |
| 实机验证 | 用本机真实的 `claude` 跑一遍：提问两次 → 退出 → 重新启动，确认 Claude 能说出上次聊了什么；`ccstore resume` 能打开裁剪版 |

## 15. 风险与限制

最大的风险是 Claude Code 的会话文件格式没有公开文档，升级后可能变化；注入方式只读不写，受影响最小。

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| transcript 格式变化 | 提取不到轮次，或裁剪版无法 resume | 解析集中在 `transcript.js`；每条快照记录 `claude_version`；提取失败只跳过不报错 |
| SessionStart 输出上限变化（当前 10,000 字符） | 注入被截断 | `maxChars` 可配置，默认留 10% 余量 |
| `custom-title` 记录不被识别 | `/resume` 列表里看不到「裁剪版」标题 | `ccstore list` 始终标注；标题不影响 resume 本身 |
| `node:sqlite` 仍是实验特性 | 每次运行打印 ExperimentalWarning；API 将来可能小改 | 启动时屏蔽该警告；数据库访问集中在 `store.js` |
| 注入的是“读到的历史”而非真实对话 | 不能 `/rewind` 到那两轮；工具输出已丢，Claude 需要重新读文件 | 提示语明确告知；需要真实历史时用 `ccstore resume` |
| 对话内容存在本地数据库 | 与 `~/.claude/projects/` 一样是明文 | 文件权限 600；`ccstore forget` 和 `uninstall --purge` 可删除 |
| 用户曾在其他地方调用 Claude（如 IDE 插件） | IDE 里的会话也会触发 hook，可能成为最新快照 | 这符合“同一项目记住最近对话”的目标；如需区分，可后续按 `entrypoint` 过滤 |

**不支持**：Windows 暂不保证（路径和 shell 引号未测试）；多台电脑同步。
