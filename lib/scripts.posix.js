/**
 * dsh-recall-plugin — bash 脚本模板（纯函数，无 ctx 依赖，POSIX 平台专用）
 *
 * 职责：Linux/macOS 下所有 shell 命令的 bash 脚本文本。与 scripts.pwsh.js
 * 导出同名接口，由 store.js 按 process.platform 选择。
 *
 * 硬约束（写每一段前先过一遍）：
 * - macOS 系统 bash 是 3.2：禁用 declare -A / mapfile / ${var,,} 等 bash 4
 *   特性；关联数组需求全部下沉给 awk（POSIX awk 自带），排序交给 sort。
 * - 与 PowerShell 版不同，bash 按行解析时不存在「NUL 丢弃」问题，ls-files
 *   可以用 -z——但 diff/回退的清单对比仍走临时文件 + awk（bash 3.2 无映射
 *   结构），行内路径含 TAB/换行的极端情形与 Windows 版同为已知限制。
 * - 文件名比较、哈希输入全部按字节处理（LC_ALL=C，见 POSIX_PRELUDE），
 *   与 Node 侧 UTF-8 解码各司其职：bash 不转码，字节原样通过。
 */

// 单引号字面量转义：bash 单引号串里不能出现单引号，标准手法是
// 关闭引号 + \' 转义 + 重开（'…'\''…'），杜绝变量展开与注入。
export function psq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// POSIX 统一前导：LC_ALL=C 让 sort/awk 的路径排序按字节确定序（跨机器
// 一致），也避免部分环境 locale 缺失时 git/perl 打 warning。bash 本身
// 不转码 stdout，中文字节原样传给 Node 按 UTF-8 解码，无 Windows 侧
// 的代码页问题。
export const UTF8_PRELUDE = 'export LC_ALL=C'

// 超大文件跳过阈值（字节），默认值与 config.js 的 maxFileBytes 一致；
// 实际生效值以 store.maxFileBytes（用户 config 可调）经 oversizeBlock 注入为准
export const MAX_FILE_BYTES = 104857600

// bash/cat 输出无 BOM；保留同名导出维持两套模板接口一致（幂等无害）
export function stripBom(text) {
  return text.replace(/^\uFEFF/, '')
}

// 嵌套 git 仓库（工作区里的子项目自带 .git）会被 add -A 记成 gitlink
// （160000）；gitlink 残留在 index 时 add -A 会 fatal，且对文件回退毫无
// 意义——所以 add 前后各清一次，子仓库内容不进快照。
// 依赖外层脚本已定义的 $git/$g；被 snapshot/diff/rollback 三处复用。
function dropGitlinksBlock() {
  return [
    '"$git" --git-dir="$g" ls-files -z --stage | while IFS= read -r -d \'\' e; do',
    '  case "$e" in',
    "    160000\\ *) p=${e#*$'\\t'}; \"$git\" --literal-pathspecs --git-dir=\"$g\" update-index --force-remove -- \"$p\" ;;",
    '  esac',
    'done'
  ].join('\n')
}

// 剔除超大文件：find -print0 + read -d '' 按字节安全遍历（文件名含换行
// 也不怕）；2>/dev/null 容忍个别不可访问子目录（杀软锁定、异常 ACL），
// 漏看个别文件是 fail-open，可接受——与 pwsh 版同策略。
// 阈值按调用注入（store.maxFileBytes，config 可调），不读模块常量。
// 依赖外层已定义的 $git/$g/$root。
function oversizeBlock(maxBytes) {
  return [
    'find "$root" -type f -size +' + String(maxBytes || MAX_FILE_BYTES) + 'c -print0 2>/dev/null | while IFS= read -r -d \'\' f; do',
    '  rel=${f#"$root"/}',
    '  "$git" --literal-pathspecs --git-dir="$g" update-index --force-remove -- "$rel"',
    'done'
  ].join('\n')
}

