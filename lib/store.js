/**
 * dsh-recall-plugin — 执行与存储层（ctx 绑定的工厂，无模块级副作用）
 *
 * 职责：提供 runShell（宿主身份执行 + 统一编码保证）、会话根目录解析、
 * git 可执行文件探测、home/降级存储解析与迁移、影子仓库初始化（ensureGit）。
 * 按 process.platform 选择脚本模板（scripts.pwsh.js / scripts.posix.js），
 * 两套模板导出同名接口，本文件用 rt.scripts 统一下发。
 * 产出共享 state（各 Map 缓存）供 snapshots.js / maintenance.js 复用；
 * 由 lib/index.js 在 apply(ctx) 里装配，插件卸载时随 Fiber 一起丢弃。
 */

import os from 'node:os'
import crypto from 'node:crypto'
import * as pwshScripts from './scripts.pwsh.js'
import * as posixScripts from './scripts.posix.js'

// home 不可写时迁移重试的节流间隔：避免每条消息都白试一次注定失败的迁移
const HOME_RETRY_MS = 300000

// 最近错误环形缓冲容量：设置页排障用，20 条足够回溯一轮快照/gc 的失败
const ERROR_BUFFER_MAX = 20

export function createRuntime(ctx, config) {
  const shell = ctx.shell
  const sessions = ctx.sessions

  const isWin = process.platform === 'win32'
  const SEP = isWin ? '\\' : '/'
  const scripts = isWin ? pwshScripts : posixScripts

  const state = {
    roots: new Map(),
    stores: new Map(),
    snapshots: new Map(),
    queue: Promise.resolve(),
    indexLoaded: new Set(),
    gitReady: new Set(),
    cutSeqCache: new Map(),
    homeRetryAt: new Map(),
    gcLastAt: new Map(),
    gcCount: new Map(),
    gitExe: null,
    posixHomeBase: null,
    homeContainer: null,
    errors: []
  }

  // 最近错误环形缓冲：Host 侧所有失败原本只进 console.error（宿主进程
  // 日志，用户在页面上不可见），这里留最近 20 条经 /api/recall/status
  // 下发给设置页展示。同时转发 console.error 保持原有宿主日志不变。
  function recordError(text) {
    const message = String(text)
    state.errors.push({ time: Date.now(), message })
    if (state.errors.length > ERROR_BUFFER_MAX) state.errors.splice(0, state.errors.length - ERROR_BUFFER_MAX)
    console.error(message)
  }

  // 两套脚本模板的「命令函数」同名导出是跨平台正确性的硬约束（store.js
  // 按平台单选 rt.scripts，调用方统一 S.*）：单侧漏导出只会在另一平台
  // 用户机器上以「不是函数」的怪异方式暴雷。装配时比对一次。豁免项：
  // 平台专属导出（homeDirScript 的 $h 链只在 pwsh 侧需要——POSIX 的 home
  // 基底走 probeHomeScript + Node 侧推导；常量与转义工具不承载命令）。
  ;(function checkScriptParity() {
    // fileWriteCmd 仅 pwsh 版存在：POSIX 的文本落盘走 stdin（store.js
    // writeTextViaShell 的 POSIX 分支不经命令行传参），不需要该模板函数
    const SKIP = new Set(['homeDirScript', 'probeHomeScript', 'fileWriteCmd'])
    const pwshKeys = Object.keys(pwshScripts).filter((k) => !SKIP.has(k) && typeof pwshScripts[k] === 'function')
    const posixKeys = Object.keys(posixScripts).filter((k) => !SKIP.has(k) && typeof posixScripts[k] === 'function')
    const missing = pwshKeys.filter((k) => posixKeys.indexOf(k) < 0)
    if (missing.length) recordError('recall script parity: posix 缺少导出 ' + missing.join(', '))
  })()

  // 所有 shell 调用都以宿主身份（danger-full-access）执行，不借用会话沙箱。
  // 为什么安全：DSH 沙箱约束的是「模型驱动」的文件效果，而本插件的命令全部
  // 是宿主侧固定模板（建仓/快照/索引/回退），命令串里唯一变量是插件自己
  // 推导的路径（会话 cwd、哈希出的 store 路径、消息 ID），模型无法注入任何
  // 内容；快照落盘的也只是会话本就有权读取的工作区文件副本，不扩大能力。
  // 为什么必须如此：若按会话解析策略，workspace-write/read-only 会话写不了
  // home，快照被迫降级进项目目录（污染）；read-only 会话连项目都写不了，
  // 回退恢复直接失败。pwsh-sandbox / bash-sandbox 对 danger-full-access
  // 直接不约束（等价本地执行器），无沙箱后端的部署则忽略该字段，两边都成立。
  async function runShell(command, opts) {
    const sp = ctx.get('sandboxPolicy')
    const spec = shell.resolve({
      // 编码前导：pwsh 侧统一 UTF-8 输出（中文机器 GBK 代码页不再乱码）；
      // bash 侧 LC_ALL=C 确定序。各模板自带，这里统一前置注入。
      command: scripts.UTF8_PRELUDE + '\n' + command,
      timeoutMs: (opts && opts.timeoutMs) || 300000,
      stdoutMaxBytes: (opts && opts.stdoutMaxBytes) || 4194304,
      // stdin 是官方 ShellExecRequest 契约字段（bash-local/pwsh 均实现），
      // POSIX 侧用它传 index.json 全文，绕开 argv 长度上限
      ...((opts && opts.stdin !== undefined) ? { stdin: opts.stdin } : {}),
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: (sp && sp.workspaceRoot) || process.cwd() }
    })
    const res = await shell.run(spec)
    const out = (res && res.stdout && res.stdout.text) || ''
    if (res && res.exitCode !== 0) {
      const err = ((res && res.stderr && res.stderr.text) || '').trim() || ('exit ' + String(res.exitCode))
      throw new Error(err.slice(0, 1500))
    }
    return out
  }

  async function resolveRoot(sessionId) {
    const key = sessionId ? String(sessionId) : 'fallback'
    const cached = state.roots.get(key)
    if (cached) return cached
    let root = null
    // 是否为「真实会话来源」的解析结果（live header / 持久化 header）：
    // 只有这类结果才允许进缓存。回退到 sandboxPolicy.workspaceRoot 的临时
    // 结果不缓存——它通常是 harness 启动目录而非会话真实 cwd，一旦缓存，
    // 会话稍后变 live/持久化后仍被旧错误根遮蔽，撤回按钮永不出现。
    let authoritative = false
    if (sessionId) {
      const session = sessions.get(sessionId)
      if (session && session.header && session.header.cwd) {
        root = session.header.cwd
        authoritative = true
      }
    }
    if (!root && sessionId) {
      // 冷会话（尚未 live，如页面先于会话注册就绪加载）从持久化 header
      // 解析真实 cwd，避免回退 workspaceRoot（harness 启动目录）查错
      // store。listSessions 是目录级 header 枚举，不触碰全量日志；解析
      // 失败静默走回退，不阻断主流程。
      try {
        const query = ctx.get('sessionQuery')
        if (query && typeof query.listSessions === 'function') {
          const records = await query.listSessions()
          const rec = (records || []).find((r) => r && r.header && r.header.id === sessionId)
          if (rec && rec.header && rec.header.cwd) {
            root = rec.header.cwd
            authoritative = true
          }
        }
      } catch (error) { /* 冷元数据不可用则走回退 */ }
    }
    if (!root) {
      const sp = ctx.get('sandboxPolicy')
      if (sp && sp.workspaceRoot) root = sp.workspaceRoot
    }
    if (root) {
      // 尾分隔符归一（win32 保 "D:\" 三字符盘根；POSIX 保 "/" 根）：
      // cwd 是否带尾斜杠由上游决定，不归一会让哈希输入不一致（换 store
      // 目录），也会让排除扫描的 ${f#"$root"/} 前缀剥离错一位。
      root = root.replace(/[\\/]+$/, '') || (isWin ? root : '/')
      if (isWin && root.length === 2) root += '\\'
      if (authoritative) state.roots.set(key, root)
    }
    return root
  }

  // 解析 git 可执行文件路径：求值一次并缓存，脚本里用绝对路径调用，
  // 避免每条命令依赖 PATH（DSH 进程 PATH 可能不含 git）。
  async function resolveGit() {
    if (state.gitExe !== null) return state.gitExe
    try {
      const path = scripts.stripBom(await runShell(scripts.resolveGitScript(), { stdoutMaxBytes: 4096 })).trim()
      state.gitExe = path || ''
    } catch (error) {
      state.gitExe = ''
    }
    return state.gitExe
  }

  // win32：哈希在 PowerShell 里算（SHA256 Create 兼容 PS 5.1），连带
  // $env:DSH_HOME / $env:USERPROFILE 的解析都在 shell 侧完成。
  async function homeDirForWin(root) {
    const envHome = (process.env && process.env.DSH_HOME) || ''
    const text = scripts.stripBom(await runShell(scripts.homeDirScript(root, envHome), { stdoutMaxBytes: 4096 })).trim()
    if (!text) return null
    // 折叠 Join-Path 可能带出的连续反斜杠；开头的双反斜杠是 UNC 前缀
    // （DSH_HOME/主目录指到网络盘），折叠掉会把 \\server\share 变成无效
    // 的 \server\share，必须原样保留。
    if (/^\\\\/.test(text)) return '\\\\' + text.slice(2).replace(/\\{2,}/g, '\\')
    return text.replace(/\\{2,}/g, '\\')
  }

  // POSIX：shell 侧只探 bash env 里显式的 $DSH_HOME（DSH 执行器洗刷
  // DSH_* 变量后通常为空）；为空时依次回退 Node 主进程的 DSH_HOME
  // （宿主进程 env，用户导出可见）与 os.homedir()。哈希用 Node crypto
  // 统一算，规避 Linux sha256sum / macOS shasum 的二选一移植成本。
  async function posixHomeBaseResolve() {
    if (state.posixHomeBase === null) {
      let probed = ''
      try {
        probed = (await runShell(scripts.probeHomeScript(), { stdoutMaxBytes: 4096 })).trim()
      } catch (error) {
        probed = ''
      }
      state.posixHomeBase = probed || process.env.DSH_HOME || os.homedir()
    }
    return state.posixHomeBase
  }

  async function homeDirForPosix(root) {
    const base = await posixHomeBaseResolve()
    const hash = crypto.createHash('sha256').update(root, 'utf8').digest('hex')
    return base.replace(/\/+$/, '') + '/dsh-recall-snapshots/' + hash
  }

  async function homeDirFor(root) {
    return isWin ? homeDirForWin(root) : homeDirForPosix(root)
  }

  // 快照容器目录（<homeBase>/dsh-recall-snapshots，不含哈希子目录）：
  // 设置页 exclude-get 的磁盘兜底用——冷启动时会话注册表为空（惰性
  // 载入），但容器目录可能早已存在，此时共享 exclude.txt 仍应可编辑。
  // 目录结构固定 <base>/dsh-recall-snapshots/<hash>，所以容器就是
  // homeDirFor 结果的父目录：JS 侧 slice 推导，不再走第二条 shell 解析链
  // （旧实现里 homeDirScript 与 homeContainerScript 的 $h 链靠注释人工
  // 对齐，存在漂移风险）。失败返回 null 且不缓存，下次调用自然重试。
  async function resolveHomeContainer() {
    if (state.homeContainer) return state.homeContainer
    let container = null
    try {
      const probeRoot = Array.from(state.roots.values())[0] || process.cwd()
      const homeDir = await homeDirFor(probeRoot)
      if (homeDir) container = homeDir.slice(0, homeDir.length - 65)
    } catch (error) {
      container = null
    }
    if (container) state.homeContainer = container
    return container
  }

  // store 形态装配：exclude.txt 是用户自定义排除文件，home 存储时放在
  // dsh-recall-snapshots 根（所有项目共享一份全局配置）；降级存储时放
  // store 目录内部——降级目录本身已被排除规则覆盖，不再往项目根塞文件。
  // git init <dir> 会把真实 git-dir 建在 <dir>/.git，所以 repo 是仓库
  // 工作目录、git 是真实 git-dir——冒烟测试踩过的坑。
  // maxFileBytes 从 config 注入 store：脚本模板（snapshot/diff/rollback
  // 的超大文件剔除）按调用时从 store 读取，用户改 config 后下一条命令
  // 即生效，无需重启——因此用 getter 跟随 config 热更新，而不是创建时
  // 快照（settings 卡片改 maxFileBytes 后 store 缓存不重建）。
  function makeStore(dir, home) {
    const excludeFile = home
      ? dir.slice(0, dir.lastIndexOf(SEP)) + SEP + 'exclude.txt'
      : dir + SEP + 'exclude.txt'
    return {
      dir,
      repo: dir + SEP + 'git',
      git: dir + SEP + 'git' + SEP + '.git',
      home,
      excludeFile,
      get maxFileBytes() { return config.maxFileBytes },
    }
  }

  // 将磁盘枚举出的 store 目录临时包装成 store 对象。全部删除必须覆盖
  // `root.txt`/`index.json` 已失步的历史仓库：这时无法安全地用 root 调
  // `resolveStore`（它可能新建另一个目录），所以直接以已枚举的 dir 为准。
  // home 参数只影响 excludeFile；删除 tag/index 不依赖它，因而未知时用
  // false 也安全。
  function storeFromDir(dir, home) {
    return makeStore(dir, Boolean(home))
  }

  // store 级元数据 root.txt：内容为工作区绝对路径。store 目录名是 root 的
  // 单向 SHA256，反解不了——「快照管理」跨工作区展示时靠它把哈希目录映射
  // 回工作区名。best-effort（失败不阻断主流程），旧 store 在 resolveStore
  // 再次被调用（重启后首个 init/快照/管理列表）时自然补写，存量自愈。
  function persistRootHint(store, root) {
    writeTextViaShell(store.dir + SEP + 'root.txt', root).catch(() => {})
  }

  // 存储根：优先放 DSH home（保持项目目录干净）。shell 以宿主身份执行，
  // 受限会话（workspace-write/read-only）也能写 home；只有 home 本身不可写
  // （如 DSH_HOME 指向只读/网络盘）才降级到项目内（功能优先于干净）。
  async function resolveStore(root) {
    const cached = state.stores.get(root)
    if (cached) return cached
    let homeDir = null
    try {
      homeDir = await homeDirFor(root)
    } catch (error) {
      homeDir = null
    }
    if (homeDir) {
      try {
        await runShell(scripts.mkdirScript(homeDir), { stdoutMaxBytes: 4096 })
        const store = makeStore(homeDir, true)
        state.stores.set(root, store)
        persistRootHint(store, root)
        return store
      } catch (error) {
        recordError('recall home store unavailable, falling back to workspace: ' + String(error))
      }
    }
    const fallback = root + SEP + '.dsh-recall-snapshots'
    await runShell(scripts.mkdirScript(fallback), { stdoutMaxBytes: 4096 })
    const store = makeStore(fallback, false)
    state.stores.set(root, store)
    persistRootHint(store, root)
    return store
  }

  // 旧版迁移：宿主身份执行前的版本在受限会话里会把影子仓库降级到项目内，
  // 这里在下一条消息快照前把它整体迁回 home 并删除项目内目录，恢复
  // 「项目目录干净」。失败节流 5 分钟，避免 home 不可写时每条消息白试。
  async function tryUpgradeToHome(root) {
    const store = state.stores.get(root)
    if (!store || store.home) return store
    const now = Date.now()
    const last = state.homeRetryAt.get(root) || 0
    if (now - last < HOME_RETRY_MS) return store
    state.homeRetryAt.set(root, now)
    let homeDir = null
    try {
      homeDir = await homeDirFor(root)
    } catch (error) {
      homeDir = null
    }
    if (!homeDir) return store
    try {
      await runShell(scripts.mkdirScript(homeDir), { stdoutMaxBytes: 4096 })
      await runShell(scripts.migrateScript(store.dir, homeDir), { timeoutMs: 300000, stdoutMaxBytes: 4096 })
      const upgraded = makeStore(homeDir, true)
      state.stores.set(root, upgraded)
      persistRootHint(upgraded, root)
      state.gitReady.delete(store.git)
      // 旧 store 的 gc 节流凭据随之作废，清掉避免新 store 误读
      state.gcLastAt.delete(store.git)
      state.gcCount.delete(store.git)
      console.error('recall store upgraded to home:', root)
      return upgraded
    } catch (error) {
      recordError('recall home upgrade failed: ' + String(error))
      return store
    }
  }

  // 任意长度文本落盘（index.json / exclude.txt 共用）：win32 走 base64
  // 分块内联（每块 20000 字符，规避 Windows 命令行 32767 上限——DSH 的
  // pwsh 执行器把命令串作为 -Command 的单个 argv 元素 spawn，快照攒到
  // 几百条就超限），首块覆盖、续块追加；POSIX 用官方 ShellExecRequest
  // 的 stdin 契约字段直写全文，不经命令行传参，天然没有 argv 上限。
  // 空内容也落一次写（清空配置/空索引是合法状态），所以 base64 为空串
  // 时仍发一块空 piece，而不是整段跳过留下旧文件。
  async function writeTextViaShell(file, text) {
    const body = String(text == null ? '' : text)
    if (isWin) {
      const b64 = Buffer.from(body, 'utf8').toString('base64')
      const chunks = b64 ? b64.match(/.{1,20000}/g) : ['']
      let first = true
      for (const chunk of chunks) {
        const piece = "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + chunk + "')) | "
        await runShell(scripts.fileWriteCmd(file, piece, first), { stdoutMaxBytes: 4096 })
        first = false
      }
    } else {
      await runShell('cat > ' + scripts.psq(file), { stdin: body, stdoutMaxBytes: 4096 })
    }
  }

  // 建立影子仓库（幂等：gitReady 命中后直接跳过，省掉每条消息一次的
  // config/exclude 重写）。同时回读 gc.stamp 种子化 gc 节流：让「上次 gc
  // 时间」跨重启续存，避免天天重启的机器每开机都来一次全量 gc。
  async function ensureGit(root, store) {
    if (state.gitReady.has(store.git)) return true
    const gitExe = await resolveGit()
    if (!gitExe) return false
    try {
      const out = scripts.stripBom(await runShell(scripts.ensureGitScript(store, gitExe, config.baseExcludes), { stdoutMaxBytes: 4096 }))
      state.gitReady.add(store.git)
      const m = out.match(/GIT_OK\s+(\d+)/)
      state.gcLastAt.set(store.git, m ? parseInt(m[1], 10) * 1000 : Date.now())
      return true
    } catch (error) {
      recordError('recall ensureGit failed: ' + String(error))
      return false
    }
  }

  // 迁移收尾：删除旧版 blobs 格式的项目内 .dsh-recall-snapshots 目录，
  // 仅在 home 存储可用时执行——降级场景下该目录就是新 store，不能删。
  function cleanupLegacy(root) {
    const store = state.stores.get(root)
    if (!store || !store.home) return
    runShell(scripts.legacyRmScript(root + SEP + '.dsh-recall-snapshots'), { timeoutMs: 120000, stdoutMaxBytes: 4096 }).catch(() => {})
  }

  return { state, isWin, scripts, recordError, runShell, writeTextViaShell, resolveRoot, resolveGit, homeDirFor, resolveHomeContainer, resolveStore, storeFromDir, tryUpgradeToHome, ensureGit, cleanupLegacy }
}
