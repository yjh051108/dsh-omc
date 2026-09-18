#!/usr/bin/env bash
# dsh-omc —— 一键安装（Linux/macOS；镜像 install.ps1）
#
# 形态照委托方的 `dsh-routing-suite/install.sh`：分步 + 环境预检 + 着色输出。
#
# ## 它做什么
# ```
# ① 环境预检（node / dsh 在不在）
# ② 逐个装配 packages/ 下的**插件包**（7 个）
# ③ 跑 teamkit 的安装器（把公司层资产落到 $DSH_HOME/teamkit）
# ④ 自检：报"装了几个 / 哪个失败"
# ```
# ## 它**不**做什么
# ```
# · ⛔ 不改任何包的**内容**（只 `dsh plugin add` 它们的**目录**）
# · ⛔ **不构建** —— 7 个包的 `lib/` **随仓发布**（clone 即用）
#   ⇒ ⚠️ 若你的 `lib/` 缺失 ⇒ 说明你拿到的是**源码形态** ⇒ 见文末「附：需要构建时」
# · ⛔ 不碰 DSH 本体（只调官方的 `dsh plugin add`）
# ```
#
# 用法：
#   ./install.sh                    # 装到默认 profile: web
#   PROFILE=myco ./install.sh       # 装到别的 profile
#   DRY_RUN=1 ./install.sh          # 只打印将要做什么，不执行
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
PASS_LIST=(); FAIL_LIST=(); SKIP_LIST=()

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

info '[1/5] 逐包装配（packages/ 下的插件包）'
# ⚠️ **只装"有 package.json 的目录"** —— `company/` 是文档（无 package.json），不是包
for d in "$PKGS_DIR"/*/; do
  name="$(basename "$d")"
  if [ ! -f "$d/package.json" ]; then
    warn "$name：无 package.json（文档目录，跳过装配）"
    SKIP_LIST+=("$name")
    continue
  fi
  if [ "${DRY_RUN:-0}" = "1" ]; then
    ok "$name：将执行 ${DSH_CMD[*]} plugin --profile $PROFILE add $d"
    PASS_LIST+=("$name")
    continue
  fi
  # 幂等：同名的已列出 ⇒ `dsh plugin add` 自己会跳过（它按 dependencies/bundles 判重）
  if "${DSH_CMD[@]}" plugin --profile "$PROFILE" add "$d" >/dev/null 2>&1; then
    ok "$name"
    PASS_LIST+=("$name")
  else
    err "$name（见上文输出；可单独重试：${DSH_CMD[*]} plugin --profile $PROFILE add $d）"
    FAIL_LIST+=("$name")
  fi
done

info '[2/5] 自检：注入器兜底（**R1–R7**）是否在我们要装的那份里'
#
# ★★★ **为什么删掉了原来的"从既有仓装依赖"那一步**（2026-09-18 CEO 裁定 · `B159`/`B160`）：
# ```
# 【原先的错】`packages/` 里已有 9 个包（**含 `super-injector` 与 `engram-relay`**），
#   而旧版 `[2/5]` 还从网上再装这两个 ⇒ **重复装 11 个** ⇒ 而更糟的是：
#   · ★ `packages/super-injector` = **我们回流了 R1–R7 的版本**（含崩溃兜底 + 有界交接）
#   · ★★ **而老仓 `dsh-super-injector` 是【另一个版本】**（**建于 08-13**，**没有 R1–R7**）
#   ⇒ ⇒ ★★★ 若从老仓拉 ⇒ **用户可能拿到【没有崩溃兜底】的注入器** ——
#     而那是委托方最痛的 `#1`（`DSH 反反复复重启`）❌
# ⇒ 正解：**只装本仓 `packages/`**（**它自足 · 离线可装 · 且是带兜底的那份**）✅
# ```
# ★ 而这一步把它变成**机械判据**（**不再靠"人记得核"** —— 那正是 `H29` 那个问题）
INJECTOR_LIB="$PKGS_DIR/super-injector/lib/index.js"
if [ ! -f "$INJECTOR_LIB" ]; then
  # 冻结产物形态时 lib/ 应当在（本套装发布为"带 lib 的形态"）
  warn "未找到 $INJECTOR_LIB ⇒ 跳过兜底自检（若你拿到的是源码形态，见文末"需要构建时"）"
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
  check_grep "handoff(" 3 'R7 工具边界有界交接（二次吊死案底）'
  check_grep '修法：在该工具里' 1 'R2 逃逸回执里的修法建议'
fi

info '[3/5] 公司层资产（teamkit 安装器）'
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
  warn "未找到 $TK_INSTALLER（跳过；若你只想要插件本体，可忽略）"
  SKIP_LIST+=("teamkit-assets")
fi

info '[4/5] 自检（--check）'
if [ -f "$TK_INSTALLER" ] && [ "${DRY_RUN:-0}" != "1" ]; then
  node "$TK_INSTALLER" --check || warn '--check 报不一致（源新、落点旧 ⇒ 再跑一次本脚本即可）'
fi

info '[5/5] 汇总'
TOTAL=$(( ${#PASS_LIST[@]} + ${#FAIL_LIST[@]} ))
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
warn '若某个插件装了但"没反应"——先看它是否声明了 `dsh.bundle`：'
echo '   本套装里 `teamkit`/`org-panel`/`tool-output-guard`/`web-tools` **有**声明；'
echo '   而 `issue-watch`/`model-fit`/`symbiote` **没有** ⇒ 需要走**注入**路径（见 README）。'
echo
echo '附：需要构建时（只有你拿到的是源码形态、`lib/` 缺失时）'
echo '  各包 `scripts/build.sh` 需要 DSH **源码**检出：DSH_CHECKOUT=<checkout> bash packages/<包>/scripts/build.sh'
echo '  若你只有 npm 装的 dsh（无源码检出）⇒ 请改用【Release 包】取件（见 README 的"取件"节）。'
