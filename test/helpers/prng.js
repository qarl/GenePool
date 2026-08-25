'use strict';
// mulberry32 — a small, fast, public-domain seedable PRNG.
// Used to make Gene Pool runs reproducible (routes the sim's gpRandom through it).
// Public domain, so no third-party license notice needed (unlike JJ's staged aleaPRNG).

function hashString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = (typeof seed === 'number') ? (seed >>> 0) : hashString(String(seed));
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

module.exports = { mulberry32 };
