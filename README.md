# claude-session-store

让 Claude Code 在同一个项目里记住你们最近两轮聊了什么。

- **退出时**（SessionEnd hook）：把最近两轮存进本地 SQLite。你的提问和 Claude 的文字回答保留原文，工具调用压缩成一行，例如 `[运行了 Bash: npm test，输出已省略]`。同时生成一个可以 resume 的备用会话，标题为「[裁剪版·最近2轮] …」。
- **启动时**（SessionStart hook）：在同一项目里直接运行 `claude`，最近两轮会作为背景自动注入。
- **同一项目**：按 git 仓库根目录认定；不是 git 仓库就按目录认定。
- 以下情况**不注入**：`claude --resume`、`claude --continue`、会话内 `/resume`、`/clear`、`/compact`，以及项目还没有快照时。
- 打开后**没有提问就退出**：不生成新快照，上一次的记录保留不动。

## 安装

需要 Node.js ≥ 22.13（用到内置的 `node:sqlite`，没有其他依赖）。

```bash
npm install -g claude-session-store        # 或 npm install -g ./claude-session-store-0.1.0.tgz
ccstore install
```

`ccstore install` 会把两个 hook 合并进 `~/.claude/settings.json`。原文件会先备份，其他 hook 不受影响，重复执行也不会重复添加。

## 日常使用

照常运行 `claude` 即可。其他命令：

| 命令 | 作用 |
| --- | --- |
| `ccstore status` | 安装状态、当前项目键、下次启动会不会注入 |
| `ccstore list [--all]` | 当前项目（或全部项目）的快照 |
| `ccstore show [编号]` | 打印将注入的文字，与 Claude 看到的一致 |
| `ccstore show [编号] --ids` | 完整的原始 session ID 和裁剪版 session ID |
| `ccstore resume [编号]` | 打开备用的裁剪版会话（真实历史，可 `/rewind`）；文件已被 Claude Code 清理时会从数据库恢复 |
| `ccstore forget --yes` | 删除当前项目的全部快照 |
| `ccstore save` | 手动为当前目录最近的会话做一次快照（例如安装前已有的会话） |

临时不想带记忆：`CCSTORE_FRESH=1 claude`。完全停用：`CCSTORE_DISABLE=1`，或运行 `ccstore uninstall`。

## 配置

可选，配置文件位于 `~/.claude-session-store/config.json`：

```json
{
  "enabled": true,
  "turns": 2,
  "maxChars": 9000,
  "injectOnClear": false,
  "keepPerProject": 50,
  "writeTrimmedSession": true
}
```

`maxChars` 默认 9000，用来控制注入的长度。你的提问永远不截断，只截 Claude 的回答；如果光提问就超过上限，就原样注入，hook 不会报错。修改 `injectOnClear` 后需要重新运行 `ccstore install`。

## 数据

- `~/.claude-session-store/store.db`：快照表，文件权限 600，可用 `CCSTORE_HOME` 改位置。
- `~/.claude-session-store/hook.log`：hook 日志。hook 出错只写日志，永远不会妨碍 Claude Code 启动或退出。
- 裁剪版会话文件写在原会话旁边（`~/.claude/projects/<目录>/<新ID>.jsonl`），内容也存在数据库里一份。

## 卸载

```bash
ccstore uninstall          # 加 --purge 同时删除 ~/.claude-session-store
npm uninstall -g claude-session-store
```

先运行 `ccstore uninstall` 再删包。顺序反了的话，hook 指向的脚本已不存在，Claude Code 会报 hook 错误。

## 已知限制

- Claude Code 的会话文件格式没有公开文档，升级后可能需要更新本工具。注入方式只读取会话文件，不往里写，所以受格式变化的影响最小。
- 注入的两轮是“背景材料”，不是真实的对话历史；要用真实历史，请用 `ccstore resume`。
- Windows 未测试。
