/**
 * dsh-recall-plugin — PowerShell 脚本模板（纯函数，无 ctx 依赖，win32 专用）
 *
 * 职责：集中拼装所有发给 shell 的 PowerShell 脚本文本。只做字符串构造，
 * 不执行、无状态；执行侧（runShell）见 store.js，调用侧见
 * snapshots.js / maintenance.js。集中在这里是为了：
 * 1) PS 5.1 / pwsh 7 双版本兼容的坑只在一处处理；
 * 2) 脚本片段（gitlink 清理、超大文件排除、用户排除同步）在多个
 *    流程里逐字复用，散落各处必然改漏。
 * POSIX（Linux/macOS）对应模板见 scripts.posix.js，两者导出同名接口，
 * 由 store.js 按 process.platform 选择。
 */

// 单引号字面量转义：PS 单引号串里只有 '' 表示一个单引号，且不展开变量，
// 是把 JS 值安全嵌进命令串的唯一可靠方式（杜绝 $、反引号注入）。
export function psq(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

// 统一 UTF-8 输出前导：中文等非 ASCII 机器的默认代码页（如 GBK）下，
// PowerShell 重定向 stdout 按 [Console]::OutputEncoding 编码，而 DSH 按
// UTF-8 解码——不强制时含中文的用户名/路径会变乱码。PS 5.1 / 7 均支持。
export const UTF8_PRELUDE = '$OutputEncoding = [Text.UTF8Encoding]::new($false)\ntry { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}'

// 超大文件跳过阈值：git 对象库对大文件极不友好，回退语义也不该被一个
// 200MB 的构建产物拖垮。默认值与 config.js 的 maxFileBytes 一致；实际
// 生效值以 store.maxFileBytes（用户 config 可调）经 oversizeBlock 注入为准。
export const MAX_FILE_BYTES = 104857600

// 去除 PS 5.1 Set-Content -Encoding utf8 写出的 BOM：JSON 解析前必须剥掉，
// 否则 JSON.parse 把 BOM 当正文首字符直接抛错。
export function stripBom(text) {
  return text.replace(/^\uFEFF/, '')
}

// 嵌套 git 仓库（工作区里的子项目自带 .git）会被 add -A 记成 gitlink（160000）；
// gitlink 残留在 index 时 add -A 会 fatal "in unpopulated submodule"，
// 且 gitlink 对文件回退毫无意义——所以 add 前后各清一次，子仓库内容不进快照。
// 依赖外层脚本已定义的 $git/$g；被 snapshot/diff/rollback 三处复用。
function dropGitlinksBlock() {
  return [
    "& $git --git-dir=$g ls-files --stage | Where-Object { $_ -like '160000*' } | ForEach-Object {",
    "  $p = ($_ -split \"`t\")[1]",
    '  & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $p',
    '}'
  ].join('\n')
}

// 剔除超大文件：扫描加 SilentlyContinue 是因为 EAP=Stop 下个别不可访问
// 子目录（杀软锁定、异常 ACL、损坏 junction）的非致命错误会被升级为终止，
// 整条快照作废；本扫描只用于排除超大文件，漏看个别文件是 fail-open，可接受。
// 阈值按调用注入（store.maxFileBytes，config 可调），不读模块常量。
// 依赖外层已定义的 $git/$g/$root。
function oversizeBlock(maxBytes) {
  return [
    'Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt ' + String(maxBytes || MAX_FILE_BYTES) + ' } | ForEach-Object {',
    "  $rel = $_.FullName.Substring($root.Length + 1).Replace('\\','/')",
    '  & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $rel',
    '}'
  ].join('\n')
}

// 用户自定义排除同步：把基础排除表与用户 exclude.txt 合并重写进 info/exclude，
// 再用 ls-files -i -c 找出「已被跟踪但命中排除」的条目从 index 清掉。
// - 只用 --exclude-from 指 info/exclude，不用 --exclude-standard：后者会
//   连带项目自己的 .gitignore 语义（后加 ignore 的已跟踪文件会被悄悄移出
//   快照），行为超出用户配置的本意。
// - 放在 add -A 之前：排除表先生效，新增的排除路径根本不会被暂存，
//   已跟踪的旧条目由 ls-files -i -c 补刀，两条路径一次覆盖。
// - 首行留空元素吸收 PS 5.1 utf8 BOM（BOM 粘在首行会废掉第一条模式），
//   与下方 ensureGitScript 的老技巧一致。
// - base 基础排除表按调用注入（config.baseExcludes 可调），不硬编码。
// - 依赖外层已定义的 $git/$g；被 ensureGit/snapshot/diff/rollback 复用，
//   因此 exclude.txt 的改动在下一次快照/diff/回退时即时生效，无需重启。
function excludeSyncBlock(excludeFile, base) {
  const baseList = (Array.isArray(base) && base.length ? base : ['.git', 'node_modules/', '.dsh-recall-snapshots/']).map(psq).join(',')
  return [
    "$exFile = " + psq(excludeFile),
    '$userPats = @()',
    "if (Test-Path -LiteralPath $exFile) { $userPats = @(Get-Content -LiteralPath $exFile -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $t = $_.Trim(); $t -and -not $t.StartsWith('#') }) }",
    "$lines = @('') + @(" + baseList + ") + $userPats",
    "$exc = Join-Path $g 'info\\exclude'",
    'Set-Content -LiteralPath $exc -Value $lines -Encoding utf8',
    '& $git -c core.quotePath=false --literal-pathspecs --git-dir=$g ls-files -i -c --exclude-from=$exc | ForEach-Object {',
    '  if ($_) { & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $_ }',
    '}'
  ].join('\n')
}

// 解析 git 可执行文件路径：DSH 进程 PATH 可能不含 git，脚本里用绝对路径调用。
// 逐项判空再 Join-Path：个别 env 在特殊环境（32 位系统无 ProgramFiles(x86)）
// 取到 null，EAP=Stop 下 Join-Path 抛错会让整个探测失败、误报 gitMissing。
export function resolveGitScript() {
  return [
    '$candidates = @()',
    '$g = (Get-Command git -ErrorAction SilentlyContinue).Source',
    'if ($g) { $candidates += $g }',
    "if (${env:ProgramFiles}) { $candidates += (Join-Path ${env:ProgramFiles} 'Git\\cmd\\git.exe') }",
    "if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Git\\cmd\\git.exe') }",
    "if (${env:LocalAppData}) { $candidates += (Join-Path ${env:LocalAppData} 'Programs\\Git\\cmd\\git.exe') }",
    "$g = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1",
    'if ($g) { Write-Output $g }'
  ].join('\n')
}

// 计算项目对应的 home 存储目录（DSH_HOME 优先，否则 ~/.dsh）。
// 哈希用 Create()+ComputeHash+BitConverter 而不是 HashData+ToHexString：
// 后两者是 .NET 5+（仅 PS 7）API，别人机器的 shell 若是 Windows PowerShell
// 5.1 会抛错，导致 home 存储永远降级到项目内；前者两个版本都可用。
export function homeDirScript(root, envHome) {
  return [
    '$r = ' + psq(root),
    "$h = if ($env:DSH_HOME) { $env:DSH_HOME } elseif (" + psq(envHome) + ") { " + psq(envHome) + " } else { Join-Path $env:USERPROFILE \".dsh\" }",
    '$sha = [Security.Cryptography.SHA256]::Create()',
    "$hex = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($r))) -replace '-','').ToLower()",
    "Write-Output (Join-Path $h ('dsh-recall-snapshots\\' + $hex))"
  ].join('\n')
}

export function mkdirScript(dir) {
  return 'New-Item -ItemType Directory -Force -Path ' + psq(dir) + ' | Out-Null'
}

// 旧版迁移：把降级时代落在项目内的影子仓库整体搬回 home 并删源目录
export function migrateScript(src, dst) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$src = ' + psq(src),
    '$dst = ' + psq(dst),
    "if (Test-Path -LiteralPath (Join-Path $src 'git')) { Move-Item -LiteralPath (Join-Path $src 'git') -Destination (Join-Path $dst 'git') -Force }",
    "if (Test-Path -LiteralPath (Join-Path $src 'index.json')) { Move-Item -LiteralPath (Join-Path $src 'index.json') -Destination (Join-Path $dst 'index.json') -Force }",
    'Remove-Item -Recurse -Force -LiteralPath $src -ErrorAction SilentlyContinue',
    "Write-Output 'MIGRATE_OK'"
  ].join('\n')
}

