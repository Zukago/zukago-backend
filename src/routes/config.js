const express = require('express');
const db = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// ─── GET /api/config/app ─────────────────────────────────────────────────────
// Toute la configuration de l'app (§3.7 — rien n'est hardcodé)
router.get('/app', asyncHandler(async (req, res) => {
  const lang = req.query.lang || 'fr';

  // ✅ V14.5.3 PHASE 3 FIX (PRO) : pagination forcée des translations
  // → Supabase a une limite serveur (max-rows=1000 par défaut)
  // → Même .limit(10000) ne suffit pas si la config serveur force max-rows
  // → On fait des queries paginées explicites avec .range() et on merge
  // → Ainsi on récupère TOUTES les keys (2036+) quelle que soit la config serveur
  const fetchAllTranslations = async (lang) => {
    const PAGE_SIZE = 1000;  // Compatible avec toutes les configs Supabase
    const all = [];
    let from = 0;
    while (true) {
      const { data, error } = await db
        .from('translations')
        .select('key, value')
        .eq('lang', lang)
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        console.error('[fetchAllTranslations]', lang, 'page', from, error.message);
        break;
      }
      if (!data || data.length === 0) break;
      all.push(...data);
      // Si on a reçu moins que PAGE_SIZE, c'est la dernière page
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
      // Sécurité : max 20 pages (20000 rows) pour éviter boucle infinie
      if (from >= 20000) break;
    }
    console.log(`[ZUKAGO i18n] Loaded ${all.length} translations for lang=${lang}`);
    return all;
  };

  // Lance la pagination translations en parallèle avec les autres queries
  const translationsPromise = fetchAllTranslations(lang);

  const [
    { data: configs },
    { data: services },
    { data: cities },
    { data: amenities },
    { data: paymentMethods },
    { data: languages },
    { data: currencies },
    { data: navTabs },
    { data: profileMenu },
    { data: howItWorks },
    { data: partnerSection },
    { data: promoBanners },
    // ✅ NOUVEAU V6 : contenu dynamique par service
    { data: howItWorksByServiceRaw },
    { data: partnerSectionByServiceRaw },
    // ✅ NOUVEAU V8 : équipements par service
    { data: amenitiesByServiceRaw },
  ] = await Promise.all([
    db.from('app_config').select('key, value, type'),
    db.from('services').select('*').eq('enabled', true).order('sort_order'),
    db.from('cities').select('*').eq('active', true).order('sort_order'),
    db.from('amenities').select('*').eq('active', true).order('sort_order'),
    db.from('payment_methods').select('*').eq('enabled', true).order('sort_order'),
    db.from('languages').select('*').eq('enabled', true),
    db.from('currencies').select('*').eq('enabled', true),
    db.from('nav_tabs').select('*').eq('enabled', true).order('sort_order'),
    db.from('profile_menu').select('*').eq('enabled', true).order('sort_order'),
    db.from('how_it_works').select('*').order('sort_order'),
    db.from('partner_section').select('*').single(),
    db.from('promo_banners').select('*').eq('enabled', true).order('sort_order'),
    // ✅ NOUVEAU V6 : 2 nouvelles queries
    db.from('how_it_works_by_service').select('*').eq('lang', lang).order('service_code').order('step_order'),
    db.from('partner_section_by_service').select('*'),  // ✅ V14.5.3 i18n : pas de filtre lang (multi-colonnes _fr/_en/_de)
    // ✅ NOUVEAU V8 : équipements par service
    db.from('amenities_by_service').select('*').eq('lang', lang).order('service_code').order('sort_order'),
  ]);

  // ✅ V14.5.3 PHASE 3 FIX (PRO) : récupérer les translations (paginées)
  // → Lancée en parallèle avec les autres queries — résolue ici
  const translations = await translationsPromise;

  // Parser les configs
  const appConfig = {};
  for (const c of configs || []) {
    appConfig[c.key] = c.type === 'json' ? JSON.parse(c.value) :
                       c.type === 'number' ? Number(c.value) :
                       c.type === 'boolean' ? c.value === 'true' : c.value;
  }

  // Parser les traductions
  const translationsMap = {};
  for (const t of translations || []) translationsMap[t.key] = t.value;

  // ✅ V14.5.3 i18n : helper pour traduire les labels DB depuis translationsMap
  // Pattern : si la key `${prefix}_${code}` existe en translations → on remplace
  //           sinon on garde le label FR original (fallback)
  // Rétro-compat : aucun changement de format de réponse
  const applyI18n = (rows, prefix, codeField = 'code', labelField = 'label') => {
    if (!Array.isArray(rows)) return rows;
    return rows.map(row => {
      const code = row[codeField];
      if (!code) return row;
      const key = `${prefix}_${code}`;
      const translated = translationsMap[key];
      return translated ? { ...row, [labelField]: translated } : row;
    });
  };

  // ✅ V14.5.3 i18n : helper pour traduire UN champ spécifique d'un objet
  // Utilisé pour les rows uniques (partner_section) ou avec champs multiples (how_it_works)
  const tDb = (key, fallback) => translationsMap[key] || fallback;

  // ✅ V14.5.3 i18n : traduire how_it_works (table simple, fallback)
  // ⚠️ Cette table a des colonnes natives multilingues : title_fr, title_en, desc_fr, desc_en
  // (pas de _de — fallback via translations table avec key how_step{N}_title/desc)
  // Le frontend HomeScreen utilise row.title et row.desc → on les remplit selon la lang.
  //
  // ⚠️ DB ZUKAGO : step_num est TEXT avec zéro-padding ("01", "02", "03", "04")
  // → On essaye 2 versions de key : how_step01_title ET how_step1_title pour matcher
  const i18nHowItWorks = (rows) => {
    if (!Array.isArray(rows)) return rows;
    return rows.map(row => {
      // Étape 1 : essayer les colonnes natives _${lang}
      const nativeTitle = row[`title_${lang}`];
      const nativeDesc  = row[`desc_${lang}`];
      // Étape 2 : fallback translations (utile pour DE qui n'existe pas en colonne)
      // Tester step_num original ET sans zéro-padding (parseInt) pour être robuste
      const stepRaw = row.step_num || row.sort_order;
      const stepInt = parseInt(stepRaw, 10);
      let trTitle = null, trDesc = null;
      if (stepRaw) {
        trTitle = translationsMap[`how_step${stepRaw}_title`] || (stepInt ? translationsMap[`how_step${stepInt}_title`] : null);
        trDesc  = translationsMap[`how_step${stepRaw}_desc`]  || (stepInt ? translationsMap[`how_step${stepInt}_desc`]  : null);
      }
      // Étape 3 : fallback FR (la valeur originale)
      return {
        ...row,
        title: nativeTitle || trTitle || row.title_fr || row.title,
        desc:  nativeDesc  || trDesc  || row.desc_fr  || row.desc,
      };
    });
  };

  // ✅ V14.5.3 i18n : traduire partner_section (single row, fallback statique)
  // ⚠️ Colonnes natives : title_fr, title_en, subtitle_fr, subtitle_en, cta_label_fr, cta_label_en
  // (features est jsonb FR uniquement → traduit via translations key partner_section_features)
  const i18nPartnerSection = (section) => {
    if (!section) return section;
    const row = Array.isArray(section) ? section[0] : section;
    if (!row) return section;
    // Features peut être JSON array natif (jsonb) ou string à parser
    let translatedFeatures = Array.isArray(row.features)
      ? row.features
      : (typeof row.features === 'string' ? (() => {
          try { return JSON.parse(row.features); } catch { return []; }
        })() : []);
    const featuresKey = translationsMap['partner_section_features'];
    if (featuresKey) {
      try {
        translatedFeatures = typeof featuresKey === 'string' ? JSON.parse(featuresKey) : featuresKey;
      } catch (e) { /* fallback to original */ }
    }
    return {
      ...row,
      title:    row[`title_${lang}`]    || translationsMap['partner_section_title']    || row.title_fr    || row.title,
      subtitle: row[`subtitle_${lang}`] || translationsMap['partner_section_subtitle'] || row.subtitle_fr || row.subtitle,
      ctaLabel: row[`cta_label_${lang}`] || translationsMap['partner_section_cta']     || row.cta_label_fr || row.ctaLabel,
      cta_label: row[`cta_label_${lang}`] || translationsMap['partner_section_cta']    || row.cta_label_fr || row.cta_label,
      ctaEnabled: row.cta_enabled !== undefined ? row.cta_enabled : (row.ctaEnabled !== undefined ? row.ctaEnabled : true),
      features: translatedFeatures,
    };
  };

  // ✅ V14.5.3 i18n : traduire promo_banners
  // ⚠️ Cette table n'a qu'une colonne `text` (pas multilingue native)
  // Traduction via translations avec key promo_banner_${id}_text
  const i18nPromoBanners = (rows) => {
    if (!Array.isArray(rows)) return rows;
    return rows.map(row => {
      if (!row.id) return row;
      return {
        ...row,
        text: translationsMap[`promo_banner_${row.id}_text`] || row.text,
      };
    });
  };

  // ✅ V14.5.3 i18n : traduire les valeurs string de appConfig
  // Pour chaque key qui a une string traduisible (ex: slogan_sub) :
  // si translations a `app_config_${key}` → on remplace
  const i18nAppConfig = (cfg) => {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const out = { ...cfg };
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (typeof v !== 'string') continue;
      const translated = translationsMap[`app_config_${k}`];
      if (translated) out[k] = translated;
    }
    return out;
  };

  // Quartiers par ville
  const { data: quartiers } = await db.from('quartiers')
    .select('city_code, label').eq('active', true).order('sort_order');
  const quartiersMap = {};
  for (const q of quartiers || []) {
    if (!quartiersMap[q.city_code]) quartiersMap[q.city_code] = [];
    quartiersMap[q.city_code].push(q.label);
  }

  // Types appartement et voiture depuis config
  const aptTypes = JSON.parse(
    configs?.find(c => c.key === 'apt_types')?.value || '["Studio","1 chambre","2 chambres","3 chambres","4+ chambres","Villa","Duplex"]'
  );
  const carTypes = JSON.parse(
    configs?.find(c => c.key === 'car_types')?.value || '["Berline","SUV","4x4","Minibus","Pickup","Luxe"]'
  );

  // ✅ NOUVEAU V6 : Transformer en objet { apt: [steps], hotel: [steps], ... }
  const howItWorksByService = {};
  for (const row of howItWorksByServiceRaw || []) {
    if (!howItWorksByService[row.service_code]) howItWorksByService[row.service_code] = [];
    howItWorksByService[row.service_code].push({
      step_order:  row.step_order,
      icon_name:   row.icon_name,
      title:       row.title,
      description: row.description,
      video_url:   row.video_url || null,   // ✅ V7 : URL vidéo Cloudinary
    });
  }

  // ✅ NOUVEAU V6 : Transformer en objet { apt: {...}, hotel: {...}, ... }
  // ✅ V14.5.3 i18n : la table a maintenant des colonnes _fr/_en/_de
  // → on lit la bonne colonne selon `lang`, avec fallback _fr puis sur la valeur native
  const partnerSectionByService = {};
  for (const row of partnerSectionByServiceRaw || []) {
    const pickField = (base) => {
      // Priorité : colonne _${lang} → colonne _fr → colonne native (legacy)
      return row[`${base}_${lang}`] || row[`${base}_fr`] || row[base];
    };
    const pickPerks = () => {
      const raw = row[`perks_${lang}`] || row.perks_fr || row.perks;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return []; }
      }
      return [];
    };
    partnerSectionByService[row.service_code] = {
      tag:         pickField('tag'),
      title:       pickField('title'),
      description: pickField('description'),
      stat_num:    row.stat_num,                  // numérique → pas de traduction
      stat_txt:    pickField('stat_txt'),
      perks:       pickPerks(),
      cta_label:   pickField('cta_label'),
    };
  }

  // ✅ NOUVEAU V8 : Équipements groupés par service
  const amenitiesByService = {};
  for (const row of amenitiesByServiceRaw || []) {
    if (!amenitiesByService[row.service_code]) amenitiesByService[row.service_code] = [];
    amenitiesByService[row.service_code].push({
      code:       row.code,
      label:      row.label,
      icon_name:  row.icon_name,
      sort_order: row.sort_order,
    });
  }

  // ✅ V14.5.3 i18n : Traduire les labels depuis translationsMap (avec fallback FR)
  // Keys attendues dans translations :
  //   service_apt, service_hotel, service_car, service_driver, service_cov, ...
  //   amenity_wifi, amenity_pool, amenity_ac, ...
  //   payment_card, payment_mtn, payment_orange, payment_paypal, ...
  //   city_douala, city_yaounde, ...
  //   nav_home, nav_search, ...
  //   profile_menu_my_bookings, ...
  const i18nServices       = applyI18n(services,       'service');
  const i18nAmenities      = applyI18n(amenities,      'amenity');
  const i18nPaymentMethods = applyI18n(paymentMethods, 'payment');
  const i18nCities         = applyI18n(cities,         'city');
  const i18nNavTabs        = applyI18n(navTabs,        'nav');
  const i18nProfileMenu    = applyI18n(profileMenu,    'profile_menu');

  // ✅ V14.5.3 i18n : nouveaux helpers pour les sections "rich content"
  // Keys attendues :
  //   how_step1_title, how_step1_desc, how_step2_title, ...
  //   partner_section_title, partner_section_subtitle, partner_section_cta,
  //     partner_section_features (JSON array stringified)
  //   promo_banner_${id}_text, promo_banner_${id}_sub
  //   app_config_${key} pour chaque entrée de appConfig à traduire
  const i18nedHowItWorks    = i18nHowItWorks(howItWorks);
  const i18nedPartnerSection = i18nPartnerSection(partnerSection?.[0] || partnerSection);
  const i18nedPromoBanners  = i18nPromoBanners(promoBanners);
  const i18nedAppConfig     = i18nAppConfig(appConfig);

  res.json({
    appConfig:      i18nedAppConfig,
    services:       i18nServices,
    cities:         i18nCities,
    amenities:      i18nAmenities,
    paymentMethods: i18nPaymentMethods,
    languages,
    currencies,
    navTabs:        i18nNavTabs,
    profileMenu:    i18nProfileMenu,
    howItWorks:     i18nedHowItWorks,
    partnerSection: i18nedPartnerSection,
    promoBanners:   i18nedPromoBanners,
    translations: translationsMap,
    allQuartiers: quartiersMap,
    aptTypes,
    carTypes,
    // ✅ NOUVEAU V6 : contenu dynamique par service
    howItWorksByService,
    partnerSectionByService,
    // ✅ NOUVEAU V8 : équipements par service
    amenitiesByService,
    calendar: {
      months: appConfig[`calendar_months_${lang}`] || appConfig.calendar_months_fr,
      days:   appConfig[`calendar_days_${lang}`]   || appConfig.calendar_days_fr,
    },
  });
}));

