# AGENT-OPS — aw-webui 补丁项目双机操作手册

本手册供两台机器上的 AI agent 使用。**先认角色，再干活。**

## 角色判定

| 你在哪台机器 | 你的角色 |
|---|---|
| QBZdeMacBook-Air（本仓库有 `src/`、`scripts/`、`package.json` 的 clone） | **机器 A = 开发机**：改代码、构建、发布 |
| 其他机器（clone 的是 `dist` 分支，目录里只有静态文件 + 本文件） | **机器 B = 消费机**：拉取、部署、验证，**不改代码** |

仓库坐标：上游 `ActivityWatch/aw-webui`；fork `Q-Ze/aw-webui`（分支 `feat/visualization-refresh` = 源码；分支 `dist` = 构建产物，**单提交强推**，无历史）。

服务链（两机同构）：`ActivityWatch.app → aw-qt → wrapper 脚本 → aw-server-rust --webpath <dist目录> → http://127.0.0.1:5600`

---

## 机器 A（开发机）agent 职责

目录：`~/aw-webui-patched/src`（源码仓库）、`~/aw-webui-patched/dist`（本机生产产物）、`/opt/homebrew/bin/aw-server-patched`（wrapper）。

### 开发循环

```sh
cd ~/aw-webui-patched/src
# 1. 改代码
# 2. lint（规则见下）
npx eslint --fix <改动的文件>
# 3. 测试（views.test.node.ts 有 1 个既有环境失败，可忽略）
npx jest
# 4. 构建
npm run build
# 5. 本机部署（三步，不要手动跑 aw-server！）
rm -rf ~/aw-webui-patched/dist && cp -a dist ~/aw-webui-patched/dist
pkill -TERM -x aw-qt; sleep 3; open -a ActivityWatch; sleep 8
# 6. 验证
diff <(curl -s http://127.0.0.1:5600/) ~/aw-webui-patched/dist/index.html  # 应无差异
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5600/api/0/info    # 应 200
# 7. 提交
git add -A && git commit -m "..." && git push fork feat/visualization-refresh
# 8. 发布给 B 机（改了 webui 就要跑）
./scripts/publish-dist.sh              # SKIP_BUILD=1 复用本次构建；--release 附带 zip
```

### 硬性约束（每条都是真实事故换来的）

1. **绝不手动运行 aw-server**——孤儿进程会占 5600 端口，aw-qt 拉起自己的 server 失败后进入崩溃循环。重启一律走 aw-qt。
2. **aw-server 数据层是单线程 worker**，所有查询排队。新增图表/功能若发重查询（跨多天/多主机 canonical），**必须缓存**——参考 `src/util/hourlyMatrix.ts`（锚定单查 + localStorage 持久化 + 本地切片）。否则会拖垮 Timeline 页。
3. **时间按小时切分一律用 `src/util/hourclip.ts`**（原生 Date）。不要用 moment 做小时切分——构建产物里出过全部归 0 的诡异 bug。
4. **Vue 2 的 watch 路径**（如 `'activityStore.query_options.timeperiod'`）要求对应 store 在组件 `data()` 里注册，否则 watch **静默失效**。
5. lint 规则：禁 `_.chain`（babel-plugin-lodash 不支持，用嵌套函数组合）；禁 `!` 非空断言；prettier 风格。
6. `npm install` 必须带 `npm_config_allow_git=all`（vue-d3-sunburst 是 git 依赖）。

---

## 机器 B（消费机）agent 职责

### 首次部署

```sh
# 1. 拉取 dist（自带本手册）
git clone -b dist --depth 1 https://github.com/Q-Ze/aw-webui.git ~/aw-webui-dist

# 2. 让本机 aw-server 服务它（macOS）：
#    写 wrapper（例如 ~/bin/aw-server-patched）:
#      #!/bin/sh
#      exec /Applications/ActivityWatch.app/Contents/Resources/aw-server-rust \
#          --webpath "$HOME/aw-webui-dist" "$@"
#    chmod +x 后确保在 PATH；
#    改 ~/Library/Application Support/activitywatch/aw-qt/aw-qt.toml:
#      autostart_modules 里把 "aw-server-rust" 换成 "aw-server-patched"
#    （Windows：wrapper 用 .bat，aw-qt.toml 在 %APPDATA%\activitywatch\aw-qt\）

# 3. 重启 ActivityWatch（经 aw-qt；绝不手动跑 aw-server）
# 4. 验证
diff <(curl -s http://127.0.0.1:5600/) ~/aw-webui-dist/index.html  # 应无差异
```

### 日常同步（A 机发布后）

```sh
# dist 分支每次发布都是"单提交强推"（重写历史），普通 pull 会报
# divergent branches——这是预期行为，用 fetch + reset 对齐：
git -C ~/aw-webui-dist fetch
git -C ~/aw-webui-dist reset --hard origin/dist
git -C ~/aw-webui-dist log -1        # 提交消息含构建时间 + 源码短哈希，用于对账
# 重启 ActivityWatch → 重跑上面的 diff 验证
```

### 故障排查

- **aw-server 起不来**：看日志 `~/Library/Logs/activitywatch/aw-server-rust/`（Windows：`%LOCALAPPDATA%\activitywatch\aw-server-rust\`）。已知坑：`config.toml` 里 `custom_static` 指向不存在的目录会直接 panic。
- **5600 被占 / aw-qt 崩溃循环**：有孤儿 aw-server 进程，`pkill -f aw-server-rust` 后从 aw-qt 重启。
- **bucket 名带 `-synced-from-xxx` 后缀**：这是多设备同步的**正常形态**，不是脏数据，不要删。
- **柱状图出现 >24h/顶格/归零的日柱（2026-09 案例）**：源头机器频繁重启（调试期反复 pkill aw-qt）导致同步向对端桶写入**多份互相重叠的事件变体**（单条不长，叠加后日总量 100h+）。webui 已在 activityQuery 客户端做区间并集免疫（源码 83a0a96 起）。诊断用 SQLite 只读：`sqlite3 "file:sqlite.db?mode=ro"`，events 表 starttime/endtime 为纳秒，对比 `SUM(endtime-starttime)` 与区间并集即可确认。清理：`curl -X DELETE http://127.0.0.1:5600/api/0/buckets/<同步桶id>` 后让其重同步。避免在同步进行中重启 ActivityWatch。
- **回滚**：`git -C ~/aw-webui-dist checkout <旧提交>` 后重启 ActivityWatch。

---

## 版本对账

- dist 分支每个提交消息格式：`dist build YYYY-MM-DD HH:MM — <源码短哈希>`；
- B 机 `git log -1` 拿到短哈希，与 A 机 `git -C ~/aw-webui-patched/src rev-parse --short HEAD` 比对即知是否最新。
