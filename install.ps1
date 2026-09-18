# dsh-omc —— 一键安装（Windows；镜像 install.sh）
#
# 形态照委托方的 `dsh-routing-suite/install.ps1`：分步 + 环境预检 + 着色输出。
#
# 用法：
#   .\install.ps1
#   $env:PROFILE='myco'; .\install.ps1        # 装到别的 profile
#   $env:DRY_RUN='1'; .\install.ps1           # 只看将要做什么
#
# ⚠️ 执行策略：若报"禁止运行脚本" ⇒ 用
#    powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Continue'

$Root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgsDir  = Join-Path $Root 'packages'
$Profile  = if ($env:PROFILE) { $env:PROFILE } else { 'web' }
# ★★ DSH_HOME 优先 —— **不要用 `$HOME`/`$env:USERPROFILE` 直接推**
#   实测：本机 `USERPROFILE` 指向的账号与真实 profile 账号可能不同 ⇒ 会装错地方。
$DshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
# ★ 必须**回写环境变量** —— 否则子进程（node install-teamkit.mjs）会用**它自己的**
#   `os.homedir()` 重新推 DSH_HOME（本机实测：`os.homedir()` 与真实 profile **可能不在同一账号下**）
#   ⇒ 资产装到 A 账号、插件在 B 账号下找它 ⇒【装完像没装】。
$env:DSH_HOME = $DshHome
$DryRun   = ($env:DRY_RUN -eq '1')

function Info($m) { Write-Host "=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "✗ $m" -ForegroundColor Red }

# ★ 逐包状态（`B51`：要能报"装了几个 / 哪个失败"）
$pass = @(); $fail = @(); $skip = @()

Info '[0/5] 环境预检'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Err '未找到 node —— 本套装的安装器（teamkit）需要 Node.js'; exit 1 }
Ok "node: $(node --version)"

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  Warn 'dsh 不在 PATH —— 装配将回退到 `npx @deepseek-ai/dsh`'
  $DshCmd = @('npx', '@deepseek-ai/dsh')
} else {
  Ok "dsh: $($dsh.Source)"
  $DshCmd = @('dsh')
}
Write-Host "仓库目录 : $Root"
Write-Host "DSH_HOME  : $DshHome"
Write-Host "profile   : $Profile"
if ($DryRun) { Warn 'DRY_RUN=1 —— 只打印，不执行' }

Info '[1/5] 逐包装配（packages/ 下的插件包）'
# ⚠️ 只装"有 package.json 的目录" —— `docs/company` 是文档（无 package.json），不是包
foreach ($d in (Get-ChildItem $PkgsDir -Directory | Sort-Object Name)) {
  $name = $d.Name
  if (-not (Test-Path (Join-Path $d.FullName 'package.json'))) {
    Warn "$name：无 package.json（文档目录，跳过装配）"; $skip += $name; continue
  }
  if ($DryRun) {
    Ok "$name：将执行 $($DshCmd -join ' ') plugin --profile $Profile add $($d.FullName)"
    $pass += $name; continue
  }
  # 幂等：`dsh plugin add` 自己按 dependencies/bundles 判重
  & $DshCmd[0] $DshCmd[1..($DshCmd.Count-1)] plugin --profile $Profile add $d.FullName *> $null
  if ($LASTEXITCODE -eq 0) { Ok $name; $pass += $name }
  else { Err "$name（可单独重试：$($DshCmd -join ' ') plugin --profile $Profile add $($d.FullName)）"; $fail += $name }
}