// 用户自定义排除同步：基础排除表 + 用户 exclude.txt 合并重写 info/exclude，
// 再用 ls-files -i -c --exclude-from 找出「已被跟踪但命中排除」的条目清掉。
// 与 pwsh 版同语义：只用 --exclude-from，不引入项目 .gitignore（--exclude-standard）
// 的语义；放在 add -A 之前让排除先生效。read 循环里做 trim + 注释过滤，
// 兼容 Windows 上编辑带 CRLF 的 exclude.txt。
// base 基础排除表按调用注入（config.baseExcludes 可调），不硬编码。
// 依赖外层已定义的 $git/$g。
function excludeSyncBlock(excludeFile, base) {
  const baseList = Array.isArray(base) && base.length ? base : ['.git', 'node_modules/', '.dsh-recall-snapshots/']
  const baseLines = baseList.join('\n') + '\n'
  return [
    'ex_file=' + psq(excludeFile),
    'exc="$g/info/exclude"',
    'user_pats=""',
    'if [ -f "$ex_file" ]; then',
    '  while IFS= read -r line || [ -n "$line" ]; do',
    "    t=${line%$'\\r'}",
    '    t="${t#"${t%%[![:space:]]*}"}"; t="${t%"${t##*[![:space:]]}"}"',
    '    [ -z "$t" ] && continue',
    '    case "$t" in \\#*) continue ;; esac',
    '    user_pats="$user_pats$t\\n"',
    '  done < "$ex_file"',
    'fi',
    "printf '\\n" + baseLines.replace(/\\/g, '\\\\').replace(/%/g, '%%') + "%b' \"$user_pats\" > \"$exc\"",
    '"$git" -c core.quotePath=false --literal-pathspecs --git-dir="$g" ls-files -i -c --exclude-from="$exc" -z 2>/dev/null | while IFS= read -r -d \'\' p; do',
    '  [ -n "$p" ] && "$git" --literal-pathspecs --git-dir="$g" update-index --force-remove -- "$p"',
    'done || true'
  ].join('\n')
}

// 解析 git 可执行文件路径：bash 从 PATH 找（POSIX 上 git 装了就在 PATH，
// 没有 Windows 那种四类安装位置的散装问题）
export function resolveGitScript() {
  return [
    'p=$(command -v git 2>/dev/null || true)',
    '[ -n "$p" ] && printf \'%s\\n\' "$p"',
    'exit 0'
  ].join('\n')
}

// 探测 bash 侧的 home 基底：只回显 bash env 里的 $DSH_HOME（可能为空）。
// 为什么不在这里回退 $HOME：DSH 的 bash 执行器会洗刷子进程的 DSH_* 变量
// （dsh-subprocess scrubbedParentEnv），用户导出的 DSH_HOME 在 bash 里
// 通常不可见——若在此回退 $HOME，Node 侧的字面量回退永远轮不到，
// 「DSH_HOME 指到哪、快照就存哪」会失效。优先级与 pwsh 版对齐：
// bash env 显式值 > Node 主进程 DSH_HOME > $HOME（os.homedir）。
export function probeHomeScript() {
  return 'printf \'%s\' "${DSH_HOME:-}"'
}

export function mkdirScript(dir) {
  return 'mkdir -p -- ' + psq(dir)
}

// 旧版迁移：把降级时代落在项目内的影子仓库整体搬回 home 并删源目录
export function migrateScript(src, dst) {
  return [
    'set -e',
    'src=' + psq(src),
    'dst=' + psq(dst),
    'if [ -e "$src/git" ]; then mv -f "$src/git" "$dst/git"; fi',
    'if [ -e "$src/index.json" ]; then mv -f "$src/index.json" "$dst/index.json"; fi',
    'rm -rf -- "$src"',
    'echo MIGRATE_OK'
  ].join('\n')
}

// 建立影子仓库 + 排除同步 + 回读 gc.stamp（语义与 pwsh 版一致，
// 见 scripts.pwsh.js 同名函数注释）
export function ensureGitScript(store, gitExe, base) {
  return [
    'set -e',
    'git=' + psq(gitExe),
    'repo=' + psq(store.repo),
    'g=' + psq(store.git),
    '[ -d "$g" ] || "$git" init "$repo" >/dev/null',
    '"$git" --git-dir="$g" config core.longpaths true',
    '"$git" --git-dir="$g" config core.autocrlf false',
    '"$git" --git-dir="$g" config advice.addEmbeddedRepo false',
    excludeSyncBlock(store.excludeFile, base),
    'stamp="$g/gc.stamp"',
    'if [ -f "$stamp" ]; then printf \'GIT_OK %s\\n\' "$(head -n1 "$stamp" 2>/dev/null)"; else echo GIT_OK; fi'
  ].join('\n')
}

