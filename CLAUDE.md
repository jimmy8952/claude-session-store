# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

`ccstore`：零依赖 Node.js CLI（只用内置 `node:sqlite`，要求 Node ≥ 22.13），通过两个 Claude Code hook 实现「同一项目记住最近两轮对话」——SessionEnd 退出时保存快照到 SQLite，SessionStart 下次全新启动时注入。

## 常用命令

```bash
npm test                  # 全部测试（script 已含 --test-concurrency=1，勿去掉）
node --test --test-concurrency=1 test/unit.test.js                    # 单个测试文件
node --test --test-concurrency=1 --test-name-pattern="rewind" test/  # 按名称跑单个测试
ccstore status            # 改动后快速自检
```

无 lint 配置。安装方式：全局以 `npm link` 符号链接安装到 `/opt/homebrew/lib/node_modules/claude-session-store`，hook 经 `~/.claude/settings.json` 的绝对路径调用。**改本目录源码立即全局生效，无需重装**（hook 直接跑源码，改坏会立刻影响所有 Claude 会话，改完先 `npm test`）。恢复复制安装用 `npm install -g .`；`npm link` 前需先 `npm uninstall -g`。

## 架构

两条数据流共享 `~/.claude-session-store/store.db`（SQLite，权限 600）：

**保存路径（SessionEnd）** `hooks.js saveSnapshot()`：`transcript.js` 读会话 JSONL → `activeChain()` 沿 `parentUuid` 从最后一条记录反向走链取当前分支（处理 /rewind 产生的分叉）→ `extractTurns()` 切轮次（`isRealPrompt()` 过滤斜杠命令、system-reminder、注入上下文等伪 prompt）→ `compress.js` 把工具调用压成一行（工具输出永不保留）→ `store.js` 入库；同时 `trim.js` 生成「裁剪版会话」JSONL 写在原会话旁——重接 parentUuid、改写 sessionId、清 toolUseResult、压 tool_result、末尾追加 custom-title 记录，是可 `claude --resume` 的真实会话文件。

**注入路径（SessionStart）** `hooks.js sessionStart()`：按 projectKey 取最新快照 → `render.js` 在 maxChars 内渲染，超长按「旧轮回答 → 最新轮回答 → 用户提问」顺序做中段截断（提问永不截断，只可能整条超预算）→ stdout 输出 `hookSpecificOutput.additionalContext` JSON。

关键机制：

- **projectKey**（`project.js`）：git 仓库根（`git rev-parse --show-toplevel`，2 秒超时），非 git 目录用目录本身。同仓库子目录共享快照。
- **去重**：快照记录全部 prompt UUID；无新 prompt 则跳过保存——「打开没提问就退出」不产生新快照靠它实现。
- **轮次接力**：当前会话不足 N 轮时从上一快照按 promptUuid 携带旧轮；裁剪版会话由 `segmentFromPrevious` + `segmentFromChain` 两段拼接。
- **保留策略**：双层——每项目 `keepPerProject`（50）条数上限（`saveSnapshot` 插入后 `store.prune`）；全库 `maxAgeDays`（30）天滚动窗口，`purgeExpired()` 在每次 SessionEnd 保存路径开头清扫（含删除对应裁剪版文件），`ccstore prune [--days N]` 手动触发。`created_at` 是 ISO 字符串，过期判断直接字典序比较。
- **双表示**：`turns_json`（压缩版，注入用）与 `trimmed_jsonl`（全保真版，`ccstore resume` 用，库里也存一份以便文件被清理后恢复）。
- CLI 命令实现在 `commands.js`，`bin/ccstore.js` 是入口，`install.js` 负责 settings.json 的合并/备份/原子写入（临时文件 + rename）。

## 关键约束

- **hook 绝不能弄坏 Claude Code**：hook 路径出错时 `exit(0)`、所有异常只写 `hook.log`；SessionStart 的 stdout 会被 Claude Code 当 JSON 解析，所以 `node:sqlite` 的 ExperimentalWarning 在 bin 入口就被拦截——任何往 hook stdout 打印内容的新代码都要过 `cli.js` 的同一出口。
- **Claude Code 会话 JSONL 格式无公开文档**（`~/.claude/projects/<非字母数字替换为->/<sessionId>.jsonl`），Claude Code 升级后可能需适配 `transcript.js`/`trim.js`；`test/helpers.js` 的 `Transcript` 类是该格式的可执行参考实现，新 fixture 一律用它构造。
- **maxChars 默认 9000**：Claude Code 2.1.x 对 SessionStart hook 输出上限 10,000 字符，别调大。
- **改 `injectOnClear` 后必须重新 `ccstore install`**（hook matcher 字段会变）。
- 注入文本含 `<ccstore-context` 标记；`transcript.js` 会过滤含此标记的用户消息，防止注入内容被再存为快照——改标记时两处要同步（`render.js` 与 `transcript.js` 的 `CONTEXT_MARKER`）。
- 测试 `sandbox()`（`test/helpers.js`）改写全局 `process.env`（HOME/CLAUDE_CONFIG_DIR/CCSTORE_HOME），这正是 `--test-concurrency=1` 存在的原因；测试不得写死真实 HOME 路径，e2e 测试通过 `runCli` 以子进程方式跑真实 CLI。
- 用户可见文案（帮助、注入文本、压缩行、日志）均为中文，保持一致。
- **`bin/ccstore.js` 必须保留可执行位**：npm link 的 shim 依赖它，Finder 拷贝/移动目录会丢 +x，症状是 `ccstore` 报 permission denied，`chmod +x bin/ccstore.js` 修复。
- **卸载顺序**：先 `ccstore uninstall` 再删全局包，反了的话 hook 指向的脚本不存在，Claude Code 会报 hook 错误（见 README）。

## AOCI 认知层

开始本仓库的任务前，先调用 mcp__aoci__aoci_overview 装载完整项目认知（一次调用约 3000 tokens，经 Challenge 校验）；改动代码收尾时调用 aoci_maintain 维护索引。索引描述与源码冲突时，以源码为准并顺手修索引。