// ─── GET /api/config/admin/stats ──────────────────────────────────────────────
router.get('/admin/stats', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const [
    { count: totalUsers },
    { count: totalListings },
    { count: totalBookings },
    { count: totalPartners },
  ] = await Promise.all([
    db.from('users').select('*', { count: 'exact', head: true }),
    db.from('listings').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('bookings').select('*', { count: 'exact', head: true }),
    db.from('partners').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
  ]);

  const { data: revenueData } = await db
    .from('commissions')
    .select('amount')
    .eq('status', 'paid');

  const totalRevenue = revenueData?.reduce((sum, c) => sum + Number(c.amount), 0) || 0;

  // Revenus ce mois
  const firstOfMonth = new Date(); firstOfMonth.setDate(1); firstOfMonth.setHours(0,0,0,0);
  const { data: monthData } = await db.from('commissions')
    .select('amount')
    .gte('created_at', firstOfMonth.toISOString());
  const revenusMois = monthData?.reduce((sum, c) => sum + Number(c.amount), 0) || 0;

  // Taux commission depuis config
  const { data: commConfig } = await db.from('app_config')
    .select('value').eq('key', 'commission_rate').single();

  res.json({
    revenusTotal: totalRevenue,
    revenusMois,
    reservationsTotal: totalBookings,
    partenairesTotal: totalPartners,
    usersTotal: totalUsers,
    annoncesTotal: totalListings,
    commissionRate: Number(commConfig?.value || 17),
  });
}));

// ─── GET /api/config/commission — Public endpoint pour le taux
router.get('/commission', asyncHandler(async (req, res) => {
  const { data } = await db.from('app_config')
    .select('value').eq('key', 'commission_rate').single();
  res.json({ rate: Number(data?.value || 17) });
}));

// ─── PATCH /api/config/:key — Admin modifie une config ────────────────────────
router.patch('/:key', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  const { data, error } = await db.from('app_config')
    .update({ value: String(value), updated_by: req.user.id, updated_at: new Date() })
    .eq('key', key)
    .select()
    .single();

  if (error) return res.status(404).json({ error: 'Config introuvable' });
  res.json({ config: data });
}));

// ─── PATCH /api/config/services/:id — Toggle service ─────────────────────────
router.patch('/services/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  const { data, error } = await db.from('services')
    .update({ enabled })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(404).json({ error: 'Service introuvable' });
  res.json({ service: data });
}));

module.exports = router;
