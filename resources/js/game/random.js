/**
 * Детерминирани случайни числа — споделени между играта (Game.js) и чистата
 * симулация на състезанието (race.js), която тича и на сървъра.
 */

/**
 * Детерминиран PRNG (mulberry32) — решетката на съперниците е една и съща
 * при всяко зареждане на пистата.
 *
 * @param {number} seed
 * @returns {() => number} [0, 1)
 */
export function mulberry32(seed) {
    let a = seed >>> 0;

    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * FNV-1a хеш на низ → seed за mulberry32.
 *
 * @param {string} value
 * @returns {number}
 */
export function hashString(value) {
    let hash = 2166136261;

    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}
