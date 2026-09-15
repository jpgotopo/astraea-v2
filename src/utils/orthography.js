/**
 * Best-effort IPA -> approximate spelling conversion.
 *
 * This is NOT a linguistically rigorous IPA-to-orthography converter — that
 * would require full phonological/morphological knowledge of whichever
 * (often undocumented) language is actually being transcribed, which is
 * exactly what this app can't assume. What this does instead is re-spell
 * the IPA symbols using the everyday letter conventions of a *reference*
 * alphabet the researcher picks for the project (Spanish, Indonesian or
 * English), so community members or students who don't read IPA get a
 * readable approximation to work from. Always a starting point to be
 * checked by ear, never a substitute for the IPA transcription itself.
 */

export const REFERENCE_ALPHABETS = ['none', 'es', 'id', 'en'];

// Multi-symbol sequences (affricates, diphthongs) must come before any of
// their single-symbol components, since matching is longest-first.
const IPA_TOKENS = [
    'tʃ', 'dʒ', 'eɪ', 'aɪ', 'ɔɪ', 'aʊ', 'oʊ', 'ɪə', 'ʊə', 'eə', 'ts', 'dz',
    'p', 'b', 't', 'd', 'k', 'ɡ', 'g', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ', 'h', 'x',
    'm', 'n', 'ŋ', 'ɲ', 'l', 'ɾ', 'r', 'ɹ', 'w', 'j', 'ʔ',
    'i', 'ɪ', 'e', 'ɛ', 'æ', 'a', 'ɑ', 'ʌ', 'ə', 'ɚ', 'ɝ', 'u', 'ʊ', 'o', 'ɔ', 'y', 'ø', 'œ',
];

const TABLES = {
    // Spanish-conventions respelling.
    es: {
        tʃ: 'ch', dʒ: 'y', eɪ: 'ei', aɪ: 'ai', ɔɪ: 'oi', aʊ: 'au', oʊ: 'ou', ɪə: 'ia', ʊə: 'ua', eə: 'ea', ts: 'ts', dz: 'dz',
        p: 'p', b: 'b', t: 't', d: 'd', k: 'k', ɡ: 'g', g: 'g', f: 'f', v: 'b', θ: 'z', ð: 'd', s: 's', z: 's', ʃ: 'sh', ʒ: 'y', h: 'j', x: 'j',
        m: 'm', n: 'n', ŋ: 'n', ɲ: 'ñ', l: 'l', ɾ: 'r', r: 'rr', ɹ: 'r', w: 'u', j: 'y', ʔ: '',
        i: 'i', ɪ: 'i', e: 'e', ɛ: 'e', æ: 'a', a: 'a', ɑ: 'a', ʌ: 'a', ə: 'e', ɚ: 'er', ɝ: 'er', u: 'u', ʊ: 'u', o: 'o', ɔ: 'o', y: 'i', ø: 'e', œ: 'e',
    },
    // Bahasa Indonesia-conventions respelling (a closer fit — Indonesian
    // orthography is already close to phonetic).
    id: {
        tʃ: 'c', dʒ: 'j', eɪ: 'e', aɪ: 'ai', ɔɪ: 'oi', aʊ: 'au', oʊ: 'o', ɪə: 'ia', ʊə: 'ua', eə: 'e', ts: 'ts', dz: 'dz',
        p: 'p', b: 'b', t: 't', d: 'd', k: 'k', ɡ: 'g', g: 'g', f: 'f', v: 'v', θ: 't', ð: 'd', s: 's', z: 'z', ʃ: 'sy', ʒ: 'j', h: 'h', x: 'kh',
        m: 'm', n: 'n', ŋ: 'ng', ɲ: 'ny', l: 'l', ɾ: 'r', r: 'r', ɹ: 'r', w: 'w', j: 'y', ʔ: 'k',
        i: 'i', ɪ: 'i', e: 'e', ɛ: 'e', æ: 'e', a: 'a', ɑ: 'a', ʌ: 'a', ə: 'e', ɚ: 'er', ɝ: 'er', u: 'u', ʊ: 'u', o: 'o', ɔ: 'o', y: 'i', ø: 'e', œ: 'e',
    },
    // English-conventions respelling. English spelling is notoriously
    // non-phonetic, so this leans on common phonics patterns rather than
    // real dictionary spellings — the least reliable of the three.
    en: {
        tʃ: 'ch', dʒ: 'j', eɪ: 'ay', aɪ: 'y', ɔɪ: 'oy', aʊ: 'ow', oʊ: 'o', ɪə: 'ear', ʊə: 'oor', eə: 'air', ts: 'ts', dz: 'dz',
        p: 'p', b: 'b', t: 't', d: 'd', k: 'k', ɡ: 'g', g: 'g', f: 'f', v: 'v', θ: 'th', ð: 'th', s: 's', z: 'z', ʃ: 'sh', ʒ: 'zh', h: 'h', x: 'kh',
        m: 'm', n: 'n', ŋ: 'ng', ɲ: 'ny', l: 'l', ɾ: 'r', r: 'r', ɹ: 'r', w: 'w', j: 'y', ʔ: '',
        i: 'ee', ɪ: 'i', e: 'e', ɛ: 'e', æ: 'a', a: 'ah', ɑ: 'ah', ʌ: 'uh', ə: 'uh', ɚ: 'er', ɝ: 'er', u: 'oo', ʊ: 'oo', o: 'oh', ɔ: 'aw', y: 'ee', ø: 'uh', œ: 'uh',
    },
};

// Marks that carry no letter of their own in plain spelling: primary/
// secondary stress, vowel length, and tie bars joining affricate symbols.
// Written as an alternation (not a [...] character class) since some of
// these are combining marks — a class would trigger ESLint's
// no-misleading-character-class rule and, more importantly, wouldn't
// reliably match a combining mark regardless of what precedes it.
const STRIP_RE = /ˈ|ˌ|ː|̯|͡|‿/gu;

const MATCH_RE = new RegExp(
    [...IPA_TOKENS]
        .sort((a, b) => b.length - a.length)
        .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
    'g'
);

/**
 * Converts an IPA string to an approximate spelling in the given reference
 * alphabet ('es' | 'id' | 'en'). Returns '' for alphabet 'none'/unset, or
 * when there's nothing to convert. Anything not recognized as an IPA token
 * (punctuation, digits, already-plain letters) passes through unchanged.
 */
export function ipaToOrthography(ipaText, alphabet) {
    if (!ipaText || !alphabet || alphabet === 'none') return '';
    const table = TABLES[alphabet];
    if (!table) return '';

    const stripped = ipaText.replace(STRIP_RE, '');
    const respelled = stripped.replace(MATCH_RE, (match) => (match in table ? table[match] : match));
    return respelled.charAt(0).toUpperCase() + respelled.slice(1);
}
