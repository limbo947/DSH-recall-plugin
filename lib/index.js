/**
 * dsh-recall-plugin — Host 半入口（持久插件形态，bundle 行挂载）
 *
 * 职责：装配各域模块（config 配置域 / store 执行存储层 / snapshots 快照域 /
 * maintenance 维护域），通过 webServer 注册 /api/recall/* HTTP API
 * 供 Client 半调用（init / snapshot-info / preview / execute /
 * exclude-get / exclude-set / manage / status），并接线 session/event
 * 快照触发与启动预热。
 *
 * 这是持久 npm 插件包的主入口（exports["."]），由 cordis.patch.yml 的
 * insert 行挂载进 profile composition，DSH 重启后自动生效。
 * 文件拆分见 lib/ 下各模块头注释；本文件只做接线，不承载业务逻辑。
 */

import { createConfig, Config } from './config.js'
import { createRuntime } from './store.js'
import { createSnapshots } from './snapshots.js'
import { createMaintenance } from './maintenance.js'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-recall-plugin'

// 硬依赖：shell（PowerShell 执行）、sessions（会话/沙箱策略）、
// webServer（Client 半的 HTTP API 通道）。其余服务按需 ctx.get。
export const inject = ['shell', 'sessions', 'webServer']

// 入口配置 schema：cordis 加载器据此校验 insert 行 config 并填充默认值，
// 非法配置在插件加载时响亮失败（官方「插件配置」文档要求）。
export { Config }

