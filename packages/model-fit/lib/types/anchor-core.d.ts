/**
 * anchor-core — M2 锚点的**纯逻辑**（零宿主依赖）。
 *
 * 单独成文件的理由：这条分支（seqs≠null）在真实压缩到来之前跑不到，
 * 而在插件里就地重写一份逻辑去验证等于没验。
 * 抽成零依赖的纯模块后，可以用**真实压缩事件里的 shadowedSeqs + 真实原话**
 * 直接测出厂代码本身。
 */
export interface HumanMsg {
    seq: number;
    text: string;
}
/** 剥掉路径与引号后的残句 */
export declare function residual(t: string): string;
/** 值不值得当锚点 */
export declare function worthAnchoring(t: string, minChars: number): boolean;
/**
 * 从「被埋掉的开发者原话」里挑出要重贴的几条。
 * shadowedSeqs 为 null/空 → 全池（手动重贴）；否则只取 seq 落在被埋集合里的。
 * 取最近、没重贴过、且够格当锚点的 max 条。
 */
export declare function pickAnchors(humans: HumanMsg[], shadowedSeqs: number[] | null, restatedSeqs: Set<number>, max: number, minChars: number): HumanMsg[];
/** 被埋集合里有多少条够格候选（供台账记录） */
export declare function countCandidates(humans: HumanMsg[], shadowedSeqs: number[] | null): number;