// 快照：add -A → write-tree → commit-tree（孤儿提交）→ tag（语义同 pwsh 版）。
// tag -f：事件重放/重发会产生重复 messageId，裸 tag 对已存在 tag fatal
// 导致整条快照失败；-f 把 tag 指到最新提交，语义为「同一条消息取最新状态」。
export function snapshotScript(root, store, gitExe, messageId, base) {
  return [
    'set -e',
    'git=' + psq(gitExe),
    'g=' + psq(store.git),
    'root=' + psq(root),
    dropGitlinksBlock(),
    excludeSyncBlock(store.excludeFile, base),
    '"$git" --git-dir="$g" --work-tree="$root" add -A',
    dropGitlinksBlock(),
    oversizeBlock(store.maxFileBytes),
    'tree=$("$git" --git-dir="$g" --work-tree="$root" write-tree)',
    'commit=$("$git" --git-dir="$g" -c user.name=dsh-recall -c user.email=recall@dsh.local commit-tree "$tree" -m ' + psq('snapshot ' + messageId) + ')',
    '"$git" --git-dir="$g" tag -f ' + psq('snap-' + messageId) + ' "$commit" >/dev/null',
    'echo SNAP_OK'
  ].join('\n')
}

// 当前清单/目标树清单落临时文件：两处复用（diff 与 rollback）。
// 关键前置链与 pwsh 版对齐——gitlink 清理 → 排除同步 → add -A → 再清
// gitlink → 超大剔除——少了 add -A 的话 ls-files 读到的还是上一次快照的
// 旧 index，「当前清单」永远等于目标 tag，diff 恒空（调试踩过的坑）。
// 行格式：cur 为「mode sha stage<TAB>path」（取 sha=a[2]），target 为
// 「mode type sha<TAB>path」（取 sha=a[3]）；grep 滤掉 gitlink（160000）行，
// 无匹配时退出码 1，set -e 下统一 || true。
function collectListsBlock(store, gitExe, root, tag, base) {
  return [
    'git=' + psq(gitExe),
    'g=' + psq(store.git),
    'root=' + psq(root),
    dropGitlinksBlock(),
    excludeSyncBlock(store.excludeFile, base),
    '"$git" --git-dir="$g" --work-tree="$root" add -A',
    dropGitlinksBlock(),
    oversizeBlock(store.maxFileBytes),
    'tmpc=' + psq(store.dir + '/diff-cur.$$'),
    'tmpt=' + psq(store.dir + '/diff-tgt.$$'),
    '"$git" -c core.quotePath=false --git-dir="$g" --work-tree="$root" ls-files --stage | grep -v \'^160000 \' > "$tmpc" || true',
    '"$git" -c core.quotePath=false --git-dir="$g" ls-tree -r ' + psq(tag) + ' | grep -v \'^160000 \' > "$tmpt" || true'
  ].join('\n')
}

// diff：awk 一趟对比 cur/target（cur 侧 "mode sha<TAB>path" 取 a[2]，
// target 侧 "mode type sha<TAB>path" 取 a[3]），输出 TSV「kind<TAB>path」
// 逐行打印，Node 侧解析（不在 bash 里拼 JSON——没有 jq 依赖、
// 转义路径的坑也一并消失）。sort -k2 按 path 确定序，与 pwsh 版对齐。
export function diffScript(root, store, gitExe, tag, base) {
  return [
    'set -e -o pipefail',
    collectListsBlock(store, gitExe, root, tag, base),
    "trap 'rm -f \"$tmpc\" \"$tmpt\"' EXIT",
    'awk -F\'\\t\' -v OFS=\'\\t\' \'',
    '  FNR==1 { fidx++ }',
    '  fidx==1 { split($1, a, " "); cur[$2]=a[2]; next }',
    '  { split($1, a, " "); tgt[$2]=a[3] }',
    '  END {',
    '    for (p in cur) {',
    '      if (p in tgt) { if (tgt[p] != cur[p]) print "modified", p }',
    '      else print "added", p',
    '    }',
    '    for (p in tgt) if (!(p in cur)) print "restored", p',
    '  }',
    "' \"$tmpc\" \"$tmpt\" | sort -t$'\\t' -k2,2",
    'exit 0'
  ].join('\n')
}