// 建立影子仓库：普通 init（index 留在仓库内跨快照复用，git add 的 stat 缓存
// 让未变文件近乎零成本），core.longpaths 放开 Windows 深路径。
// autocrlf=false：按原始字节入快照（回退时逐字节还原），也避免用户全局
// autocrlf=true 时的 LF/CRLF stderr 警告；addEmbeddedRepo=false：嵌套仓库
// hint/warning 走 stderr，在 DSH shell（EAP=Stop）下会让整条脚本非零退出，
// 必须在仓库级配置里静默掉。
// 结尾回读 gc.stamp（maintenance.js 上次 gc 时间戳）：让重启后的 gc 节流
// 不归零——没有它，天天重启 DSH 的用户每次开机第一条消息都会触发一次
// 全量 gc，纯浪费。
export function ensureGitScript(store, gitExe, base) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$git = ' + psq(gitExe),
    '$repo = ' + psq(store.repo),
    '$g = ' + psq(store.git),
    'if (-not (Test-Path -LiteralPath $g)) {',
    '  & $git init $repo | Out-Null',
    '}',
    '& $git --git-dir=$g config core.longpaths true',
    '& $git --git-dir=$g config core.autocrlf false',
    '& $git --git-dir=$g config advice.addEmbeddedRepo false',
    excludeSyncBlock(store.excludeFile, base),
    "$stamp = Join-Path $g 'gc.stamp'",
    "if (Test-Path -LiteralPath $stamp) { Write-Output ('GIT_OK ' + [String](Get-Content -LiteralPath $stamp -TotalCount 1 -ErrorAction SilentlyContinue)) } else { Write-Output 'GIT_OK' }"
  ].join('\n')
}

