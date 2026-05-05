/**
 * ZUKAGO — services/i18nService.js (V14.3)
 *
 * Service de traduction côté serveur (style Booking/Airbnb)
 *
 * 🎯 Architecture multi-fallback PRO :
 *    1. users.preferred_lang   (langue choisie dans l'app)
 *    2. push_tokens.locale     (langue device au register)
 *    3. 'fr'                   (fallback ZUKAGO)
 *
 * 🚀 Performance :
 *    - Cache mémoire 5 min pour les traductions
 *    - Évite de query 'translations' à chaque push
 *
 * 📦 API :
 *    - getUserLang(userId)            → résout la langue d'un user
 *    - t(key, lang, fallback, vars)   → traduit une clé i18n
 *    - clearCache()                   → vide le cache (debug)
 */

const db = require('../config/database');

// ═══════════════════════════════════════════════════════════════════════════
// CACHE en mémoire
// ═══════════════════════════════════════════════════════════════════════════
const TRANSLATIONS_CACHE = new Map();   // key = "lang::key", value = string
const USER_LANG_CACHE = new Map();      // key = userId, value = lang
const CACHE_TTL_MS = 5 * 60 * 1000;     // 5 minutes
const cacheTimestamps = { translations: 0, userLang: new Map() };

const VALID_LANGS = ['fr', 'en', 'de'];
const DEFAULT_LANG = 'fr';

// ═══════════════════════════════════════════════════════════════════════════
// 1. getUserLang — résout la langue d'un user avec multi-fallback
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Résout la langue préférée d'un user.
 *
 * Priorité :
 *   1. users.preferred_lang
 *   2. push_tokens.locale (le plus récent)
 *   3. 'fr' (fallback)
 *
 * @param {string} userId - UUID de l'user
 * @returns {Promise<string>} 'fr' | 'en' | 'de'
 */
async function getUserLang(userId) {
  if (!userId) return DEFAULT_LANG;

  // Cache hit (par user, TTL 5 min)
  const cached = USER_LANG_CACHE.get(userId);
  const cachedAt = cacheTimestamps.userLang.get(userId) || 0;
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  let lang = DEFAULT_LANG;

  try {
    // 1. Lookup users.preferred_lang
    const { data: user } = await db.from('users')
      .select('preferred_lang')
      .eq('id', userId)
      .maybeSingle();

    if (user?.preferred_lang && VALID_LANGS.includes(user.preferred_lang)) {
      lang = user.preferred_lang;
    } else {
      // 2. Fallback push_tokens.locale (le plus récent)
      const { data: token } = await db.from('push_tokens')
        .select('locale')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (token?.locale && VALID_LANGS.includes(token.locale)) {
        lang = token.locale;
      }
    }
  } catch (e) {
    console.log('[i18nService] getUserLang error:', e.message);
  }

  // Cache pour 5 min
  USER_LANG_CACHE.set(userId, lang);
  cacheTimestamps.userLang.set(userId, Date.now());

  return lang;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. _loadTranslations — charge toutes les traductions en cache
// ═══════════════════════════════════════════════════════════════════════════
async function _loadTranslations() {
  // Si le cache est encore frais, ne rien faire
  if (Date.now() - cacheTimestamps.translations < CACHE_TTL_MS && TRANSLATIONS_CACHE.size > 0) {
    return;
  }

  try {
    const { data: rows } = await db.from('translations')
      .select('lang, key, value');

    if (!rows) return;

    TRANSLATIONS_CACHE.clear();
    for (const row of rows) {
      TRANSLATIONS_CACHE.set(`${row.lang}::${row.key}`, row.value);
    }
    cacheTimestamps.translations = Date.now();
    console.log(`[i18nService] Loaded ${rows.length} translations into cache`);
  } catch (e) {
    console.log('[i18nService] _loadTranslations error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. t — traduit une clé avec fallback et interpolation de variables
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Traduit une clé i18n.
 *
 * @param {string} key       - Clé de traduction (ex: 'chat.send')
 * @param {string} lang      - 'fr' | 'en' | 'de'
 * @param {string} fallback  - Texte de fallback si clé non trouvée
 * @param {object} vars      - Variables d'interpolation { name: 'Thomy' } → "{name}" remplacé
 * @returns {Promise<string>}
 */
async function t(key, lang = DEFAULT_LANG, fallback = '', vars = {}) {
  if (!VALID_LANGS.includes(lang)) lang = DEFAULT_LANG;

  // S'assurer que le cache est chargé
  await _loadTranslations();

  // Lookup direct
  let value = TRANSLATIONS_CACHE.get(`${lang}::${key}`);

  // Fallback FR si la traduction n'existe pas dans cette langue
  if (!value && lang !== DEFAULT_LANG) {
    value = TRANSLATIONS_CACHE.get(`${DEFAULT_LANG}::${key}`);
  }

  // Fallback final = paramètre fallback ou clé brute
  if (!value) value = fallback || key;

  // Interpolation de variables : "Bonjour {name}" + { name: 'Thomy' } → "Bonjour Thomy"
  if (vars && Object.keys(vars).length > 0) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }

  return value;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. clearCache — vide le cache (debug / tests)
// ═══════════════════════════════════════════════════════════════════════════
function clearCache() {
  TRANSLATIONS_CACHE.clear();
  USER_LANG_CACHE.clear();
  cacheTimestamps.translations = 0;
  cacheTimestamps.userLang.clear();
  console.log('[i18nService] Cache cleared');
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  getUserLang,
  t,
  clearCache,
  VALID_LANGS,
  DEFAULT_LANG,
};