Info '[2/5] 依赖（我们[不 vendoring] 的那两个 ⇒ 从既有仓装）'
# ★★ 为什么不并进本仓（2026-09-18 CEO 裁定"甲"）：
#   `dsh-super-injector` = 运行时注入基础设施（服务所有插件，不只是本套装）⇒ 它的"单仓"已是
#     `dsh-routing-suite`（其 README 逐字：三个组件随本仓库统一演进；上游独立仓库保留用于独立发布）
#     ⇒ 并进来会造【第四份】· `dsh-engram-relay` = 记忆层，同理。
#   ⇒ 本仓是"公司套件"，那两个是"依赖" —— 像 `npm i express`：源码不在你的仓里，但你只敲一条命令。
# ⚠️ 拿不到时要【明说】（不是静默跳过）—— "没装"与"装了但坏了"必须能分辨（B51）
$depRepos = @(
  @{ Name = 'dsh-super-injector'; Url = 'https://github.com/yjh051108/dsh-super-injector'; Why = '运行时注入（dev_* 工具全家桶）—— 缺它则【注入】能力不可用' },
  @{ Name = 'dsh-engram-relay';   Url = 'https://github.com/yjh051108/dsh-engram-relay';   Why = '记忆图谱（engram）—— 缺它则【跨会话记忆】不可用' }
)
$depMissing = @()
foreach ($dep in $depRepos) {
  if ($DryRun) {
    Ok "$($dep.Name)（依赖）：将执行 $($DshCmd -join ' ') plugin --profile $Profile add $($dep.Url)"
    $pass += "$($dep.Name)(dep)"; continue
  }
  & $DshCmd[0] $DshCmd[1..($DshCmd.Count-1)] plugin --profile $Profile add $dep.Url *> $null
  if ($LASTEXITCODE -eq 0) { Ok "$($dep.Name)（依赖）—— $($dep.Why)"; $pass += "$($dep.Name)(dep)" }
  else {
    Warn "⚠️ 无法获取 $($dep.Name)（网络/仓不可达）⇒ **本次未装它**"
    Warn "   后果：$($dep.Why)"
    Warn "   单独装：$($DshCmd -join ' ') plugin --profile $Profile add $($dep.Url)"
    $depMissing += $dep.Name
  }
}

Info '[3/5] 公司层资产（teamkit 安装器）'
$tk = Join-Path $PkgsDir 'teamkit\tools\install-teamkit.mjs'
if (Test-Path $tk) {
  if ($DryRun) { Ok "将执行 node $tk" }
  else {
    node $tk
    if ($LASTEXITCODE -eq 0) { Ok '公司层资产已落地（$DSH_HOME/teamkit）' }
    else { Err "安装器失败：$tk"; $fail += 'teamkit-assets' }
  }
} else { Warn "未找到 $tk（跳过）"; $skip += 'teamkit-assets' }

Info '[4/5] 自检（--check）'
if ((Test-Path $tk) -and (-not $DryRun)) {
  node $tk --check
  if ($LASTEXITCODE -ne 0) { Warn '--check 报不一致（源新、落点旧 ⇒ 再跑一次本脚本即可）' }
}

Info '[5/5] 汇总'
Write-Host "── 合计：装了 $($pass.Count) 个 · 跳过 $($skip.Count) 个 · 失败 $($fail.Count) 个 ──"
foreach ($x in $pass) { Write-Host "  ✅ $x" }
foreach ($x in $skip) { Write-Host "  ⏭  $x（跳过）" }
foreach ($x in $fail) { Write-Host "  ❌ $x（失败）" }
foreach ($x in $depMissing) { Write-Host "  ⚠️  $x（依赖未装 ⇒ 见上文它缺哪个能力）" }
Write-Host ''
Write-Host '⇒ 下一步：'
Write-Host '  · ★ **新开一个会话**（当前窗口的预设列表不会变）⇒ 预设选 `omc`'
Write-Host '  · ★★ **刷新页面**（装了 org-panel 的话 —— 它是 dsh.client ⇒ 不刷新看不到侧边栏「办公室」）'
Write-Host '  · 想看"公司还差什么"⇒ 在新会话里说：teamkit init'
Write-Host ''
if ($fail.Count -gt 0) { Err '有包装配失败 —— 见上文逐包输出（本脚本可重复运行，幂等）'; exit 1 }
Warn '若某个插件装了但"没反应"——先看它是否声明了 `dsh.bundle`：'
Write-Host '   本套装里 teamkit/org-panel/tool-output-guard/web-tools **有**声明；'
Write-Host '   而 issue-watch/model-fit/symbiote **没有** ⇒ 需要走**注入**路径（见 README）。'
Write-Host ''
Write-Host '附：需要构建时（只有 lib/ 缺失时）'
Write-Host '  各包 scripts/build.sh 需要 DSH 源码检出：$env:DSH_CHECKOUT=<checkout>; bash packages/<包>/scripts/build.sh'
Write-Host '  若你只有 npm 装的 dsh（无源码检出）⇒ 请改用 Release 包取件（见 README）。'