// 快照：git add -A 增量同步 index（.gitignore/exclude 语义由 git 统一处理），
// write-tree 生成树、commit-tree 生成无父孤儿提交、tag 保对象可达。
// 不做 parent 链、不修剪：像 TraeWork 一样保留全量历史，tag 永远可查。
// tag -f：事件重放/重发会产生重复 messageId，裸 tag 对已存在 tag fatal
// 导致整条快照失败；commit-tree 每次生成新对象，-f 把 tag 指到最新提交，
// 与「同一条消息重快照取最新状态」的语义一致。
export function snapshotScript(root, store, gitExe, messageId, base) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$git = ' + psq(gitExe),
    '$g = ' + psq(store.git),
    '$root = ' + psq(root),
    dropGitlinksBlock(),
    excludeSyncBlock(store.excludeFile, base),
    '& $git --git-dir=$g --work-tree=$root add -A',
    dropGitlinksBlock(),
    oversizeBlock(store.maxFileBytes),
    '$tree = (& $git --git-dir=$g --work-tree=$root write-tree).Trim()',
    "$commit = (& $git --git-dir=$g -c user.name=dsh-recall -c user.email=recall@dsh.local commit-tree $tree -m ('snapshot ' + " + psq(messageId) + ")).Trim()",
    '& $git --git-dir=$g tag -f ' + psq('snap-' + messageId) + ' $commit | Out-Null',
    "Write-Output 'SNAP_OK'"
  ].join('\n')
}

