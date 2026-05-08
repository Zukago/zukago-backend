const express = require('express');
const db = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// ─── GET /api/config/app ─────────────────────────────────────────────────────
// Toute la configuration de l'app (§3.7 — rien n'est hardcodé)
router.get('/app', asyncHandler(async (req, res) => {
  const lang = req.query.lang || 'fr';

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
    { data: translations },
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
    db.from('translations').select('key, value').eq('lang', lang),
    // ✅ NOUVEAU V6 : 2 nouvelles queries
    db.from('how_it_works_by_service').select('*').eq('lang', lang).order('service_code').order('step_order'),
    db.from('partner_section_by_service').select('*').eq('lang', lang),
    // ✅ NOUVEAU V8 : équipements par service
    db.from('amenities_by_service').select('*').eq('lang', lang).order('service_code').order('sort_order'),
  ]);

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
  const partnerSectionByService = {};
  for (const row of partnerSectionByServiceRaw || []) {
    partnerSectionByService[row.service_code] = {
      tag:         row.tag,
      title:       row.title,
      description: row.description,
      stat_num:    row.stat_num,
      stat_txt:    row.stat_txt,
      perks:       Array.isArray(row.perks) ? row.perks : (typeof row.perks === 'string' ? JSON.parse(row.perks) : []),
      cta_label:   row.cta_label,
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

  res.json({
    appConfig,
    services:       i18nServices,
    cities:         i18nCities,
    amenities:      i18nAmenities,
    paymentMethods: i18nPaymentMethods,
    languages,
    currencies,
    navTabs:        i18nNavTabs,
    profileMenu:    i18nProfileMenu,
    howItWorks,
    partnerSection: partnerSection?.[0] || partnerSection,
    promoBanners,
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
