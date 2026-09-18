/**
 * anchor-core — M2 锚点的**纯逻辑**（零宿主依赖）。
 *
 * 单独成文件的理由：这条分支（seqs≠null）在真实压缩到来之前跑不到，
 * 而在插件里就地重写一份逻辑去验证等于没验。
 * 抽成零依赖的纯模块后，可以用**真实压缩事件里的 shadowedSeqs + 真实原话**
 * 直接测出厂代码本身。
 */
/** 一次性命令/寒暄不是持久约束，重贴就是噪声（回放实测：「修改」「发个0.3.19的release包」「渲染完了没？」） */
const ONE_OFF = /^(继续|好|好的|嗯|可以|行|修改|对|是的|收到|谢谢|做到哪了|渲染完了没|计划好怎么开发|开始吧|go|ok)[。！？!?~～.\s]*$/i;
/** 文件路径（压缩后还有意义的是句子，不是路径本身——文件还在盘上） */
const PATH_RE = /["']?[A-Za-z]:\\[^\s"']+|["']?\\\\[^\s"']+|\/[\w.-]+\/[\w./-]+/g;
/** 剥掉路径与引号后的残句 */
export function residual(t) {
    return t.replace(PATH_RE, ' ').replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}
/** 值不值得当锚点 */
export function worthAnchoring(t, minChars) {
    if (ONE_OFF.test(t.trim()))
        return false;
    return residual(t).length >= minChars;
}
/**
 * 从「被埋掉的开发者原话」里挑出要重贴的几条。
 * shadowedSeqs 为 null/空 → 全池（手动重贴）；否则只取 seq 落在被埋集合里的。
 * 取最近、没重贴过、且够格当锚点的 max 条。
 */
export function pickAnchors(humans, shadowedSeqs, restatedSeqs, max, minChars) {
    const pool = shadowedSeqs && shadowedSeqs.length
        ? (() => { const set = new Set(shadowedSeqs); return humans.filter((h) => set.has(h.seq)); })()
        : humans;
    return pool
        .filter((h) => !restatedSeqs.has(h.seq) && worthAnchoring(h.text, minChars))
        .slice(-max);
}
/** 被埋集合里有多少条够格候选（供台账记录） */
export function countCandidates(humans, shadowedSeqs) {
    if (!shadowedSeqs || shadowedSeqs.length === 0)
        return humans.length;
    const set = new Set(shadowedSeqs);
    return humans.filter((h) => set.has(h.seq)).length;
}
//# sourceMappingURL=anchor-core.js.map