// diff：把当前状态 add 进 index 后用 ls-files --stage 取当前清单，
// 与目标 tag 的 ls-tree 对比——ignore/exclude 语义两侧一致，不会把
// node_modules 等误报为“新增”。
// 不用 -z：PowerShell 捕获原生命令输出会丢弃含 NUL 的行（实测整段变 null），
// 改用 core.quotePath=false 让非 ASCII 路径原样输出，逐行按 TAB 解析。
// 代价是文件名含换行的极端情况会解析错乱——概率可忽略，记录为已知限制。
// （UTF-8 输出编码由 runShell 注入的 UTF8_PRELUDE 统一保证，此处不再重复设置。）
export function diffScript(root, store, gitExe, tag, base) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$git = ' + psq(gitExe),
    '$g = ' + psq(store.git),
    '$root = ' + psq(root),
    dropGitlinksBlock(),
    excludeSyncBlock(store.excludeFile, base),
    '& $git --git-dir=$g --work-tree=$root add -A',
    dropGitlinksBlock(),
    oversizeBlock(store.maxFileBytes),
    '$curOut = & $git -c core.quotePath=false --git-dir=$g --work-tree=$root ls-files --stage',
    // 旧 tag 的树里可能仍有 gitlink（修复前留下的），从目标侧一并剔除，
    // 否则 diff 会报出“恢复 dsh-recall-plugin”这类幻影条目
    "$targetOut = @(& $git -c core.quotePath=false --git-dir=$g ls-tree -r " + psq(tag) + " | Where-Object { -not $_.StartsWith('160000') })",
    '$curMap = @{}',
    'foreach ($r in @($curOut)) {',
    '  if (-not $r) { continue }',
    '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
    '  $sha = ($r.Substring(0, $tab) -split " ")[1]',
    '  $curMap[$path] = $sha',
    '}',
    '$targetMap = @{}',
    'foreach ($r in @($targetOut)) {',
    '  if (-not $r) { continue }',
    '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
    '  $sha = ($r.Substring(0, $tab) -split " ")[2]',
    '  $targetMap[$path] = $sha',
    '}',
    '$result = @()',
    'foreach ($k in $curMap.Keys) {',
    '  if (-not $targetMap.ContainsKey($k)) { $result += [pscustomobject]@{ rel = $k; kind = "added" } }',
    '  elseif ($targetMap[$k] -ne $curMap[$k]) { $result += [pscustomobject]@{ rel = $k; kind = "modified" } }',
    '}',
    'foreach ($k in $targetMap.Keys) {',
    '  if (-not $curMap.ContainsKey($k)) { $result += [pscustomobject]@{ rel = $k; kind = "restored" } }',
    '}',
    '$sorted = @($result | Sort-Object rel)',
    'Write-Output (ConvertTo-Json -InputObject $sorted -Depth 3 -Compress)'
  ].join('\n')
}

// 回退：恢复侧走 git archive --format=zip + Expand-Archive，删除侧按
// 清单移除「当前有、目标无」的文件。曾尝试 tar 优先（bsdtar 性能更好），
// 实测否决：System32\bsdtar 在 GBK 活动代码页（ACP=936）机器上把 tar
// 流里的 UTF-8 文件名按 ANSI 解码——中文文件名解包成「璇存槑.txt」式的
// 乱码新文件，原路径反而丢失；且 tar -m 才是必需的（stat 缓存碰撞），
// Expand-Archive 天然把 mtime 设为解包时刻，zip 链路反而更稳。
// 空树跳过 archive（空 zip 会让 Expand-Archive 报错），只执行删除。
// 回退后保留快照 tag 与索引：git delta 空间便宜，保留历史可再次
// 用该快照恢复（幂等），也避免误回退后无法找回。
export function rollbackScript(root, store, gitExe, tag, base) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$git = ' + psq(gitExe),
    '$g = ' + psq(store.git),
    '$root = ' + psq(root),
    dropGitlinksBlock(),
    excludeSyncBlock(store.excludeFile, base),
    '& $git --git-dir=$g --work-tree=$root add -A',
    dropGitlinksBlock(),
    oversizeBlock(store.maxFileBytes),
    // 同 diffScript：-z 的 NUL 输出会被 PowerShell 捕获丢弃，改为逐行 + quotePath=false
    '$curOut = & $git -c core.quotePath=false --git-dir=$g --work-tree=$root ls-files --stage',
    "$targetOut = @(& $git -c core.quotePath=false --git-dir=$g ls-tree -r " + psq(tag) + " | Where-Object { -not $_.StartsWith('160000') })",
    '$targetMap = @{}',
    'foreach ($r in @($targetOut)) {',
    '  if (-not $r) { continue }',
    '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
    '  $targetMap[$path] = $true',
    '}',
    '$restored = $targetMap.Count',
    'if ($restored -gt 0) {',
    '  $zip = ' + psq(store.dir + '\\restore-tmp.zip'),
    '  & $git --git-dir=$g archive --format=zip --output=$zip ' + psq(tag),
    '  Expand-Archive -LiteralPath $zip -DestinationPath $root -Force',
    '  Remove-Item -LiteralPath $zip -Force',
    '}',
    '$deleted = 0',
    'foreach ($r in @($curOut)) {',
    '  if (-not $r) { continue }',
    '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
    '  if (-not $targetMap.ContainsKey($path)) {',
    "    $full = Join-Path $root ($path.Replace('/','\\'))",
    '    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Force; $deleted++ }',
    '  }',
    '}',
    "Write-Output ('ROLLBACK_OK ' + $deleted + ' ' + $restored)"
  ].join('\n')
}

