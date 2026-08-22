# 更新日志

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

### 新增

- 快照管理新增带二次确认的「全部删除」按钮：一次清理所有工作区的快照。

### 修复

- 全部删除直接枚举每个影子仓库的真实 `snap-*` git tag，而非仅依赖可能丢失或过期的 `index.json`；tag 每 100 个分批删除并回读校验，确认成功后才清空索引。即使 `index.json` 为空、`root.txt` 缺失或列表未显示残留快照，仍可清理。
- 仅创建但未初始化 git 的空 store 视为无快照，不会阻断其他 store 的全部删除；任一 store 删除失败会保留其索引并在页面显示可重试错误。

## [1.6.0] - 2026-08-22

### 新增

- 撤回后自动把被撤回的消息文本回填到输入框（方案取自 [#4](https://github.com/limbo947/dsh-recall-plugin/pull/4)，按主干结构重写）：走官方 `conversation` 服务的 `input.shell(id).actions.setDraft`（与输入框自身同一写入通道，draft 镜像同步），对话回退成功时填入新会话、回退失败时填入当前会话；8 次 × 150ms 有界重试覆盖 fork+open 后 shell 就绪竞态，拿不到服务时静默跳过。新增配置开关 `refillDraft`（默认开）。
- 设置入口迁入官方「插件配置」分区（[#2](https://github.com/limbo947/dsh-recall-plugin/issues/2)）：改用 `settings.plugin.item` keyed slot（按 namespace `dsh-recall` 分发），Host 端经官方 `installSettingsSection` 注册真 schema 的 settings namespace——`settings.describe` 命中后卡片出现。卡片内含插件配置表单（保存经 `dsh-settings` 持久化进用户层、watch 链路热生效无需重启）+ 排除配置编辑（折叠）+ 快照管理（折叠）。原「撤回设置」独立标签页移除。
- 导出 Schemastery `Config` schema（官方「插件配置」文档要求）：cordis 加载时校验入口配置并填充默认值，非法配置在插件加载时响亮失败；同时作为 settings namespace 的注册 schema，一式两用。
- 设置卡片「插件配置」表单：gc 触发条数/小时、文件大小上限、基础排除表、回填开关五个字段；显示「已覆盖」（用户层覆盖）与「环境变量锁定」（`DSH_RECALL_GC_SNAPS/GC_HOURS` 仍最高优先）标记；只提交修改过的字段，避免全量覆盖污染用户层。

### 变更

- 设置卡片默认收起、点卡片头展开，视觉规格对齐官方 PluginCard（bg-layer 底色、展开态边框/背景变化、标题 15px/600、内容区上边框分隔、箭头 14px 居右）。
- 快照管理的磁盘占用与「立即 gc」全局化：设置卡片无会话上下文，`usage` 汇总全部已知 store、`gc` 逐 store 执行（新增 `maintenance.runGcAll`）；带 sessionId 的旧调用语义保持不变。
- 配置热更新贯通：`gcSnaps/gcHours/maxFileBytes/baseExcludes` 改为调用时读取（原工厂创建时快照），settings 卡片保存后下一次快照/gc 即按新值执行，无需重启。
- `package.json` 新增 peerDependencies：`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`。

## [1.5.2] - 2026-08-22

### 修复

- 撤回按钮不自动出现、需手动刷新（[#3](https://github.com/limbo947/dsh-recall-plugin/issues/3)，修复方案取自 [#4](https://github.com/limbo947/dsh-recall-plugin/pull/4) 并按主干结构重写）：两处根因分别修复——
  - 快照捕获是异步的，客户端在消息节点挂载时只查一次 `snapshot-info`，先于捕获完成返回 `has:false` 则永不重试。改为有界轮询：近 5 分钟内的新消息最多 20 次 × 1s，`has:true` 即渲染按钮，捕获完成后自动出现；老消息不再空转请求。
  - 冷会话（未 live）根目录解析错误：`resolveRoot` 只认 live 注册表，冷启动时回退 `sandboxPolicy.workspaceRoot`（常为 harness 启动目录）导致查错 store，且错误根被永久缓存。改为先经 `sessionQuery.listSessions` 从持久化 header 解析真实 cwd；只有 live/持久化来源的权威结果才进缓存，回退的临时根不缓存。
- 启动预热读冷会话元数据时会话 id 误取 `record.id`（`listSessions` 记录的 id 在 `header.id`，顶层恒 undefined）：预热重建的孤儿快照 sessionId 记为空，树形管理里落入「已删除会话」节点。改读 `record.header.id`。

## [1.5.1] - 2026-08-18

### 修复

- 设置页冷启动优化：`exclude-get` 首次遍历工作区、逐文件 shell 读改为并行 + 30s 结果缓存（保存后失效），二次打开设置页不再重复付出首访代价。
- 冷会话标题/消息文本补齐引入通用并发限制器（`runLimited`，同时最多 4 个）：首次大量冷数据时 `readSession` 整日志解压不再全量并发压垮磁盘/CPU。
- 启动预热叠加 `sessionQuery.listSessions()` 冷元数据：冷启动时 `ctx.sessions.list()` 常为空（惰性载入），此前设置页首次打开仍要现场建 store，现开机即预热全部历史工作区。
- Client 侧 `usage`/`status` 补数据延后到 `list` 返回后异步执行：首屏先渲染树形内容，磁盘占用与错误日志随后补齐；`list` 失败时仍尝试补这两个数据，避免整卡全空。

### 变更

- Client 侧 `titles` 请求的 sessionIds 去重（`Set` 去重 + 过滤空值）。

## [1.5.0] - 2026-08-18

### 新增

- 快照管理改为**树形结构**展示：第一级工作区（文件夹名）→ 第二级会话（会话标题）→ 第三级快照（消息 ID/消息内容摘要）；工作区与会话支持展开/折叠。
- 树形每级右侧提供删除按钮：工作区删除该工作区全部快照，会话删除该工作区内该会话全部快照，叶子单条删除；均带行内二次确认。
- 快照叶子显示**对应消息内容摘要**（取 `user/message` 事件的 text 块），悬停显示完整内容；冷会话消息文本经新增 `manage/messages` 端点按会话分组异步补齐，避免为每条消息重复解压日志。
- Host `manage/delete` 扩展 `scope=workspace/session` 批量删除：内存 + 磁盘全量收集匹配快照，按 root 分组进串行队列，tag 分块（每 100 个）规避 Windows 命令行上限；单个 root 失败 best-effort 继续并进入错误缓冲。

### 变更

- `manage list` 同 id 去重由“首次命中即丢弃”改为字段补全（root/sessionId/time/标题/消息文本），避免磁盘先占位、内存后补全时树形节点落入「未知工作区」。
- 删除操作成功提示改为显示实际删除条数（`已删除 N 条快照`）。

### 兼容性

- 全部改动保持纯 JS 零构建；未改存储格式与脚本模板接口，旧索引/旧快照无需迁移。

## [1.4.0] - 2026-08-17

### 新增

- 官方插件配置机制：`cordis.patch.yml` 行声明默认值（`gcSnaps`/`gcHours`/`maxFileBytes`/`baseExcludes`），用户在 profile 的 `cordis.patch.yml` 按 `id: recall` 重述该行即可覆盖；`DSH_RECALL_GC_SNAPS/GC_HOURS` 环境变量保留为最高优先（向后兼容）。
- 回退前自动保存安全快照（`snap-pre-rollback-<时间戳>` tag，不进列表），误回退后可从该 tag 找回，堵住唯一的不可逆操作缺口；确认面板文案同步说明。
- 设置页「快照管理」卡片：快照列表（时间倒序，含工作区名/会话标题）、当前工作区磁盘占用、单条删除、「立即 gc」手动触发、最近错误展示（Host 侧失败原本只在宿主进程日志，页面不可见）。
- 快照列表跨工作区名称解析：`saveIndex` 条目持久化 `root`；store 目录新增 `root.txt` 元数据（旧 store 重新解析时自动补写）；工作区 cwd 全集取「live 注册表 + `sessionQuery.listSessions` 冷元数据」并集（冷启动注册表为空也能解析）。
- 快照管理性能优化：新增双平台 `storesDumpScript` 一条 shell 批量 dump 全部 store 元数据（旧实现每目录 2-3 条 shell 串行，冷列表 20 秒级）；列表 30 秒结果缓存（删除/新快照失效）；冷会话标题两段式——列表首屏只查 live/缓存（同步瞬时），冷标题（整日志解压 10 秒级）由客户端异步 `titles` 端点补齐、行内先显示「…」。实测冷列表 20s+ → 2.3s、缓存命中 8ms、删除 20s+ → 4.4s。
- Host 新增 `manage`（list/usage/delete/gc）与 `status`（最近错误环形缓冲）端点；`preview`/`execute` 与快照/gc 共用同一条串行队列，消除 git index 锁并发竞态。
- 变更清单截断保护：超过 500 条时面板显示「仅显示前 N 条」，总数仍准确；请求体 1MB 上限（`BODY_TOO_LARGE`）；启动时自检两套脚本模板的同名导出对齐。

### 修复

- 索引载入失败（如 shell 未就绪）后该工作区本次进程内被永久标记「已载入」、撤回按钮消失直到重启——改为读取链路全部走通后才标记，失败自然重试。
- 快照列表「未知工作区」与同快照重复行：旧列表只查内存 `state.snapshots` 且去重 key 带 root——冷启动注册表为空时全部落空。修复后磁盘来源三层解析 root、去重只按消息 ID。
- 管理页删除误报「该快照不存在」：列表来自磁盘全量而删除只查内存——修复为「内存 → 条目 root → 磁盘 index 反查（`locateSnapshotOnDisk`）」解析链；兜底删除前先 `loadIndex` 补齐内存视图，防止 `saveIndex` 用残缺内存覆盖 index.json 抹掉同 store 其余快照；`purgeSession` 对未缓存 root 现场解析 store（原先直接跳过导致该 root 清理永远 miss）。
- 事件重放/重发产生重复 messageId 时 `git tag` 重名 fatal 导致整条快照失败——改 `tag -f`（同一条消息重快照取最新状态）。
- A→B→A 切换会话后 A 复用 B 的 init promise——init 缓存改 `Map<会话, Promise>`。

### 变更

- 错误回包统一为 `{ok, code, message}`（业务失败与系统异常分离，文案与诊断解耦）。
- `saveIndex`/`writeExclude` 的 win32 base64 分块与 POSIX stdin 分叉合并为统一落盘原语 `writeTextViaShell`；脚本导出 `indexWriteCmd`/`excludeWriteCmd` 合并为 `fileWriteCmd`。
- `resolveHomeContainer` 改纯 JS 推导（容器 = home 目录父级），删除与 `homeDirScript` 重复的整条 `$h` shell 解析链（消除双链漂移风险）。
- `maintenance.js` 导出面收敛为 `maybeMaintain`/`runGc`；删除 `index.json` 的死字段 `count`；删除未使用的非 scoped `cordis` peerDependency。
- Host 端点分发重构为端点表 + 统一 try/catch；Client 侧 `kind` 语义（文案/徽章类名/汇总）合并为单表。

### 兼容性

- 全部改动经冒烟实测：临时中文+空格工作区上跑通真实 git 链路（建仓/快照/tag -f 幂等/diff 三类变更检出/回退恢复与删除/分块索引读写/tag 清理/gc/磁盘统计），Windows PowerShell 5.1 与 pwsh 7 双解释器通过。
- 评估阶段曾将 win32 回退改为 bsdtar 优先，冒烟实测否决：GBK 代码页机器上 bsdtar 把 tar 流里的 UTF-8 文件名按 ANSI 解码（中文文件名解包成乱码新文件），已回滚为 zip + Expand-Archive 链路（中文路径实测正确，mtime 语义天然安全）。

## [1.3.0] - 2026-08-17

### 新增

- 设置页「撤回设置」标签（设置 → 插件）：可视化编辑快照排除项——输入路径或模式回车即加、常用模式一键追加（`dist/`、`*.log`、`.env` 等）、放弃修改/保存与未保存状态提示，保存后下一次快照/预览/回退立即生效，无需重启。
- Host 端 `exclude-get` / `exclude-set` HTTP 端点：枚举并读写全部 exclude.txt（home 存储全局共享一份，降级工作区各自独立、分卡片展示）；写入走 base64 分块（win32）/ stdin（POSIX），任意长度配置不受命令行上限约束；写入路径经服务端白名单校验（仅接受枚举结果中的路径）。
- 冷启动兜底：会话注册表未载入时按磁盘 home 容器目录枚举 exclude.txt（`resolveHomeContainer`），设置页不再误报「尚未创建快照存储」。

### 兼容性

- 全部新增 shell 命令在 Windows PowerShell 5.1 与 WSL2 Ubuntu（bash）实测通过，覆盖中文/空格路径、CRLF、空文件、缺失文件等边界。

## [1.2.2] - 2026-08-15

### 修复

- 撤回出的新会话不再向标题追加递增数字：fork 不传 `increaseTitle`，原样继承原标题。

### 文档

- 新增英文 README（README.en.md，与中文版互链）与 AGENTS.md 项目速览。

## [1.2.1] - 2026-08-15

### 修复

- 修正 package.json 仓库地址（仓库改名后同步）；README 安装地址同步。

## [1.2.0] - 2026-08-15

### 新增

- Linux/macOS（bash）平台支持：与 Windows 版同名导出的脚本模板按 `process.platform` 单选；POSIX 侧 `DSH_HOME` 解析对齐执行器 env 洗刷语义（WSL2 实测）。
- 快照自动维护：定期 `git gc`（每 50 条快照或 24 小时先到先触发，`DSH_RECALL_GC_SNAPS` / `DSH_RECALL_GC_HOURS` 可调，`gc.stamp` 跨重启续存节流）。
- 会话删除联动清理：会话日志从磁盘消失后自动删除该会话全部快照 tag 并释放空间；归档不算删除，判断保守（冷会话不误清）。
- 用户自定义排除：home 下 `exclude.txt`（gitignore 语法）全局生效，下一次快照/回退即时应用。

### 变更

- Host 代码模块化拆分（index / store / snapshots / maintenance / scripts.*），零顶层副作用，全部副作用经 `ctx.on` / `ctx.effect`。

## [1.0.4] - 2026-08-15

### 修复

- 非 UTF-8 代码页（GBK）输出乱码、UNC home、非 Windows 平台的通用性问题。

## [1.0.3] - 2026-08-15

### 修复

- 跨机器通用性：git 多候选安装位置探测、索引 base64 分块写入（突破命令行 32767 上限）、目录扫描容错（杀软锁定/异常 ACL）、路径尾分隔符归一、`DSH_HOME` 回退链。

## [1.0.2] - 2026-08-15

### 新增

- 未装 git / home 不可写时页面顶部一次性降级提示（gitMissing / homeFallback）。

## [1.0.1] - 2026-08-15

### 变更

- shell 以宿主身份（`danger-full-access`）执行：受限会话（workspace-write / read-only）也能在 home 建影子仓库、照常快照与回退。

## [1.0.0] - 2026-08-15

### 初始发布

- 消息撤回：影子 git 仓库快照（tag 即快照，项目目录零污染）+ 官方 `sessions.fork` 对话整段回退，原会话归档可找回。
- 确认面板先展示变更文件清单（修改/恢复/删除）再执行；`.git`、`node_modules` 自动排除；超过 100MB 的大文件跳过。
- key 冲突递减重试的 user 槽位注册，Windows PowerShell 5.1 / 7 双版本兼容。
