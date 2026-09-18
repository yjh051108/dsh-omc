/**
 * guard — 工具结果的消息契约归一（纯函数，零依赖，可单测）。
 *
 * 病（2026-09-10 案底·session-852e1d99）：
 * 插件 `output.render` 回**裸值**（典型：裸字符串）。宿主把 render 的返回值
 * 原样写进 durable 的 tool-result 块 `content`：
 *   `{ type: 'tool-result', toolCallId, content: "Browser ready…" }`
 * 这条消息不合法，后果是连环的：
 *   ① 会话重载被校验器拒收 —— "message must contain one tool-result block"；
 *   ② 活着的会话下一轮在文本投影里递归 `content.some` 抛
 *      `TypeError: content.some is not a function` → 整个 turn 死，
 *      且此后每一轮都在模型开工前死（脏消息永远在上下文里）。
 * 一个插件的渲染疏忽 → 整个会话报废。
 *
 * 契约（官方工具同形）：`render` 必须回 `ContentBlock[]`——每个块是
 * `{ type: string, ... }`；`tool-result` 块的 `content` 必须是块数组。
 *
 * 这里做的是**守卫**而非校验：把不合形的渲染结果在边界归一成合法块数组，
 * 让一个插件的疏忽不再能摧毁会话（同时留痕，推动源头修好）。
 * 合法输入零开销：逐字返回原引用，不复制、不改写。
 */
/** 一个内容块的宽松形态。 */
export interface ContentBlockLike {
    type: string;
    [key: string]: unknown;
}
/** 归一结果：合法块数组 + 人读的修复清单（空 = 本来就合法）。 */
export interface NormalizedContent {
    content: ContentBlockLike[];
    fixes: string[];
}
/**
 * 归一一份渲染结果（`output.render` 的返回值，或 policy 替换后的 content）。
 * @param content - 待检查的渲染结果。
 * @returns 合法块数组与人读修复清单；清单为空表示输入本就合法（引用逐字未变）。
 */
export declare function normalizeToolContent(content: unknown): NormalizedContent;