export function listTagsScript(store, gitExe) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$git = ' + psq(gitExe),
    '$g = ' + psq(store.git),
    // 仅创建过 store 目录、尚未产生过快照时没有 git/.git；把它视为
    // 空快照仓库而非错误，全部删除仍可顺便清空其陈旧 index.json。
    'if (-not (Test-Path -LiteralPath $g -PathType Container)) { exit 0 }',
    '& $git --git-dir=$g tag -l "snap-*"'
  ].join('\n')
}

// 定期 gc：全量保留策略下对象只增不减，且默认 loose 存储（每对象一个
// 小文件，NTFS 最小簇 4KB）非常浪费；gc 压 pack + 跨版本 delta 通常省一半
// 以上。--prune=now 让「会话删除联动清理」删掉的 tag 立即真正释放空间
// （默认 2 周宽限期内对象仍占盘）——安全前提是 gc 与快照在同一条串行
// 队列里执行（见 maintenance.js），不存在并发竞态。
// 结尾写 gc.stamp：跨重启的节流凭据（ensureGit 回读）。
export function gcScript(store, gitExe) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$git = ' + psq(gitExe),
    '$g = ' + psq(store.git),
    '& $git --git-dir=$g gc --quiet --prune=now',
    "Set-Content -LiteralPath (Join-Path $g 'gc.stamp') -Value ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()) -Encoding ascii",
    "Write-Output 'GC_OK'"
  ].join('\n')
}

// 删除指定快照 tag（会话已删联动清理用）。best-effort：个别 tag 已不存在时
// git 非零退出，但其余 tag 已被删除——所以显式 exit 0 吞掉退出码，
// 残留的由下一次清理幂等地收尾；JS 侧无论脚本结果都会同步索引。
export function purgeTagsScript(store, gitExe, tags) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$git = ' + psq(gitExe),
    '$g = ' + psq(store.git),
    '& $git --git-dir=$g tag -d ' + tags.map((t) => psq(t)).join(' '),
    "Write-Output 'PURGE_DONE'",
    'exit 0'
  ].join('\n')
}

// 任意长度文本写入（index.json / exclude.txt 共用）：base64 以内联字面量
// 传递时受 Windows 命令行 32767 字符硬上限约束（DSH 的 pwsh 执行器把命令串
// 作为 -Command 的单个 argv 元素 spawn），快照攒到几百条就超限 spawn 失败
// ——按 20000 字符分块（分块循环在 store.js writeTextViaShell），首块
// Set-Content 覆盖、续块 Add-Content 追加。piece 为当前块的 base64 解码
// 表达式，first 决定覆盖还是追加。目录创建归调用方（writeExclude 的
// mkdirScript 兜底 / index.json 的父目录在建仓时已存在）。
export function fileWriteCmd(file, piece, first) {
  if (first) {
    return piece + 'Set-Content -LiteralPath ' + psq(file) + ' -Encoding utf8 -NoNewline'
  }
  return piece + 'Add-Content -LiteralPath ' + psq(file) + ' -Encoding utf8 -NoNewline'
}

export function indexReadCmd(dir) {
  return 'Get-Content -LiteralPath ' + psq(dir + '\\index.json') + ' -Raw -ErrorAction SilentlyContinue'
}

// 旧版项目内 blobs 目录清理（仅 home 存储可用时调用，见 store.js cleanupLegacy）
export function legacyRmScript(path) {
  return 'Remove-Item -Recurse -Force -LiteralPath ' + psq(path)
}

