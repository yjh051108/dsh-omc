/**
 * @dsh-external/dsh-tool-output-guard — 工具结果消息契约守卫。
 *
 * 接缝：`tools/post-execute`（waterfall，最外层）。任何工具调用的最终
 * content 在落成 durable 消息之前经过这里：不是 `ContentBlock[]` 就归一成
 * 合法块数组，并留痕（logger.warn + $DSH_HOME/tool-output-guard.log）。
 *
 * 为什么必须有这道守卫（2026-09-10 案底·session-852e1d99）：
 * 官方 `dsh-tools` 只校验 execute 的 **value**（`tool.output.schema`），
 * **不校验 render 的返回值**；而 render 的返回值会被原样写进 tool-result 块
 * 的 `content`。于是插件一次渲染疏忽（回裸字符串）＝ 会话档落下一条非法消息：
 * 重载被拒（"message must contain one tool-result block"）+ 活着的会话下一轮
 * 死在 `content.some is not a function`（脏消息永远在上下文里，每轮都死）。
 * 边界归一让"一个插件的疏忽"降级为"一条日志"，而不是"一个会话报废"。
 *
 * 这是**守卫**不是**校验**：故意不抛错——工具结果进模型上下文是主链路，
 * 宁可控损也不断链；源头问题靠日志推动修复。
 *
 * @module @dsh-external/dsh-tool-output-guard
 */
import type { Context } from 'cordis';
export declare const name = "@dsh-external/dsh-tool-output-guard";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
