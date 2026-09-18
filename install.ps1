# dsh-omc —— 一键安装（Windows；镜像 install.sh）
#
# ## 本仓是什么（★ 一句）
#   ★ 本仓 = **公司套件**（OMC）：`packages/teamkit`（公司层本体）· `packages/org-panel`（侧边栏办公室）
#     · `docs/company/`（怎么开公司 · 先读 INDEX.md）
#   ★★ 两个依赖（**不在本仓 · 从各自仓装**）：`dsh-super-injector`（运行时注入器）·
#      `dsh-engram-relay`（记忆图谱）—— 它们【不属于 OMC】，而用户仍只敲一条命令。
#
# 用法：
#   .\install.ps1
#   $env:PROFILE='myco'; .\install.ps1
#   $env:DRY_RUN='1'; .\install.ps1
#   $env:SKIP_DEPS='1'; .\install.ps1     # 只装本仓
#
# ⚠️ 执行策略：powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Continue'

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgsDir = Join-Path $Root 'packages'
$Profile = if ($env:PROFILE) { $env:PROFILE } else { 'web' }
# ★ DSH_HOME 优先 —— 不要用 $HOME/$env:USERPROFILE 直接推（本机实测可能指向不同账号）
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
# ★ 必须回写环境变量 —— 否则子进程用 os.homedir() 重新推
$env:DSH_HOME = $DshHome
$DryRun  = ($env:DRY_RUN -eq '1')
$SkipDeps = ($env:SKIP_DEPS -eq '1')

function Info($m) { Write-Host "=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "X $m" -ForegroundColor Red }

$pass = @(); $fail = @(); $skip = @(); $depMissing = @()

Info '[0/5] 环境预检'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Err '未找到 node'; exit 1 }
Ok "node: $(node --version)"
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) { Warn 'dsh 不在 PATH —— 回退 npx @deepseek-ai/dsh'; $DshCmd = @('npx','@deepseek-ai/dsh') }
else { Ok "dsh: $($dsh.Source)"; $DshCmd = @('dsh') }
Write-Host "仓库目录 : $Root"
Write-Host "DSH_HOME  : $DshHome"
Write-Host "profile   : $Profile"
if ($DryRun) { Warn 'DRY_RUN=1 —— 只打印，不执行' }

Info '[1/5] 逐包装配（本仓 packages/ 下的公司包）'
# 只装"有 package.json 的目录" —— 本仓只有 2 个（teamkit · org-panel）
foreach ($d in (Get-ChildItem $PkgsDir -Directory | Sort-Object Name)) {
  $name = $d.Name
  if (-not (Test-Path (Join-Path $d.FullName 'package.json'))) { Warn "$name：无 package.json（跳过装配）"; $skip += $name; continue }
  if ($DryRun) { Ok "$name：将执行 $($DshCmd -join ' ') plugin --profile $Profile add $($d.FullName)"; $pass += $name; continue }
  & $DshCmd[0] $DshCmd[1..($DshCmd.Count-1)] plugin --profile $Profile add $d.FullName *> $null
  if ($LASTEXITCODE -eq 0) { Ok $name; $pass += $name } else { Err "$name（可单独重试）"; $fail += $name }
}

Info '[2/5] 依赖（**不在本仓** —— 从它们各自的【Release 资产】装）'
# 依据（委托方 2026-09-18）：「我没让你把仓库合并，我让你做的是把【公司相关的】合并 omc」
#
# 为什么装 tgz 而不是 `add <git URL>`（2026-09-19 · 实测三条路）：
#   git URL  => FAIL ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED（两个包都有 prepare；加 allowlist 后又撞 npm 404）
#   远程 tgz URL => FAIL（pnpm 走网络 TLS 错）
#   本地 tgz  => exit=0  <= 所以先下载到临时目录、再 add 本地文件
$depAssets = @(
  @{ Name = 'dsh-super-injector'; Url = 'https://github.com/yjh051108/dsh-super-injector/releases/download/v0.3.4/dsh-external-dsh-super-injector-0.3.4.tgz'; Why = '运行时注入（dev_* 工具全家桶）—— 缺它则【注入】能力不可用' },
  @{ Name = 'dsh-engram-relay';   Url = 'https://github.com/yjh051108/dsh-engram-relay/releases/download/v0.4.1/dsh-external-dsh-engram-relay-0.4.1.tgz';   Why = '记忆图谱（engram）—— 缺它则【跨会话记忆】不可用' }
)
$depTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-omc-deps-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $depTmp -Force | Out-Null
if ($SkipDeps) { Warn 'SKIP_DEPS=1 —— 跳过两个依赖'; $skip += 'deps' }
else {
  foreach ($dep in $depAssets) {
    $tarball = Join-Path $depTmp ($dep.Name + '.tgz')
    if ($DryRun) { Ok "$($dep.Name)（依赖）：将下载 $($dep.Url) => $($DshCmd -join ' ') plugin --profile $Profile add <本地 tgz>"; $pass += "$($dep.Name)(dep)"; continue }
    # 下载（PS 5.1 要显式 TLS 1.2；并禁用证书吊销检查 —— 受限网络里 schannel 会报 CRYPT_E_NO_REVOCATION_CHECK）
    $oldCb = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $dep.Url -OutFile $tarball -UseBasicParsing -TimeoutSec 300
    } catch { Warn "! 下载失败 $($dep.Name)：$($_.Exception.Message)"; }
    finally { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $oldCb }
    if (-not (Test-Path $tarball) -or (Get-Item $tarball).Length -eq 0) {
      Warn "! 下载不到 $($dep.Name) 的发布件（$($dep.Url)）=> 本次未装它"
      Warn "   后果：$($dep.Why)"
      $depMissing += $dep.Name; continue
    }
    & $DshCmd[0] $DshCmd[1..($DshCmd.Count-1)] plugin --profile $Profile add $tarball *> $null
    if ($LASTEXITCODE -eq 0) { Ok "$($dep.Name)（依赖 · 由 Release 资产装）—— $($dep.Why)"; $pass += "$($dep.Name)(dep)" }
    else {
      Warn "! 装不上 $($dep.Name) 的发布件 => 本次未装它"
      Warn "   后果：$($dep.Why)"
      Warn "   单独装：$($DshCmd -join ' ') plugin --profile $Profile add $tarball"
      $depMissing += $dep.Name
    }
  }
  Remove-Item $depTmp -Recurse -Force -ErrorAction SilentlyContinue
}

