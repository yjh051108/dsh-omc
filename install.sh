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

info '[2/5] 依赖（我们[不 vendoring] 的那两个 ⇒ 从既有仓装）'
# ★★ 为什么不并进本仓（2026-09-18 CEO 裁定"甲"）：
# ```
# · `dsh-super-injector` = **运行时注入基础设施**（服务所有插件，不只是本套装）
#   ⇒ 而它的"单仓"**已经是** `dsh-routing-suite`（其 README 逐字：三个组件随本仓库统一演进；
#     上游独立仓库保留用于独立发布，后续可转镜像/归档）⇒ **并进来会造第四份**
# · `dsh-engram-relay`   = **记忆层**（通用能力）⇒ 同上
# ⇒ ★ **甲案**：**本仓是"公司套件"，那两个是"依赖"** —— 像 `npm i express`：
#    **源码不在你的仓里，但你只敲一条命令** ✅
# ```
# ⚠️ 拿不到时要【明说】（不是静默跳过）—— "没装"与"装了但坏了"必须能分辨（`B51`）
DEP_REPOS=(
  "dsh-super-injector|https://github.com/yjh051108/dsh-super-injector|运行时注入（dev_* 工具全家桶）—— 缺它则【注入】能力不可用"
  "dsh-engram-relay|https://github.com/yjh051108/dsh-engram-relay|记忆图谱（engram）—— 缺它则【跨会话记忆】不可用"
)
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
    # ★★ **失败要明说"缺什么能力"**，而不是笼统"失败"
    warn "⚠️ 无法获取 $dname（网络/仓不可达）⇒ **本次未装它**"
    warn "   后果：$dwhy"
    warn "   单独装：${DSH_CMD[*]} plugin --profile $PROFILE add $durl"
    DEP_MISSING+=("$dname")
  fi
done

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