// 回退：archive | tar 直接管到工作区（无需 Windows 的 zip 中转），
// 空目标跳过；再删除「当前有、目标无」的文件（awk 求差集）。
// pipefail 保证 git archive 失败时整条非零退出。
export function rollbackScript(root, store, gitExe, tag, base) {
  return [
    'set -e -o pipefail',
    collectListsBlock(store, gitExe, root, tag, base),
    "trap 'rm -f \"$tmpc\" \"$tmpt\"' EXIT",
    'restored=$(wc -l < "$tmpt" | tr -d \' \')',
    'if [ "$restored" -gt 0 ]; then',
    // -m（--touch）：解包不恢复归档成员的 mtime（文件 mtime = 解包时刻）。
    // 必须如此：tar 默认保留归档内 mtime，而快照→篡改→回滚常在数秒内
    // 完成，恢复出的 mtime 可能与 index 里旧条目的 stat 记录碰撞，下一次
    // add -A 的 stat 缓存误判「未变更」跳过 re-hash——工作区内容与快照
    // 从此脱钩（实测解包出篡改前内容的间歇性失败）。Windows 版的
    // Expand-Archive 天然把 mtime 设为解包时刻，无此问题；-m 让 tar 对齐。
    '  "$git" --git-dir="$g" archive ' + psq(tag) + ' | tar -x -m -C "$root"',
    'fi',
    'tmpd=' + psq(store.dir + '/diff-del.$$'),
    "trap 'rm -f \"$tmpc\" \"$tmpt\" \"$tmpd\"' EXIT",
    'awk -F\'\\t\' \'',
    '  FNR==1 { fidx++ }',
    '  fidx==1 { cur[$2]=1; next }',
    '  { tgt[$2]=1 }',
    '  END { for (p in cur) if (!(p in tgt)) print p }',
    "' \"$tmpc\" \"$tmpt\" > \"$tmpd\"",
    'deleted=0',
    'while IFS= read -r p; do',
    '  [ -z "$p" ] && continue',
    '  rm -f -- "$root/$p" && deleted=$((deleted + 1))',
    'done < "$tmpd"',
    'echo "ROLLBACK_OK $deleted $restored"'
  ].join('\n')
}

export function listTagsScript(store, gitExe) {
  return [
    'set -e',
    'git=' + psq(gitExe),
    'g=' + psq(store.git),
    // 仅创建过 store 目录、尚未产生过快照时没有 git/.git；把它视为
    // 空快照仓库而非错误，全部删除仍可顺便清空其陈旧 index.json。
    '[ -d "$g" ] || exit 0',
    '"$git" --git-dir="$g" tag -l \'snap-*\''
  ].join('\n')
}

// 定期 gc（语义同 pwsh 版）；date +%s 写秒级时间戳，JS 侧 ×1000
export function gcScript(store, gitExe) {
  return [
    'set -e',
    'git=' + psq(gitExe),
    'g=' + psq(store.git),
    '"$git" --git-dir="$g" gc --quiet --prune=now',
    'date +%s > "$g/gc.stamp"',
    'echo GC_OK'
  ].join('\n')
}

// 删除指定快照 tag（会话已删联动清理用）：tag -d 对不存在 tag 非零退出，
// || true 吞掉——best-effort，残留 tag 由下次清理幂等收尾（同 pwsh 版）
export function purgeTagsScript(store, gitExe, tags) {
  return [
    'git=' + psq(gitExe),
    'g=' + psq(store.git),
    '"$git" --git-dir="$g" tag -d ' + tags.map((t) => psq(t)).join(' ') + ' >/dev/null 2>&1 || true',
    'echo PURGE_DONE'
  ].join('\n')
}

