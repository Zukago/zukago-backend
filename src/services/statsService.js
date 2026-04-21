/**
 * ZUKAGO — statsService.js
 * Service centralisé pour la table stats_daily
 * §3.7 — tout depuis Supabase, rien hardcodé
 *
 * La table stats_daily a une ligne par jour :
 * { id, date, total_bookings, total_revenue, total_commission,
 *   new_users, new_partners, new_listings }
 */

const db = require('../config/database');

/**
 * Retourne la date du jour en format YYYY-MM-DD
 */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Upsert (créer ou mettre à jour) la ligne du jour dans stats_daily.
 * Recalcule TOUTES les valeurs depuis les vraies tables — §3.7 pur.
 * Appelé automatiquement après chaque action importante.
 *
 * @param {string} date - optionnel, format YYYY-MM-DD (défaut = aujourd'hui)
 */
async function updateDay(date = today()) {
  try {
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd   = `${date}T23:59:59.999Z`;

    // Compter en parallèle depuis les vraies tables
    const [
      { count: newUsers },
      { count: newPartners },
      { count: newListings },
      { count: totalBookings },
      { data: revenueData },
      { data: commissionData },
    ] = await Promise.all([
      // Nouveaux utilisateurs ce jour
      db.from('users')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd),

      // Nouveaux partenaires approuvés ce jour
      db.from('partners')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd),

      // Nouvelles annonces ce jour
      db.from('listings')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd),

      // Réservations créées ce jour
      db.from('bookings')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd),

      // Revenus partenaires ce jour (partner_gets)
      db.from('bookings')
        .select('partner_gets')
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)
        .eq('status', 'confirmed'),

      // Commissions ZUKAGO ce jour
      db.from('commissions')
        .select('amount')
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)
        .eq('status', 'paid'),
    ]);

    const total_revenue    = (revenueData    || []).reduce((s, b) => s + Number(b.partner_gets || 0), 0);
    const total_commission = (commissionData || []).reduce((s, c) => s + Number(c.amount       || 0), 0);

    // Upsert — si la ligne du jour existe, on la met à jour ; sinon on la crée
    await db.from('stats_daily').upsert({
      date,
      new_users:        newUsers        || 0,
      new_partners:     newPartners     || 0,
      new_listings:     newListings     || 0,
      total_bookings:   totalBookings   || 0,
      total_revenue,
      total_commission,
    }, { onConflict: 'date' });

  } catch (e) {
    // Non bloquant — une erreur ici ne doit jamais faire planter l'app
    console.log('[statsService] updateDay error:', e.message);
  }
}

/**
 * Reconstruction complète de stats_daily depuis l'origine des données.
 * Utilisé par le bouton "Reconstruire les stats" dans le dashboard admin.
 * Recalcule chaque jour depuis le premier enregistrement jusqu'à aujourd'hui.
 *
 * @returns {Object} { rebuilt: number, from: string, to: string }
 */
async function rebuildAll() {
  // Trouver la date la plus ancienne dans toutes les tables concernées
  const [
    { data: firstUser },
    { data: firstPartner },
    { data: firstBooking },
  ] = await Promise.all([
    db.from('users').select('created_at').order('created_at', { ascending: true }).limit(1),
    db.from('partners').select('created_at').order('created_at', { ascending: true }).limit(1),
    db.from('bookings').select('created_at').order('created_at', { ascending: true }).limit(1),
  ]);

  // Date de départ = la plus ancienne de toutes
  const dates = [
    firstUser?.[0]?.created_at,
    firstPartner?.[0]?.created_at,
    firstBooking?.[0]?.created_at,
  ].filter(Boolean).map(d => d.slice(0, 10));

  if (!dates.length) return { rebuilt: 0, from: null, to: null };

  const fromDate = dates.sort()[0]; // la plus ancienne
  const toDate   = today();

  // Générer toutes les dates entre fromDate et toDate
  const allDates = [];
  const cursor = new Date(fromDate);
  const end    = new Date(toDate);

  while (cursor <= end) {
    allDates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  // Mettre à jour chaque jour — en séquentiel pour ne pas surcharger Supabase
  for (const date of allDates) {
    await updateDay(date);
  }

  return { rebuilt: allDates.length, from: fromDate, to: toDate };
}

/**
 * Lire stats_daily pour une période donnée.
 * Retourne les lignes triées par date croissante.
 *
 * @param {string} from - YYYY-MM-DD
 * @param {string} to   - YYYY-MM-DD
 */
async function getRange(from, to) {
  const { data, error } = await db.from('stats_daily')
    .select('*')
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Lire stats_daily pour un mois donné.
 *
 * @param {number} year
 * @param {number} month - 1..12
 */
async function getMonth(year, month) {
  const m     = String(month).padStart(2, '0');
  const from  = `${year}-${m}-01`;
  // Dernier jour du mois
  const lastDay = new Date(year, month, 0).getDate();
  const to    = `${year}-${m}-${String(lastDay).padStart(2, '0')}`;
  return getRange(from, to);
}

/**
 * Lire stats_daily pour une année complète.
 *
 * @param {number} year
 */
async function getYear(year) {
  return getRange(`${year}-01-01`, `${year}-12-31`);
}

module.exports = { updateDay, rebuildAll, getRange, getMonth, getYear, today };