// exclude.txt 原文读取（设置页编辑用）：-Raw 保留换行与空行结构，让用户
// 看到的就是落盘原文；文件不存在时 SilentlyContinue 输出空串，JS 侧按
// 「尚未配置」处理——设置页在快照存储刚建好、exclude.txt 还没写过时也会打开。
export function excludeReadCmd(file) {
  return 'Get-Content -LiteralPath ' + psq(file) + ' -Raw -Encoding UTF8 -ErrorAction SilentlyContinue'
}

// 目录存在探测：输出定长 YES/NO 标记（与 posix 版逐字同语义），
// JS 侧统一按 'YES' 判定，不依赖退出码——runShell 对非零退出直接抛错。
export function dirExistsScript(dir) {
  return "if (Test-Path -LiteralPath " + psq(dir) + " -PathType Container) { Write-Output 'YES' } else { Write-Output 'NO' }"
}

// 影子仓库磁盘占用（设置页快照管理卡片用）：git 自带的 count-objects -v
// 输出含 size-pack（KiB 单位，pack 文件总大小），足够向用户展示量级，
// 不需要逐文件累加的慢扫描。
export function countObjectsScript(store, gitExe) {
  return [
    '$git = ' + psq(gitExe),
    '$g = ' + psq(store.git),
    '& $git --git-dir=$g count-objects -v'
  ].join('\n')
}

// 目录总大小（字节）：降级存储时 git-dir 不是唯一占用（blobs 残留等），
// 直接量目录最诚实。SilentlyContinue 容忍个别不可读文件。
export function diskUsageScript(dir) {
  return "(Get-ChildItem -LiteralPath " + psq(dir) + " -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum"
}

// 列目录下所有一级子目录全路径：manage/list 枚举 home 容器下的所有
// 哈希子目录用（每个子目录是一个工作区的 store）。SilentlyContinue
// 容忍个别不可读条目。输出每行一个全路径，JS 侧按换行拆分。
export function listSubdirsScript(dir) {
  return "Get-ChildItem -LiteralPath " + psq(dir) + " -Directory -ErrorAction SilentlyContinue | ForEach-Object { Write-Output $_.FullName }"
}

// 批量 dump 全部 store 的元数据：一条 shell 拿「容器下所有子目录 +
// 额外降级目录」的 root.txt 与 index.json 全文。为什么批量：旧实现
// 每个目录 2 条 shell（读 index + 读 root.txt）串行跑，20 个目录就是
// 40 次 PowerShell 冷启动（每次 0.3-1s）——快照管理列表 20 秒级慢的
// 根因。输出定界格式（JS 侧 parseStoresDump 状态机解析）：
//   ==DIR <目录>
//   ROOT <工作区路径或空>
//   INDEXBEGIN / index.json 原文 / INDEXEND
// 标记行不会与内容混淆：root 路径不含换行（Windows 非法字符），JSON
// 单行以 [ 或 { 起头、内部路径同样不含换行。
export function storesDumpScript(container, extraDirs) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$dirs = @()'
  ]
  if (container) {
    lines.push('$base = ' + psq(container))
    lines.push("$dirs += @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })")
  }
  for (const d of extraDirs || []) lines.push('$dirs += ' + psq(d))
  lines.push(
    'foreach ($d in $dirs) {',
    '  if (-not $d) { continue }',
    '  if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }',
    '  Write-Output ("==DIR " + $d)',
    "  $rt = Join-Path $d 'root.txt'",
    "  if (Test-Path -LiteralPath $rt -PathType Leaf) {",
    "    $rv = (Get-Content -LiteralPath $rt -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)",
    // 先规整成单行再拼接：root 是单行路径，但用户手改文件可能带 CRLF，
    // 直接拼会把标记结构打乱
    "    if ($rv) { $rv = $rv.Trim() }",
    "    Write-Output ('ROOT ' + $rv)",
    '  } else {',
    "    Write-Output 'ROOT '",
    '  }',
    "  Write-Output 'INDEXBEGIN'",
    "  $ix = Join-Path $d 'index.json'",
    "  if (Test-Path -LiteralPath $ix -PathType Leaf) {",
    '    $j = Get-Content -LiteralPath $ix -Raw -Encoding UTF8 -ErrorAction SilentlyContinue',
    '    if ($j) { Write-Output $j.TrimEnd() }',
    '  }',
    "  Write-Output 'INDEXEND'",
    '}',
    'exit 0'
  )
  return lines.join('\n')
}
