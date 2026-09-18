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
/** 空文本块（消息的 content 不能为空数组）。 */
const EMPTY_TEXT = { type: 'text', text: '' };
/** 描述一个值的类型，用于日志。 */
function describe(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return `array(${value.length})`;
    if (typeof value === 'string')
        return `string(${value.length} chars)`;
    return typeof value;
}
/** 把任意值变成文本（保真优先：对象走 JSON，避免 "[object Object]"）。 */
function toText(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined || value === null)
        return '';
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
    }
    catch {
        return String(value);
    }
}
/** 是否已是合法块形态（有非空字符串 type 的对象）。 */
function isBlockLike(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof value.type === 'string' && value.type !== '';
}
/** 归一单个条目；`changed=false` 表示原样可用（引用不变）。 */
function normalizeBlock(entry, prefix, fixes) {
    if (!isBlockLike(entry)) {
        fixes.push(`${prefix}: 条目是 ${describe(entry)}，不是内容块，已包成文本块`);
        return { block: { type: 'text', text: toText(entry) }, changed: true };
    }
    if (entry.type === 'tool-result') {
        const inner = normalizeList(entry.content, `${prefix}.tool-result`, fixes);
        if (inner.changed)
            return { block: { ...entry, content: inner.list }, changed: true };
    }
    return { block: entry, changed: false };
}
/** 归一块数组（tool-result 的 content 走这里）；合法则原样返回同一引用。 */
function normalizeList(value, prefix, fixes) {
    if (!Array.isArray(value)) {
        fixes.push(`${prefix}: 内容是 ${describe(value)}，不是内容块数组，已包成文本块`);
        return { list: [{ type: 'text', text: toText(value) }], changed: true };
    }
    let changed = false;
    const list = value.map((entry, index) => {
        const result = normalizeBlock(entry, `${prefix}[${index}]`, fixes);
        if (result.changed)
            changed = true;
        return result.block;
    });
    if (!changed)
        return { list: value, changed: false };
    return { list: list.length > 0 ? list : [EMPTY_TEXT], changed: true };
}
/**
 * 归一一份渲染结果（`output.render` 的返回值，或 policy 替换后的 content）。
 * @param content - 待检查的渲染结果。
 * @returns 合法块数组与人读修复清单；清单为空表示输入本就合法（引用逐字未变）。
 */
export function normalizeToolContent(content) {
    const fixes = [];
    if (!Array.isArray(content)) {
        fixes.push(`render 回了 ${describe(content)}，不是内容块数组，已包成文本块`);
        return { content: [{ type: 'text', text: toText(content) }], fixes };
    }
    const { list, changed } = normalizeList(content, 'content', fixes);
    if (!changed && list.length === 0) {
        fixes.push('content: 是空数组，已补一个空文本块（消息的 content 不能为空）');
        return { content: [EMPTY_TEXT], fixes };
    }
    return { content: list, fixes };
}
//# sourceMappingURL=guard.js.map