#!/usr/bin/env bash
# dsh-omc —— 一键安装（Linux/macOS；镜像 install.ps1）
#
# 形态照委托方的 `dsh-routing-suite/install.sh`：分步 + 环境预检 + 着色输出。
#
# ## 它做什么
# ```
# ① 环境预检（node / dsh 在不在）
# ② 逐个装配 packages/ 下的**公司包**（本仓只有 2 个：teamkit · org-panel）
# ③ ★ 核"运行时注入器"兜底（R1–R7）—— **该包从它自己的仓装** ⇒ 自检核【装到 profile 里的那份】
# ④ 跑 teamkit 的安装器（把公司层资产落到 $DSH_HOME/teamkit）
# ⑤ 自检：报"装了几个 / 哪个失败 / 哪个跳过"
# ```
#
# ## 本仓是什么（★ 一句）
# ```
# ★ **本仓 = 【公司套件】**（OMC）：
#   · `packages/teamkit`   —— 公司层本体（角色档 / 技能 / 组织层 / 指南）
#   · `packages/org-panel` —— 看得见的侧边栏「办公室」
#   · `docs/company/`      —— 怎么开公司（方法论 · 先读 `INDEX.md`）
# ★★ **两个依赖（不在本仓 · 从各自仓装）**：
#   · `dsh-super-injector`（运行时注入器 —— **服务所有插件**，不只公司）
#   · `dsh-engram-relay`（记忆图谱 —— **通用记忆层**）
#   ⇒ ★ 它们【不属于 OMC】（**委托方 2026-09-18 定向：把"公司相关的"合并 omc**）
#     ⇒ 而**用户仍只敲一条命令**（本脚本内部把它们一并装）✅
# ```
# ## 它**不**做什么
# ```
# · ⛔ 不改任何包的**内容**（只 `dsh plugin add` 它们的**目录 / URL**）
# · ⛔ **不构建** —— 本仓 2 个包的 `lib/` **随仓发布**（clone 即用）
#   ⇒ ⚠️ 若 `lib/` 缺失 ⇒ 你拿到的是**源码形态** ⇒ 见文末「附：需要构建时」
# · ⛔ 不碰 DSH 本体（只调官方的 `dsh plugin add`）
# ```
#
# 用法：
#   ./install.sh                    # 装到默认 profile: web
#   PROFILE=myco ./install.sh       # 装到别的 profile
#   DRY_RUN=1 ./install.sh          # 只打印将要做什么，不执行
#   SKIP_DEPS=1 ./install.sh        # 只装本仓（不装两个依赖）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKGS_DIR="$ROOT/packages"
PROFILE="${PROFILE:-web}"
# DSH_HOME 优先：部署环境 homedir 可能与 DSH_HOME 不一致，不能只靠 $HOME
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
# ★★ **必须 export** —— 否则子进程（`node install-teamkit.mjs`）会用**它自己的**
# `os.homedir()` 重新推 DSH_HOME ⇒ 而本机实测 `os.homedir()` 与真实家目录**可能不是同一个**
# （`B124`：Git Bash 的 `$HOME` 与 Node 的 `os.homedir()` 曾返回**不同账号**）
# ⇒ 那会导致"资产装到 A 账号、而插件在 B 账号下找它" ⇒ **装完像没装**。
export DSH_HOME