// 索引读取（写入走 stdin：见 snapshots.js saveIndex 的 POSIX 分支，
// 不经命令行传参，天然没有 32767/128KB argv 上限问题）
export function indexReadCmd(dir) {
  return 'cat ' + psq(dir + '/index.json') + ' 2>/dev/null || true'
}

// 旧版项目内 blobs 目录清理（仅 home 存储可用时调用）
export function legacyRmScript(path) {
  return 'rm -rf -- ' + psq(path)
}

// exclude.txt 原文读取（设置页编辑用）：缺失文件 cat 报错走 2>/dev/null ||
// true 吞掉输出空串——与 pwsh 版同语义，按「尚未配置」处理；写入不走
// 模板函数，调用方直接 cat > file + stdin（同 saveIndex 的 POSIX 分支）。
export function excludeReadCmd(file) {
  return 'cat ' + psq(file) + ' 2>/dev/null || true'
}

// 目录存在探测：YES/NO 定长标记与 pwsh 版逐字同语义（容器路径本身在
// JS 侧解析，POSIX 不需要 homeContainerScript 的 shell 版）。
export function dirExistsScript(dir) {
  return '[ -d ' + psq(dir) + ' ] && echo YES || echo NO'
}

// 影子仓库磁盘占用（设置页快照管理卡片用，语义同 pwsh 版）
export function countObjectsScript(store, gitExe) {
  return [
    'git=' + psq(gitExe),
    'g=' + psq(store.git),
    '"$git" --git-dir="$g" count-objects -v'
  ].join('\n')
}

// 目录总大小（字节）：du -sk 取 KiB 再 ×1024；macOS/BSD du 与 GNU du
// 对 -sk 的输出格式一致（"大小<TAB>路径"），awk 取首列最稳。
export function diskUsageScript(dir) {
  return 'du -sk ' + psq(dir) + ' 2>/dev/null | awk \'{print $1 * 1024}\''
}

// 列目录下所有一级子目录全路径：manage/list 枚举 home 容器下的所有
// 哈希子目录用（每个子目录是一个工作区的 store）。find -maxdepth 1
// 限定深度避免递归，2>/dev/null 容忍个别不可读条目。
export function listSubdirsScript(dir) {
  return 'find ' + psq(dir) + ' -maxdepth 1 -mindepth 1 -type d 2>/dev/null'
}

// 批量 dump 全部 store 元数据（与 pwsh 版 storesDumpScript 同格式、
// 同语义，见其注释）：一条 shell 拿全部目录的 root.txt + index.json。
// bash 3.2 兼容：数组 + += 均可用，glob 无匹配时字面量经 [ -d ] 过滤。
// root.txt 经 tr 去掉可能的 CRLF 再拼单行，防标记结构被打乱。
export function storesDumpScript(container, extraDirs) {
  const lines = ['set -e', 'dirs=()']
  if (container) {
    lines.push('base=' + psq(container))
    lines.push('if [ -d "$base" ]; then')
    lines.push('  for d in "$base"/*/; do')
    // if 而不是 [ ] && ：glob 无匹配时条件为假，&& 链返回非零会触发 set -e
    lines.push('    if [ -d "$d" ]; then dirs+=("${d%/}"); fi')
    lines.push('  done')
    lines.push('fi')
  }
  for (const d of extraDirs || []) lines.push('dirs+=(' + psq(d) + ')')
  lines.push(
    'for d in "${dirs[@]}"; do',
    '  [ -d "$d" ] || continue',
    '  echo "==DIR $d"',
    '  if [ -f "$d/root.txt" ]; then',
    '    printf "ROOT %s\\n" "$(cat "$d/root.txt" 2>/dev/null | tr -d \'\\r\\n\')"',
    '  else',
    '    echo "ROOT "',
    '  fi',
    '  echo INDEXBEGIN',
    '  cat "$d/index.json" 2>/dev/null',
    '  echo INDEXEND',
    'done',
    'exit 0'
  )
  return lines.join('\n')
}