// config 由 cordis.patch.yml 的 insert 行 config 键下发（schema 默认值兜底），
// 设置页「插件配置」卡片的用户覆盖经 settings namespace 热更新进 cfg
// （见下方 installSettingsSection 接线）
export function apply(ctx, config) {
  const webServer = ctx.webServer

  const cfg = createConfig(config)
  const rt = createRuntime(ctx, cfg)
  const snaps = createSnapshots(ctx, rt, cfg)
  const maint = createMaintenance(ctx, rt, snaps, cfg)
  const state = rt.state

  // ---- settings namespace「dsh-recall」：设置页「插件配置」分区正规接入 ----
  // installSettingsSection（dsh-settings 官方辅助）：settings 服务挂载后以
  // 真 Config schema 注册 namespace、组合 base 取入口 config；服务卸载时
  // 源回退入口 config。解析层 = schema 默认 → 组合 base → 用户文档（设置
  // 卡片写入、dsh-settings 持久化），变更经 watch 热更新进运行中的 cfg
  // （Object.assign 原地改，各域按调用时读取立即生效）。环境变量仍最高
  // 优先（createConfig 内处理）。settings 服务未组装（非 web 部署）时
  // 整段静默不运行，插件照常以入口配置工作。
  let readSettings = () => config
  function applyResolvedConfig(resolved) {
    Object.assign(cfg, createConfig(resolved && typeof resolved === 'object' ? resolved : {}))
  }
  try {
    installSettingsSection(ctx, 'dsh-recall', Config, config, {
      setSource: (fn) => { readSettings = fn },
      onChange: () => applyResolvedConfig(readSettings()),
    })
  } catch (error) {
    rt.recordError('recall settings namespace skipped: ' + String(error))
  }

  // 平台门控：win32 走 PowerShell 模板，linux/darwin 走 bash 模板
  // （ctx.shell 由 DSH 平台层单选挂载 pwsh/bash 执行器，见 dsh-shell README）。
  // 其余平台干净短路：init 返回 unsupported，Client 弹一次性提示；
  // 其余端点因无快照自然返回「没有可用快照」，全程零文件副作用。
  const supported = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin'

  // ---- HTTP API（Client 半经由 fetch 调用；动态插件的 harness RPC 在此换成 webServer 路由）----

  // 请求体上限：端点里 exclude-set 接受用户任意文本，无上限时可被无限
  // POST 撑爆内存。1MB 远超正常配置体量，超限干净报错而不是悄悄截断
  // （半截 JSON 会在 parse 处抛更晦涩的错）。
  const MAX_BODY_BYTES = 1048576

  // 快照管理列表的结果缓存：磁盘 dump + 冷会话标题即便已批量/并行化，
  // 也不是零成本（1 条 shell + 若干日志解压）。设置页打开、删除后刷新
  // 都会重拉，30s 缓存让二次打开即时；delete 与新快照落地时失效。
  let listCache = { at: 0, payload: null }
  // 排除配置枚举缓存（30s）：exclude-get 首次要遍历工作区、逐文件 shell 读，
  // 设置页反复打开时不该每次重算；exclude-set 成功写入后立即失效。
  let excludeCache = { at: 0, payload: null }

  // 会话标题缓存（apply 级跨请求共享）：冷会话标题要 readSession 整日志
  // 解压 + 重放校验（大日志 10 秒级），绝不能挡列表首屏——list 只查
  // live/缓存（同步、瞬时），冷标题由 Client 拿到列表后异步调 titles 补。
  // 值为 null 表示「查过、确实没有」（已删除会话），同样命中缓存。
  const sessionTitles = new Map()
  function titleFromEvents(events) {
    if (!Array.isArray(events)) return null
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e && e.type === 'session/title' && e.data && typeof e.data.title === 'string' && e.data.title) return e.data.title
    }
    return null
  }
  // 消息文本缓存（apply 级跨请求共享）：冷会话 readSession 整日志解压很贵，
  // 与标题同款两段式——live 秒回，冷会话由 Client 异步调 titles 端点补齐。
  // 值为 null 表示「查过、确实没有」，同样命中缓存。
  const messageTexts = new Map()
  function messageTextFromEvents(events, messageId) {
    if (!Array.isArray(events) || !messageId) return null
    for (const e of events) {
      if (e && e.type === 'user/message' && e.data && String(e.data.id) === String(messageId)) {
        const blocks = Array.isArray(e.data.content) ? e.data.content : []
        const text = blocks
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('')
        return text || null
      }
    }
    return null
  }
  function liveMessageTextFast(sessionId, messageId) {
    if (!sessionId || !messageId) return null
    const key = String(sessionId) + '\u0000' + String(messageId)
    if (messageTexts.has(key)) return messageTexts.get(key)
    let text = null
    try {
      const live = ctx.sessions.get(sessionId)
      if (live) text = messageTextFromEvents(live.events, messageId)
    } catch (error) { text = null }
    if (text !== null) messageTexts.set(key, text)
    return text
  }
  function liveTitleFast(sessionId) {
    if (!sessionId) return null
    if (sessionTitles.has(sessionId)) return sessionTitles.get(sessionId)
    let t = null
    try {
      const live = ctx.sessions.get(sessionId)
      if (live) t = titleFromEvents(live.events)
    } catch (error) { t = null }
    if (t !== null) sessionTitles.set(sessionId, t)
    return t
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    return JSON.parse(text)
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  // 枚举当前全部已知 exclude 文件并按路径去重：home 存储全局共享一份
  // （所有工作区通常合并成一条），降级存储各自独立。根来源取并集——
  // 会话注册表（当前活跃的工作区）+ state.stores 缓存（历史会话预热过、
  // 可能已关闭的工作区），让设置页也能编辑非活跃项目的排除配置。
  // exclude-get 直接消费结果；exclude-set 用它做路径白名单校验，客户端
  // 只能回传 get 下发过的路径，堵死「借 API 写任意文件」的通道。
  async function listExcludeFiles() {
    const roots = new Set(state.stores.keys())
    for (const session of ctx.sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (cwd) roots.add(cwd)
    }
    const byFile = new Map()
    // 并行解析全部 root：冷启动时每个 root 首次 resolveStore 可能触发 shell
    // 建目录/写 root.txt，串行会随工作区数量线性变慢；Promise.all 让它们并发。
    await Promise.all(Array.from(roots).map(async (root) => {
      try {
        const store = await rt.resolveStore(root)
        if (store && !byFile.has(store.excludeFile)) byFile.set(store.excludeFile, { store, roots: [] })
        byFile.get(store.excludeFile).roots.push(root)
      } catch (error) {
        /* 单个根解析失败只影响它自己，不拖垮整个列表 */
      }
    }))
    // 磁盘兜底：冷启动时会话注册表为空（惰性载入），但 home 容器目录可能
    // 早已存在（历史快照）。容器在 ⇒ 共享 exclude.txt 可编辑（哪怕从未
    // 写过、内容为空）；容器不在 ⇒ 全新安装，让设置页显示引导文案。
    // 注册表扫描命中的同路径条目优先（roots 信息更全），这里只补缺。
    try {
      const container = await rt.resolveHomeContainer()
      if (container) {
        const probe = rt.scripts.stripBom(await rt.runShell(rt.scripts.dirExistsScript(container), { stdoutMaxBytes: 4096 })).trim()
        if (probe === 'YES') {
          const excludeFile = container + (rt.isWin ? '\\' : '/') + 'exclude.txt'
          if (!byFile.has(excludeFile)) {
            // 伪 store：仅承载 readExclude/writeExclude 用到的 excludeFile
            // 与 home 两个字段；不进 state.stores（无对应 root，不污染缓存）
            byFile.set(excludeFile, { store: { dir: container, home: true, excludeFile }, roots: [] })
          }
        }
      }
    } catch (error) {
      /* 兜底失败退回注册表结果 */
    }
    return byFile
  }

  // 工作区 cwd 全集：live 注册表只是子集（ctx.sessions 是纯内存 Map，web
  // 侧栏拉会话列表走 persistence 只读路径、不 resume，注册表可以一直空
  // 着），sessionQuery.listSessions 是「live + 磁盘冷元数据」的完整语料
  // ——每个会话 header 都带创建时的 cwd。manage list 与 delete 兜底共用。
  async function collectCwds() {
    const cwds = new Set()
    for (const session of ctx.sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (cwd) cwds.add(cwd)
    }
    try {
      const querySvc = ctx.get('sessionQuery')
      if (querySvc && typeof querySvc.listSessions === 'function') {
        for (const record of await querySvc.listSessions()) {
          const cwd = record && record.header && record.header.cwd
          if (cwd) cwds.add(cwd)
        }
      }
    } catch (error) { /* 冷元数据不可用时退回 live 注册表 */ }
    return cwds
  }

  // 解析 storesDumpScript 的定界输出：dir → { root, entries }。逐行状态机
  // （==DIR / ROOT / INDEXBEGIN..INDEXEND），单个 store 的 JSON 损坏只丢它自己。
  function parseStoresDump(text) {
    const map = new Map()
    let cur = null
    let inIndex = false
    let indexLines = []
    function flush() {
      if (!cur) return
      const raw = indexLines.join('\n').trim()
      if (raw) {
        try {
          const arr = JSON.parse(raw)
          if (Array.isArray(arr)) cur.entries = arr
        } catch (error) { /* index 损坏按无索引处理 */ }
      }
      map.set(cur.dir, cur)
      cur = null
    }
    for (const line of String(text).split(/\r?\n/)) {
      if (line.indexOf('==DIR ') === 0) { flush(); cur = { dir: line.slice(6).trim(), root: null, entries: null }; inIndex = false; indexLines = []; continue }
      if (!cur) continue
      if (line.indexOf('ROOT ') === 0) { const v = line.slice(5).trim(); cur.root = v || null; continue }
      if (line === 'INDEXBEGIN') { inIndex = true; indexLines = []; continue }
      if (line === 'INDEXEND') { inIndex = false; continue }
      if (inIndex) indexLines.push(line)
    }
    flush()
    return map
  }

  // 一条 shell dump 全部 store 元数据（容器子目录 + 降级候选目录的
  // root.txt 与 index.json），manage list 与 delete 兜底共用。
  async function dumpStores() {
    const container = await rt.resolveHomeContainer()
    const extras = Array.from(await collectCwds()).map((cwd) => cwd + (rt.isWin ? '\\' : '/') + '.dsh-recall-snapshots')
    try {
      const text = rt.scripts.stripBom(await rt.runShell(rt.scripts.storesDumpScript(container || '', extras), { timeoutMs: 120000, stdoutMaxBytes: 8388608 }))
      return parseStoresDump(text)
    } catch (error) {
      return new Map()
    }
  }

  // 磁盘反查某快照归属的 store：dump 全部 index 后按 id 查找，root 取
  // 条目自带字段 → root.txt → 内存映射。delete 的兜底路径用它消灭
  // 「列表可见但内存缺失 ⇒ 误报不存在」。
  async function locateSnapshotOnDisk(id) {
    if (!id) return null
    const dump = await dumpStores()
    const hints = new Map()
    for (const [root, st] of state.stores.entries()) {
      if (st && st.dir) hints.set(st.dir, root)
    }
    for (const [dir, info] of dump) {
      const hit = (info.entries || []).find((e) => e && e.id === id)
      if (!hit) continue
      const root = (typeof hit.root === 'string' && hit.root) || info.root || hints.get(dir) || null
      if (!root) continue
      try {
        const store = await rt.resolveStore(root)
        if (store) return { store, root }
      } catch (error) { /* 单个 root 解析失败继续找 */ }
    }
    return null
  }

  // 统一错误映射：业务失败与系统异常分离，文案与诊断解耦。code 给
  // Client 做分支判断（BODY_TOO_LARGE 等），message 直接展示。
  function errBody(error) {
    const text = String(error && error.message ? error.message : error)
    if (text === 'BODY_TOO_LARGE') return { ok: false, code: 'BODY_TOO_LARGE', message: '请求体超过 1MB 上限' }
    return { ok: false, code: 'ERROR', message: text }
  }

  // ---- 端点表：name → handler(args) → 回包体。统一 try/catch 与入队
  // 策略写在这里，端点主体只写业务。queued 标记的端点与快照/gc 共用同
  // 一条串行队列——preview/execute 内部都跑 git add -A，不入队会与
  // 进行中的快照争 index.lock（曾只在 snapshot-info 入队，是并发隐患）。
  // 队列入队即占住后续快照，队列失败不堵队（catch 就地消化）。
  function enqueue(task) {
    const run = state.queue.then(task)
    state.queue = run.catch(() => {})
    return run
  }

  // 通用并发限制器：冷会话标题/消息文本补齐会 readSession 整日志解压，
  // 首次大量冷数据时全量 Promise.all 会同时压垮磁盘/CPU。限制同时最多
  // CONCURRENCY 个任务，剩余排队执行；这是纯内存调度，不依赖额外依赖。
  async function runLimited(tasks, concurrency) {
    const limit = concurrency > 0 ? concurrency : 4
    let index = 0
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (index < tasks.length) {
        const task = tasks[index++]
        await task()
      }
    })
    await Promise.all(workers)
  }

  // 收集全量快照记录（内存 + 磁盘 dump 并集），供树形管理的按工作区/
  // 会话批量删除使用。返回 Map<消息ID, {id, root, sessionId, time}>；
  // 磁盘条目缺 root 时按 store 的 root.txt/内存映射补全（与 manage list
  // 同一条解析链）。去重只按 id——同一消息 ID 全局唯一。
  async function collectAllSnapshotRecords() {
    const records = new Map()
    function add(id, root, sessionId, time) {
      if (!id || typeof id !== 'string') return
      const old = records.get(id)
      if (!old) {
        records.set(id, {
          id,
          root: root || null,
          sessionId: sessionId || null,
          time: typeof time === 'number' ? time : 0
        })
        return
      }
      // 同一消息 ID 可能出现磁盘先占位、内存后补全的情况：用更全的
      // root/sessionId/time 覆盖旧值，避免树形节点归到「未知」导致批量
      // 删除按工作区/会话匹配不到。
      if (!old.root && root) old.root = root
      if (!old.sessionId && sessionId) old.sessionId = sessionId
      if (!old.time && time) old.time = time
    }
    // 内存视图：当前会话/预热过的 store 已载入，秒回
    for (const [id, s] of state.snapshots.entries()) {
      if (s) add(id, s.root, s.sessionId, s.time)
    }
    // 磁盘全量：冷启动/非活跃工作区的快照也在这里
    const dump = await dumpStores()
    const hints = new Map()
    for (const [root, st] of state.stores.entries()) {
      if (st && st.dir) hints.set(st.dir, root)
    }
    for (const [dir, info] of dump) {
      const baseRoot = info.root || hints.get(dir) || null
      for (const e of info.entries || []) {
        if (!e || typeof e.id !== 'string') continue
        add(e.id, (typeof e.root === 'string' && e.root) || baseRoot, e.sessionId, e.time)
      }
    }
    return records
  }

  // 按过滤条件批量删除快照（工作区/会话两个树节点共用）：先收集匹配
  // id 并按 root 分组，再整体进串行队列——与快照/gc 互斥，避免 git 锁
  // 竞态。每个 root 先 purge tag 再补载索引后重写 index.json，防止冷启动
  // 时用残缺内存覆盖同 store 其余磁盘快照。
  async function deleteSnapshotsByFilter(match, sessionId) {
    const records = await collectAllSnapshotRecords()
    const byRoot = new Map()
    for (const rec of records.values()) {
      if (!match(rec) || !rec.root) continue
      if (!byRoot.has(rec.root)) byRoot.set(rec.root, [])
      byRoot.get(rec.root).push(rec.id)
    }
    let deleted = 0
    await enqueue(async () => {
      for (const [root, rootIds] of byRoot) {
        let store = state.stores.get(root)
        if (!store) {
          try { store = await rt.resolveStore(root) } catch (error) { store = null }
        }
        if (!store) continue
        try {
          if (state.gitExe) {
            // tag 分块删除：win32 命令行有 32767 字符上限，整批传大量 tag 会
            // 在长历史工作区上爆掉；与 maintenance.purgeSession 同款 100 个/块。
            const tags = rootIds.map((id) => 'snap-' + id)
            for (let i = 0; i < tags.length; i += 100) {
              await rt.runShell(rt.scripts.purgeTagsScript(store, state.gitExe, tags.slice(i, i + 100)), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
            }
          }
          if (!state.indexLoaded.has(root)) {
            try { await snaps.loadIndex(root, sessionId) } catch (error) { /* 载入失败照常重写，退化为旧行为 */ }
          }
          for (const id of rootIds) state.snapshots.delete(id)
          await snaps.saveIndex(root, sessionId)
          deleted += rootIds.length
        } catch (error) {
          // 单个 root 失败不阻断其他 root：与 maintenance.purgeSession 同款
          // best-effort，错误进状态页可见的错误缓冲，剩余 root 继续清理。
          rt.recordError('recall batch delete failed for ' + root + ': ' + String(error))
        }
      }
      listCache.payload = null
    })
    return deleted
  }

  // 删除所有工作区的全部快照。树形管理的「工作区/会话」批量删除以
  // index.json 中的记录为目标，适合保留其他节点；但「全部删除」必须把 git
  // tag 当作真相源：index 可能因旧版/崩溃/手动修复而为空或过期，不能因为
  // 索引里没有条目就漏删真实快照。磁盘枚举到的 store 即使 root.txt 丢失也
  // 直接按目录操作，避免 resolveStore 新建同 root 的另一个空 store。
  async function deleteAllSnapshots() {
    return enqueue(async () => {
      const stores = new Map()
      for (const [root, store] of state.stores.entries()) {
        if (store && store.dir) stores.set(store.dir, { store, root })
      }
      const dump = await dumpStores()
      for (const [dir, info] of dump.entries()) {
        const known = stores.get(dir)
        if (known) {
          if (!known.root && info.root) known.root = info.root
          known.entries = info.entries || []
        } else {
          stores.set(dir, {
            // 全局删除只动该目录下的 git/index；不必、也不能依赖可反解的 root。
            store: rt.storeFromDir(dir, false),
            root: info.root || null,
            entries: info.entries || []
          })
        }
      }

      if (stores.size === 0) return { deleted: 0, stores: 0, failed: 0 }

      const gitExe = await rt.resolveGit()
      if (!gitExe) {
        const message = '未检测到 git CLI，无法验证并删除快照 tag'
        rt.recordError('recall delete all failed: ' + message)
        return { deleted: 0, stores: 0, failed: stores.size || 1, message }
      }

      let deleted = 0
      let clearedStores = 0
      let failed = 0
      for (const { store, root } of stores.values()) {
        try {
          // 先列出实际 tag；不要使用 entries 推导 tag，entries 是可丢失缓存。
          const output = await rt.runShell(rt.scripts.listTagsScript(store, gitExe), { timeoutMs: 120000, stdoutMaxBytes: 4194304 })
          const tags = rt.scripts.stripBom(output).split(/\r?\n/).map((tag) => tag.trim()).filter((tag) => tag.indexOf('snap-') === 0)
          for (let i = 0; i < tags.length; i += 100) {
            await rt.runShell(rt.scripts.purgeTagsScript(store, gitExe, tags.slice(i, i + 100)), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
          }
          // purgeTagsScript 为幂等 best-effort，故必须回读校验，避免脚本吞掉
          // 个别失败后仍错误地把 index.json 清空。
          const remainedOutput = await rt.runShell(rt.scripts.listTagsScript(store, gitExe), { timeoutMs: 120000, stdoutMaxBytes: 4194304 })
          const remained = rt.scripts.stripBom(remainedOutput).split(/\r?\n/).map((tag) => tag.trim()).filter((tag) => tag.indexOf('snap-') === 0)
          if (remained.length) throw new Error('仍有 ' + remained.length + ' 个快照 tag 未删除')

          // tag 清理被确认后才清空索引。直接写已枚举的 store，兼容 root.txt
          // 缺失/错位的旧仓库；不能调用 saveIndex(root)，后者会重新按 root 寻址。
          await rt.writeTextViaShell(store.dir + (rt.isWin ? '\\' : '/') + 'index.json', '[]')
          for (const tag of tags) state.snapshots.delete(tag.slice('snap-'.length))
          if (root) {
            for (const [id, snap] of state.snapshots.entries()) {
              if (snap && snap.root === root) state.snapshots.delete(id)
            }
            state.indexLoaded.add(root)
          }
          deleted += tags.length
          clearedStores += 1
        } catch (error) {
          failed += 1
          rt.recordError('recall delete all failed for ' + store.dir + ': ' + String(error))
        }
      }
      // list 既合并内存也 dump 磁盘；无论完全/部分完成都必须失效，才能让
      // 成功删除的 store 立即从树上消失，而失败 store 仍保留供用户重试。
      listCache.payload = null
      return { deleted, stores: clearedStores, failed }
    })
  }

  const endpoints = {
    'init': async (args) => {
      if (!supported) {
        return { ok: false, root: null, notice: { unsupported: true } }
      }
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      const root = await rt.resolveRoot(sessionId)
      let notice = null
      if (root) {
        let store = await rt.resolveStore(root)
        store = await rt.tryUpgradeToHome(root)
        await rt.ensureGit(root, store)
        await snaps.loadIndex(root, sessionId)
        await snaps.rebuildOrphans(root, sessionId)
        rt.cleanupLegacy(root)
        // 降级状态随 init 下发，Client 弹一次性提示（每次页面加载各弹一次）：
        // gitMissing=未检测到 git CLI（撤回按钮不出现）；homeFallback=home
        // 不可写，快照降级存进项目内 .dsh-recall-snapshots。
        notice = {
          gitMissing: state.gitExe === '',
          homeFallback: store ? !store.home : false
        }
      }
      // 顺带下发客户端行为开关（fillDraft 等）：Client 无须为读配置单开请求，
      // init 是每会话必经的预热通道
      return { ok: Boolean(root), root: root || null, notice, config: { refillDraft: cfg.refillDraft } }
    },

    'snapshot-info': async (args) => {
      const id = args && args.messageId ? String(args.messageId) : ''
      const snap = state.snapshots.get(id)
      return { has: Boolean(snap), time: snap ? snap.time : null, id }
    },

    'preview': async (args) => {
      const id = args && args.messageId ? String(args.messageId) : ''
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      const result = await enqueue(() => snaps.diffFor(id))
      if (result === null) return { ok: false, code: 'NO_SNAPSHOT', message: '该消息没有可用的项目快照' }
      const snap = state.snapshots.get(id)
      const cutSeq = await snaps.resolveCutSeq(sessionId, id)
      return { ok: true, changes: result.changes, total: result.total, truncated: result.truncated, time: snap ? snap.time : null, root: snap ? snap.root : null, cutSeq }
    },

    'execute': async (args) => {
      const id = args && args.messageId ? String(args.messageId) : ''
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      const result = await enqueue(async () => {
        // 回退前自动打安全快照：回退覆盖工作区且不回写 index（旧的
        // 「当前状态」从此无任何快照可找回），用消息 ID 打 tag 会与该消息
        // 的既有快照碰撞，故用独立前缀的时间戳 tag——不进 index.json
        // （列表不展示），但孤儿重建/手动 git tag 仍能找到它，误回退后
        // 用户可让插件从该 tag 恢复，堵住唯一的不可逆操作缺口。
        const snap = state.snapshots.get(id)
        if (!snap) return { ok: false, code: 'NO_SNAPSHOT', message: '该消息没有可用的项目快照' }
        const store = state.stores.get(snap.root)
        if (!store) return { ok: false, code: 'NO_STORE', message: '快照存储不可用' }
        const safetyId = 'pre-rollback-' + Date.now()
        try {
          await rt.runShell(rt.scripts.snapshotScript(snap.root, store, state.gitExe, safetyId, cfg.baseExcludes), { timeoutMs: 600000, stdoutMaxBytes: 65536 })
        } catch (error) {
          // 安全快照失败不阻断回退本身：用户已确认覆盖，记录后照原计划执行
          rt.recordError('recall safety snapshot failed: ' + String(error))
        }
        return snaps.rollbackFor(id)
      })
      if (!result.ok) return result
      // 文件回退后再解析切点：切点只依赖会话日志，与快照是否删除无关（命中缓存，瞬时）
      const cutSeq = await snaps.resolveCutSeq(sessionId, id)
      return { ok: true, count: result.count, cutSeq }
    },

    'exclude-get': async () => {
      // 设置页「撤回设置」标签的配置读取。不支持平台照常短路：Client
      // 显示不可用提示而不是空白表单，与 init 的 notice 语义对齐。
      if (!supported) return { ok: false, unsupported: true }
      // 30s 结果缓存：首次进入要并行 resolveStore + 逐文件 shell 读，
      // 二次打开/切标签不应重复付出这份代价；exclude-set 写入后失效。
      if (excludeCache.payload && Date.now() - excludeCache.at < 30000) return excludeCache.payload
      const byFile = await listExcludeFiles()
      // 并行读取各 exclude 文件内容：每个文件一条 shell，串行会放大延迟
      const files = await Promise.all(Array.from(byFile.entries()).map(async ([path, info]) => {
        let content = ''
        try { content = await snaps.readExclude(info.store) } catch (error) { content = '' }
        return { path, home: Boolean(info.store.home), roots: info.roots, content }
      }))
      const payload = { ok: true, files }
      excludeCache = { at: Date.now(), payload }
      return payload
    },

    'exclude-set': async (args) => {
      if (!supported) return { ok: false, unsupported: true }
      const path = args && args.path ? String(args.path) : ''
      const content = args && typeof args.content === 'string' ? args.content : ''
      // 路径白名单：重新枚举当前已知 exclude 文件并要求精确命中，
      // 客户端伪造的任意路径在这里被拒（见 listExcludeFiles 注释）
      const byFile = await listExcludeFiles()
      const info = byFile.get(path)
      if (!info) return { ok: false, code: 'UNKNOWN_PATH', message: '未知的排除文件路径' }
      await snaps.writeExclude(info.store, content)
      // 写入后立即失效：设置页保存后刷新必须看到最新内容
      excludeCache.payload = null
      return { ok: true }
    },

    // 设置页「插件配置」卡片读配置：resolved 全量值 + 用户已覆盖字段（来自
    // settings.describe 的 user 层，字段在层里出现即用户覆盖）+ env 锁定
    // 字段（环境变量优先级最高，设置改不动）+ 可写性（只读 provider 禁存）。
    'config-get': async () => {
      const envLocks = {
        gcSnaps: Boolean(process.env && process.env.DSH_RECALL_GC_SNAPS),
        gcHours: Boolean(process.env && process.env.DSH_RECALL_GC_HOURS),
      }
      let overridden = {}
      let writable = false
      try {
        const settings = ctx.get('settings')
        if (settings && typeof settings.describe === 'function') {
          const list = settings.describe()
          const ours = (Array.isArray(list) ? list : []).find((d) => d && d.ns === 'dsh-recall')
          if (ours && ours.user && typeof ours.user === 'object') overridden = ours.user
          writable = settings.writable !== false
        }
      } catch (error) { /* describe 不可用按「无覆盖」处理 */ }
      return {
        ok: true,
        values: {
          gcSnaps: cfg.gcSnaps,
          gcHours: cfg.gcHours,
          maxFileBytes: cfg.maxFileBytes,
          baseExcludes: cfg.baseExcludes.slice(),
          refillDraft: cfg.refillDraft,
        },
        overridden,
        envLocks,
        writable,
      }
    },

    // 设置页「插件配置」卡片存配置：白名单字段 + 类型清洗后经 settings.update
    // 写进用户层（schema 校验失败会在持久化前 reject，错误信息回显卡片），
    // watch 链路把新值热更新进 cfg，无需重启。
    'config-set': async (args) => {
      const patch = args && args.patch && typeof args.patch === 'object' ? args.patch : {}
      const clean = {}
      if (patch.gcSnaps !== undefined) clean.gcSnaps = Number(patch.gcSnaps)
      if (patch.gcHours !== undefined) clean.gcHours = Number(patch.gcHours)
      if (patch.maxFileBytes !== undefined) clean.maxFileBytes = Number(patch.maxFileBytes)
      if (patch.refillDraft !== undefined) clean.refillDraft = Boolean(patch.refillDraft)
      if (patch.baseExcludes !== undefined) {
        if (!Array.isArray(patch.baseExcludes)) return { ok: false, code: 'BAD_TYPE', message: 'baseExcludes 必须是字符串数组' }
        clean.baseExcludes = patch.baseExcludes.filter((p) => typeof p === 'string' && p.trim())
      }
      if (!Object.keys(clean).length) return { ok: false, code: 'EMPTY_PATCH', message: '没有可写入的配置字段' }
      let settings = null
      try { settings = ctx.get('settings') } catch (error) { settings = null }
      if (!settings || typeof settings.update !== 'function') {
        return { ok: false, code: 'SETTINGS_UNAVAILABLE', message: '设置服务不可用：请在 profile 的 cordis.patch.yml 按 id: recall 覆盖配置' }
      }
      try {
        await settings.update('dsh-recall', clean)
      } catch (error) {
        return { ok: false, code: 'SETTINGS_WRITE_FAILED', message: '配置写入失败：' + String(error && error.message ? error.message : error) }
      }
      return { ok: true }
    },

    // 设置页「快照管理」卡片：列表 / 磁盘占用 / 单条删除 / 手动 gc。
    // 全部走串行队列——删除 tag 与 gc 与快照争的是同一个 git 仓库。
    'manage': async (args) => {
      if (!supported) return { ok: false, unsupported: true }
      const op = args && args.op ? String(args.op) : 'list'
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      if (op === 'list') {
        // 结果缓存（30s + 删除/新快照失效）：设置页反复打开、删除后刷新
        // 都会重拉列表，缓存让二次打开零 shell。
        if (listCache.payload && Date.now() - listCache.at < 30000) return listCache.payload
        const allItems = []

        // 磁盘全量：一条 shell dump（dumpStores 见其注释——旧实现每目录
        // 2-3 条 shell 串行跑，20 秒级慢的根因）。root 解析链：条目自带
        // root（新数据）→ root.txt → 内存 store 映射（store 目录名是
        // root 的单向 SHA256，磁盘上只有持久化记录能反查）。
        // 标题只查 live/缓存（liveTitleFast，同步瞬时）——冷会话标题由
        // Client 拿到列表后异步调 titles 补齐，列表首屏不等日志解压。
        const dump = await dumpStores()
        const hints = new Map()
        for (const [root, st] of state.stores.entries()) {
          if (st && st.dir) hints.set(st.dir, root)
        }
        // 去重只用 id（消息 ID 全局唯一）：带 root 进 key 会让同一快照
        // 因「磁盘来源 root 缺失 / 内存来源 root 齐全」出现两条重复行
        const byId = new Map()
        function push(id, time, root, sessionId) {
          if (!id || typeof id !== 'string') return
          const old = byId.get(id)
          if (!old) {
            const rec = {
              id,
              time: typeof time === 'number' ? time : 0,
              root: root || null,
              workspace: root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null,
              sessionId: sessionId || null,
              sessionTitle: liveTitleFast(sessionId)
            }
            // 消息文本只放已确认值：live 命中字符串则带，否则不设字段。
            // 客户端据此判断「还没请求冷日志」；messages 端点补齐后字符串
            // 或 null 都会写入，null 表示确实无文本，避免每次刷新重复请求。
            const liveText = liveMessageTextFast(sessionId, id)
            if (liveText) rec.messageText = liveText
            byId.set(id, rec)
            allItems.push(rec)
            return
          }
          // 与 collectAllSnapshotRecords 同款补全：磁盘先占位、内存后补全
          // root 时，若按「首次命中即丢弃」会让树形一级节点落进未知工作区。
          if (!old.root && root) { old.root = root; old.workspace = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null }
          if (!old.sessionId && sessionId) { old.sessionId = sessionId; old.sessionTitle = liveTitleFast(sessionId) }
          if (!old.messageText && id) { old.messageText = liveMessageTextFast(sessionId, id) }
          if (!old.time && time) old.time = time
        }
        for (const [dir, info] of dump) {
          const baseRoot = info.root || hints.get(dir) || null
          for (const e of info.entries || []) {
            if (!e || typeof e.id !== 'string') continue
            push(e.id, e.time, (typeof e.root === 'string' && e.root) || baseRoot, e.sessionId)
          }
        }
        // 内存兜底（刚拍未落盘的保险，正常已被磁盘 dump 覆盖）
        for (const [id, s] of state.snapshots.entries()) {
          push(id, s.time, s.root, s.sessionId)
        }

        allItems.sort((a, b) => (b.time || 0) - (a.time || 0))
        const payload = { ok: true, items: allItems.slice(0, 200), total: allItems.length }
        listCache = { at: Date.now(), payload }
        return payload
      }
      if (op === 'titles') {
        // 冷会话标题补齐（Client 异步二次请求）：readSession 整日志解压 +
        // 重放校验，大日志 10 秒级——独立于列表让首屏即时。并发交给
        // sessionQuery 自带的 inspect 并发闸，这里全量并行发车。
        if (!supported) return { ok: false, unsupported: true }
        const ids = Array.from(new Set(
          (Array.isArray(args && args.sessionIds) ? args.sessionIds.map(String) : []).filter(Boolean)
        )).slice(0, 100)
        const out = {}
        // 并发限 4：冷标题 readSession 是重 IO，全量并发会把首次设置页
        // 的 shell/日志解压都挤在一起；限制后列表本身不受影响，标题渐进补齐。
        await runLimited(ids.map((sid) => async () => {
          if (out[sid] !== undefined) return
          let title = liveTitleFast(sid)
          if (title === null) {
            const query = ctx.get('sessionQuery')
            if (query && typeof query.readSession === 'function') {
              try {
                const log = await query.readSession(sid)
                title = titleFromEvents(log && log.events)
              } catch (error) { title = null }
            }
          }
          sessionTitles.set(sid, title)
          out[sid] = title
        }), 4)
        return { ok: true, titles: out }
      }
      if (op === 'messages') {
        // 冷会话消息文本补齐：与 titles 同款两段式，独立端点避免和标题
        // 请求的 sessionIds/messageIds 对应关系纠缠。输入 [{sessionId, messageId}]，
        // 缺 live 文本的消息才需要补；同一会话多个消息共享一次 readSession。
        if (!supported) return { ok: false, unsupported: true }
        const reqs = Array.isArray(args && args.requests) ? args.requests.slice(0, 200) : []
        const bySession = new Map()
        for (const r of reqs) {
          const sid = r && r.sessionId ? String(r.sessionId) : null
          const mid = r && r.messageId ? String(r.messageId) : null
          if (!sid || !mid) continue
          if (!bySession.has(sid)) bySession.set(sid, [])
          bySession.get(sid).push(mid)
        }
        const texts = {}
        await runLimited(Array.from(bySession.entries()).map(([sid, mids]) => async () => {
          // 该会话所有消息都已缓存（含 null）时，不必 readSession 冷读
          const allCached = mids.every((mid) => messageTexts.has(String(sid) + '\u0000' + String(mid)))
          let log = null
          if (!allCached) {
            const query = ctx.get('sessionQuery')
            if (query && typeof query.readSession === 'function') {
              try {
                log = await query.readSession(sid)
              } catch (error) { log = null }
            }
          }
          for (const mid of mids) {
            const key = String(sid) + '\u0000' + String(mid)
            // 缓存命中（含 null）直接复用，避免已确认无文本的消息反复冷读
            if (messageTexts.has(key)) {
              texts[mid] = messageTexts.get(key)
              continue
            }
            let text = liveMessageTextFast(sid, mid)
            if (text === null && log && Array.isArray(log.events)) {
              text = messageTextFromEvents(log.events, mid)
            }
            // 与 sessionTitles 同款缓存策略：null 也缓存，避免冷会话反复
            // readSession 查同一个查不到文本的消息。
            messageTexts.set(key, text)
            texts[mid] = text
          }
        }), 4)
        return { ok: true, messageTexts: texts }
      }
      if (op === 'usage') {
        let bytes = 0
        if (sessionId) {
          // 旧调用方（带会话上下文）：单工作区占用
          const root = await rt.resolveRoot(sessionId)
          if (!root) return { ok: false, code: 'NO_ROOT', message: '无法解析当前工作区' }
          const store = state.stores.get(root)
          if (!store) return { ok: false, code: 'NO_STORE', message: '当前工作区尚未创建快照存储' }
          const out = await rt.runShell(rt.scripts.diskUsageScript(store.dir), { stdoutMaxBytes: 4096 })
          bytes = parseInt(rt.scripts.stripBom(out).trim(), 10) || 0
        } else {
          // 新调用方（settings.plugin.item 卡片无会话上下文）：全部已知
          // store 汇总。store 全集取内存缓存（启动预热填齐）；单个失败
          // 不影响汇总，best-effort。
          for (const store of state.stores.values()) {
            if (!store || !store.dir) continue
            try {
              const out = await rt.runShell(rt.scripts.diskUsageScript(store.dir), { stdoutMaxBytes: 4096 })
              bytes += parseInt(rt.scripts.stripBom(out).trim(), 10) || 0
            } catch (error) { /* 单 store 失败跳过 */ }
          }
        }
        return { ok: true, bytes }
      }
      if (op === 'delete') {
        // 统一删除入口：scope=workspace 删除整个工作区全部快照；
        // scope=session 删除某会话全部快照；scope=snapshot（缺省）单条删除。
        // 树形管理每级右侧都有删除按钮，三种粒度共用此端点。
        const scope = args && args.scope ? String(args.scope) : 'snapshot'
        const root = args && args.root ? String(args.root) : null
        const targetSessionId = args && args.sessionId ? String(args.sessionId) : null
        const id = args && args.messageId ? String(args.messageId) : ''
        if (scope === 'workspace') {
          if (!root) return { ok: false, code: 'NO_ROOT', message: '缺少工作区路径' }
          const deleted = await deleteSnapshotsByFilter((rec) => rec.root === root, sessionId)
          return { ok: true, deleted }
        }
        if (scope === 'session') {
          if (!targetSessionId) return { ok: false, code: 'NO_SESSION', message: '缺少会话 ID' }
          // 树形中会话挂在具体工作区下，客户端会传 root 限定范围；不传则
          // 保持旧语义（删该会话全部工作区的快照），兼容老调用方。
          const deleted = await deleteSnapshotsByFilter(
            (rec) => rec.sessionId === targetSessionId && (!root || rec.root === root),
            sessionId
          )
          return { ok: true, deleted }
        }
        // 管理列表来自磁盘（跨工作区全量），而内存 state.snapshots 只含
        // 当前工作区 + 预热过的——冷启动或别的会话先点开列表时，列表里有、
        // 内存里没有，只查内存会把可删的快照误报「不存在」。解析链：
        // 内存命中 → Client 透传的条目 root → 磁盘 index 反查归属 store。
        let snap = state.snapshots.get(id) || null
        let snapRoot = snap ? snap.root : root
        let store = null
        if (snapRoot) {
          try { store = await rt.resolveStore(snapRoot) } catch (error) { store = null }
        }
        if (!store) {
          // 兜底：扫 home 容器与降级目录的 index.json，找到含该 id 的 store
          const found = await locateSnapshotOnDisk(id)
          if (found) { store = found.store; snapRoot = found.root }
        }
        if (!store) return { ok: false, code: 'NO_SNAPSHOT', message: '该快照不存在' }
        const finalStore = store
        const finalRoot = snapRoot
        await enqueue(async () => {
          if (state.gitExe) {
            await rt.runShell(rt.scripts.purgeTagsScript(finalStore, state.gitExe, ['snap-' + id]), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
          }
          // 兜底路径到这里时内存可能还没载入过该 root 的索引——直接
          // saveIndex 会用「只有内存条目」的列表覆盖 index.json，把同
          // store 其余磁盘快照一并抹掉。先 loadIndex 补齐内存视图（幂等，
          // indexLoaded 命中则零成本），再删目标条目后重写。
          if (!state.indexLoaded.has(finalRoot)) {
            try { await snaps.loadIndex(finalRoot, sessionId) } catch (error) { /* 载入失败照常重写，退化为旧行为 */ }
          }
          state.snapshots.delete(id)
          await snaps.saveIndex(finalRoot, sessionId)
          // 列表缓存失效：Client 删除后会立刻 refresh，必须看到最新状态
          listCache.payload = null
        })
        return { ok: true }
      }
      if (op === 'deleteAll') {
        const result = await deleteAllSnapshots()
        if (result.failed > 0) {
          return {
            ok: false,
            code: 'PARTIAL_DELETE',
            deleted: result.deleted,
            message: result.message || ('已删除 ' + result.deleted + ' 条快照，但有 ' + result.failed + ' 个存储未完成；请查看最近错误后重试')
          }
        }
        return { ok: true, deleted: result.deleted, stores: result.stores }
      }
      if (op === 'gc') {
        // 带会话上下文：只 gc 该会话的工作区；无上下文（设置卡片）：
        // 全部已知 store 逐个 gc。两者都排进串行队列，与快照互斥。
        const done = sessionId
          ? await enqueue(() => maint.runGc(sessionId, true))
          : await enqueue(() => maint.runGcAll())
        return { ok: true, gc: Boolean(done) }
      }
      return { ok: false, code: 'UNKNOWN_OP', message: '未知的管理操作: ' + op }
    },

    // 设置页排障：最近错误（Host 侧 console.error 的页面可见副本）
    'status': async () => ({ ok: true, errors: state.errors.slice(-20).reverse() })
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/recall',
    handler: async (req, res) => {
      const path = (req.url || '').split('?')[0]
      const name = path.replace(/^\/api\/recall\/?/, '').split('/')[0]
      const endpoint = endpoints[name]
      if (!endpoint) {
        sendJson(res, 404, { ok: false, code: 'UNKNOWN_ENDPOINT', message: 'unknown endpoint: ' + name })
        return
      }
      try {
        const args = await readJsonBody(req)
        sendJson(res, 200, await endpoint(args))
      } catch (error) {
        sendJson(res, 200, errBody(error))
      }
    }
  }))

  // 快照事件与启动预热仅在受支持平台注册（见上方 supported 短路说明）
  if (!supported) return

  // 每条用户消息触发快照（子代理会话跳过）；快照完成后串行接一次维护
  // （定期 gc / 会话清理）——排在同一条队列里，与快照天然互斥，无 git 锁竞态
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    const data = event.data
    if (!data || typeof data.id !== 'string' || !data.id) return
    const source = data.source
    if (!source || source.kind !== 'user') return
    if (session && session.header && session.header.origin === 'subagent') return
    const messageId = data.id
    const time = event.time
    state.queue = state.queue
      .then(() => snaps.captureSnapshot(session.id, messageId, time))
      .then(() => maint.maybeMaintain(session.id))
      .then(() => { listCache.payload = null })
      .catch((error) => rt.recordError('recall snapshot error: ' + String(error)))
  })

  // 启动预热：所有已存在工作区解析存储、重建索引与孤儿快照，
  // 并清理旧版项目内 blobs 目录（home 可用时）。
  // 不触发维护（gc/清理）：开机预热应尽量轻，重活等第一条消息再按节流来。
  // 冷启动时 ctx.sessions.list() 常为空（惰性载入），必须叠加
  // sessionQuery.listSessions() 冷元数据，否则设置页首次打开仍要现场建 store。
  // apply 不是 async，这里用 IIFE 把冷元数据扫描包成异步任务。
  ;(async () => {
    const warmupRoots = new Map()
    for (const session of ctx.sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (cwd && !warmupRoots.has(cwd)) warmupRoots.set(cwd, session.id)
    }
    const querySvc = ctx.get('sessionQuery')
    if (querySvc && typeof querySvc.listSessions === 'function') {
      try {
        const records = await querySvc.listSessions()
        for (const record of records || []) {
          // listSessions 记录形如 {header, live, persisted}，会话 id 在
          // header.id——此前误用顶层 record.id（恒 undefined），预热重建
          // 的孤儿快照 sessionId 记为空，树形管理里会落进「已删除会话」。
          const id = record && record.header && record.header.id ? record.header.id : null
          const cwd = record && record.header && record.header.cwd
          if (cwd && !warmupRoots.has(cwd)) warmupRoots.set(cwd, id)
        }
      } catch (error) { /* 冷元数据不可用则退回 live 注册表 */ }
    }
    for (const [cwd, sessionId] of warmupRoots) {
      Promise.resolve(rt.resolveStore(cwd))
        .then(() => rt.tryUpgradeToHome(cwd))
        .then((store) => rt.ensureGit(cwd, store))
        .then(() => snaps.loadIndex(cwd, sessionId))
        .then(() => snaps.rebuildOrphans(cwd, sessionId))
        .then(() => rt.cleanupLegacy(cwd))
        .catch(() => {})
    }
  })()
}