Info '[3/5] 自检：**装到 profile 里的**注入器含 R1–R7 兜底吗'
# 为什么核 profile 里那份：仓里那份已移出本仓（它不属于 OMC）=> 核宿主将来真加载的那份
$injectorLib = Join-Path $DshHome "profiles\$Profile\node_modules\@dsh-external\dsh-super-injector\lib\index.js"
if (-not (Test-Path $injectorLib)) {
  Warn "未找到 $injectorLib => 跳过兜底自检（未装注入器 / 别的 profile / junction 落在别处）"
  Warn '   可手动核：<该路径> 里应有 unhandledRejection / usesSlots / handoff( '
  $skip += 'injector-fallback-check'
} else {
  # 必须显式按 UTF-8 读 —— lib/index.js 无 BOM（编译产物），PS 5.1 默认按 ANSI/GBK 读会破坏中文特征串
  $injText = Get-Content $injectorLib -Raw -Encoding UTF8
  function CheckGrep($needle, $min, $why) {
    $n = ([regex]::Matches($injText, [regex]::Escape($needle))).Count
    if ($n -ge $min) { Ok "注入器含 $needle x$n（$why）" }
    else { Err "注入器缺 $needle（找到 $n · 期望 >=$min）—— $why"; $script:fail += "injector:$needle" }
  }
  CheckGrep 'unhandledRejection' 1 'R1 未处理 rejection 常驻兜底（#1 痛点的崩溃兜底）'
  CheckGrep 'usesSlots' 1 'R6 不是每个 client 入口都要注册 slot（17 次启动未恢复）'
  CheckGrep 'handoff(' 3 'R7 工具边界有界交接（二次吊死案底）'
  CheckGrep '修法：在该工具里' 1 'R2 逃逸回执里的修法建议'
}

Info '[4/5] 公司层资产（teamkit 安装器）'
$tk = Join-Path $PkgsDir 'teamkit\tools\install-teamkit.mjs'
if (Test-Path $tk) {
  if ($DryRun) { Ok "将执行 node $tk" }
  else {
    node $tk
    if ($LASTEXITCODE -eq 0) { Ok '公司层资产已落地（$DSH_HOME/teamkit）' }
    else { Err "安装器失败：$tk"; $fail += 'teamkit-assets' }
  }
} else { Warn "未找到 $tk（跳过）"; $skip += 'teamkit-assets' }

Info '[5/5] 汇总'
Write-Host "-- 合计：装了 $($pass.Count) 个 · 跳过 $($skip.Count) 个 · 失败 $($fail.Count) 个 --"
foreach ($x in $pass) { Write-Host "  OK $x" }
foreach ($x in $skip) { Write-Host "  -- $x（跳过）" }
foreach ($x in $fail) { Write-Host "  XX $x（失败）" }
foreach ($x in $depMissing) { Write-Host "  ! $x（依赖未装 => 见上文它缺哪个能力）" }
Write-Host ''
Write-Host '=> 下一步：'
Write-Host '  · ★ 新开一个会话（当前窗口的预设列表不会变）=> 预设选 `omc`'
Write-Host '  · ★★ 刷新页面（装了 org-panel 的话 -- 它是 dsh.client => 不刷新看不到侧边栏「办公室」）'
Write-Host '  · 想看"公司还差什么" => 在新会话里说：teamkit init'
Write-Host ''
if ($fail.Count -gt 0) { Err '有包装配失败 —— 见上文逐包输出（本脚本可重复运行，幂等）'; exit 1 }
Warn '若某个插件装了但"没反应"——先看它是否声明了 `dsh.bundle`：'
Write-Host '   本仓两个（teamkit/org-panel）都有声明 => 装上即生效（org-panel 另需刷新页面）。'
Write-Host ''
Write-Host '附：需要构建时（只有 lib/ 缺失时）'
Write-Host '  各包 scripts/build.sh 需要 DSH 源码检出：$env:DSH_CHECKOUT=<checkout>; bash packages/<包>/scripts/build.sh'
Write-Host '  若你只有 npm 装的 dsh（无源码检出）=> 请改用 Release 包取件（见 README）。'