# 输出着色（非终端自动禁用）
if [ -t 1 ]; then
  C_CYAN=$'\e[36m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_RESET=$'\e[0m'
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi
info() { printf '%s=== %s ===%s\n' "$C_CYAN" "$1" "$C_RESET"; }
ok()   { printf '%s✓ %s%s\n'  "$C_GREEN" "$1" "$C_RESET"; }
warn() { printf '%s! %s%s\n'  "$C_YELLOW" "$1" "$C_RESET"; }
err()  { printf '%s✗ %s%s\n'  "$C_RED" "$1" "$C_RESET"; }

# ★ 每个包一行状态（`B51` 那条教训：**要能报"装了几个 / 哪个失败"**）
PASS_LIST=(); FAIL_LIST=(); SKIP_LIST=(); DEP_MISSING=()

info '[0/5] 环境预检'
if ! command -v node >/dev/null 2>&1; then
  err '未找到 node —— 本套装的安装器（teamkit）需要 Node.js'
  exit 1
fi
ok "node: $(node --version)"
if ! command -v dsh >/dev/null 2>&1; then
  warn 'dsh 不在 PATH —— 装配将回退到 `npx @deepseek-ai/dsh`'
  DSH_CMD=(npx '@deepseek-ai/dsh')
else
  ok "dsh: $(command -v dsh)"
  DSH_CMD=(dsh)
fi
echo "仓库目录 : $ROOT"
echo "DSH_HOME  : $DSH_HOME"
echo "profile   : $PROFILE"
[ "${DRY_RUN:-0}" = "1" ] && warn 'DRY_RUN=1 —— 只打印，不执行'

info '[1/5] 逐包装配（本仓 packages/ 下的公司包）'
# ⚠️ **只装"有 package.json 的目录"** —— 本仓只有 2 个（`teamkit` · `org-panel`）
for d in "$PKGS_DIR"/*/; do
  name="$(basename "$d")"
  if [ ! -f "$d/package.json" ]; then
    warn "$name：无 package.json（跳过装配）"
    SKIP_LIST+=("$name")
    continue
  fi
  if [ "${DRY_RUN:-0}" = "1" ]; then
    ok "$name：将执行 ${DSH_CMD[*]} plugin --profile $PROFILE add $d"
    PASS_LIST+=("$name")
    continue
  fi
  # 幂等：`dsh plugin add` 自己会跳过已列出的（它按 dependencies/bundles 判重）
  if "${DSH_CMD[@]}" plugin --profile "$PROFILE" add "$d" >/dev/null 2>&1; then
    ok "$name"
    PASS_LIST+=("$name")
  else
    err "$name（见上文输出；可单独重试：${DSH_CMD[*]} plugin --profile $PROFILE add $d）"
    FAIL_LIST+=("$name")
  fi
done

info '[2/5] 依赖（**不在本仓** —— 从它们各自的仓装）'
# ★★ 为什么它们不在本仓（委托方 2026-09-18 逐字）：
#   「**我没让你把仓库合并，我让你做的是把【公司相关的】合并 omc**」
#   ⇒ `super-injector` = **运行时注入基础设施**（服务所有插件）· `engram-relay` = **通用记忆层**
#   ⇒ ★ 它们**不属于 OMC** ⇒ 各有自己的仓 ⇒ 而**用户仍只敲一条命令**（本脚本内部装）✅
# ⚠️ 拿不到时要【明说】（不是静默跳过）—— "没装"与"装了但坏了"必须能分辨（`B51`）
DEP_REPOS=(
  "dsh-super-injector|https://github.com/yjh051108/dsh-super-injector|运行时注入（dev_* 工具全家桶）—— 缺它则【注入】能力不可用"
  "dsh-engram-relay|https://github.com/yjh051108/dsh-engram-relay|记忆图谱（engram）—— 缺它则【跨会话记忆】不可用"
)
if [ "${SKIP_DEPS:-0}" = "1" ]; then
  warn 'SKIP_DEPS=1 —— 跳过两个依赖'
  SKIP_LIST+=("deps")
else
  for spec in "${DEP_REPOS[@]}"; do
    IFS='|' read -r dname durl dwhy <<< "$spec"
    if [ "${DRY_RUN:-0}" = "1" ]; then
      ok "$dname（依赖）：将执行 ${DSH_CMD[*]} plugin --profile $PROFILE add $durl"
      PASS_LIST+=("$dname(dep)"); continue
    fi
    if "${DSH_CMD[@]}" plugin --profile "$PROFILE" add "$durl" >/dev/null 2>&1; then
      ok "$dname（依赖）—— $dwhy"
      PASS_LIST+=("$dname(dep)")
    else
      warn "⚠️ 无法获取 $dname（网络/仓不可达）⇒ **本次未装它**"
      warn "   后果：$dwhy"
      warn "   单独装：${DSH_CMD[*]} plugin --profile $PROFILE add $durl"
      DEP_MISSING+=("$dname")
    fi
  done
fi

info '[3/5] 自检：**装到 profile 里的**注入器含 R1–R7 兜底吗'
# ★★★ **为什么核"profile 里那份"而不是"仓里那份"**（2026-09-18 改）：
# ```
# 原版核 `$PKGS_DIR/super-injector/lib/index.js` —— 而那个目录**已从本仓移出**（它不属于 OMC）
#   ⇒ ★ 于是自检**永久 SKIP** ⇒ **陌生人装完没有任何东西证明"他拿到的注入器含崩溃兜底"** ❌
#   ⇒ ⇒ 正解：核【真的落到 profile 里的那份】—— 那才是宿主将来加载的东西 ✅
# ★ 而它就是委托方最痛的 #1（宿主反反复复重启）的**机械判据**
# ```
INJECTOR_LIB="$DSH_HOME/profiles/$PROFILE/node_modules/@dsh-external/dsh-super-injector/lib/index.js"
if [ ! -f "$INJECTOR_LIB" ]; then
  warn "未找到 $INJECTOR_LIB ⇒ 跳过兜底自检（可能：未装注入器 / 装到别的 profile / 用 junction 落在别处）"
  warn "   ⇒ ★ 可手动核：<该路径> 里应有 unhandledRejection / usesSlots / handoff( "
  SKIP_LIST+=("injector-fallback-check")
else
  check_grep() {  # $1=特征串 · $2=期望最少出现次数 · $3=这条代表什么
    n=$(grep -c -- "$1" "$INJECTOR_LIB" 2>/dev/null || true)
    [ -z "$n" ] && n=0
    if [ "$n" -ge "$2" ]; then ok "注入器含 $1 ×$n（$3）"
    else err "注入器**缺** $1（找到 $n · 期望 ≥$2）—— $3"; FAIL_LIST+=("injector:$1"); fi
  }
  check_grep 'unhandledRejection' 1 'R1 未处理 rejection 常驻兜底（#1 痛点的崩溃兜底）'
  check_grep 'usesSlots' 1 'R6 不是每个 client 入口都要注册 slot（17 次启动未恢复）'
  check_grep 'handoff(' 3 'R7 工具边界有界交接（二次吊死案底）'
  check_grep '修法：在该工具里' 1 'R2 逃逸回执里的修法建议'
fi

info '[4/5] 公司层资产（teamkit 安装器）'
TK_INSTALLER="$PKGS_DIR/teamkit/tools/install-teamkit.mjs"
if [ -f "$TK_INSTALLER" ]; then
  if [ "${DRY_RUN:-0}" = "1" ]; then
    ok "将执行 node $TK_INSTALLER"
  elif node "$TK_INSTALLER"; then
    ok '公司层资产已落地（角色档 / 技能 / 组织层 / 指南 → $DSH_HOME/teamkit）'
  else
    err "安装器失败：$TK_INSTALLER"
    FAIL_LIST+=("teamkit-assets")
  fi
else
  warn "未找到 $TK_INSTALLER（跳过；若你只要插件本体，可忽略）"
  SKIP_LIST+=("teamkit-assets")
fi

info '[5/5] 汇总'
echo "── 合计：装了 ${#PASS_LIST[@]} 个 · 跳过 ${#SKIP_LIST[@]} 个 · 失败 ${#FAIL_LIST[@]} 个 ──"
for x in "${PASS_LIST[@]:-}"; do [ -n "$x" ] && echo "  ✅ $x"; done
for x in "${SKIP_LIST[@]:-}"; do [ -n "$x" ] && echo "  ⏭  $x（跳过）"; done
for x in "${FAIL_LIST[@]:-}"; do [ -n "$x" ] && echo "  ❌ $x（失败）"; done
for x in "${DEP_MISSING[@]:-}"; do [ -n "$x" ] && echo "  ⚠️  $x（依赖未装 ⇒ 见上文它缺哪个能力）"; done
echo
echo '⇒ 下一步：'
echo '  · ★ **新开一个会话**（当前窗口的预设列表不会变）⇒ 预设选 `omc`'
echo '  · ★★ **刷新页面**（装了 `org-panel` 的话 —— 它是 dsh.client ⇒ 不刷新看不到侧边栏「办公室」）'
echo '  · 想看"公司还差什么"⇒ 在新会话里说：teamkit init'
echo
if [ "${#FAIL_LIST[@]}" -gt 0 ]; then
  err '有包装配失败 —— 见上文逐包输出（本脚本可重复运行，幂等）'
  exit 1
fi
# ⚠️ 本仓只有 2 个公司包（`teamkit` · `org-panel`）—— 它们**都声明了 `dsh.bundle`** ⇒ 官方装配路径有效。
echo '⚠️ 若某个插件装了但"没反应"——先看它是否声明了 `dsh.bundle`：'
echo '   本仓两个（`teamkit`/`org-panel`）**都有**声明 ⇒ 装上即生效（`org-panel` 另需刷新页面）。'
echo
echo '附：需要构建时（只有你拿到的是源码形态、`lib/` 缺失时）'
echo '  各包 `scripts/build.sh` 需要 DSH **源码**检出：DSH_CHECKOUT=<checkout> bash packages/<包>/scripts/build.sh'
echo '  若你只有 npm 装的 dsh（无源码检出）⇒ 请改用【Release 包】取件（见 README 的"取件"节）。'
