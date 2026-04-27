/**
 * ZUKAGO — Pricing Service (V13)
 * ──────────────────────────────────────────────────────────────────────────
 * Centralise TOUS les calculs de prix pour les 5 types de services.
 *
 * Règle d'or §3.7 : ZÉRO HARDCODÉ
 *   - service_fee_rate         ← lu depuis app_config (modifiable Admin)
 *   - commission_rate          ← lu depuis app_config (16% par défaut)
 *   - commission_rate_carpool  ← lu depuis app_config (8% par défaut)
 *
 * Utilisé par :
 *   - bookings.js (POST /bookings)        → calcul réel + écriture BDD
 *   - bookings.js (POST /bookings/quote)  → preview avant réservation
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Usage :
 *   const calc = await pricingService.calculate(listing, params);
 *   // calc = { unit_type, unit_count, subtotal, breakdown,
 *   //          serviceFee, serviceFeeRate, total,
 *   //          commission, commissionRate, partnerGets }
 * ──────────────────────────────────────────────────────────────────────────
 */

const db = require('../config/database');

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS PRIVÉS
// ═══════════════════════════════════════════════════════════════════════════

// ── Récupérer un taux depuis app_config (avec fallback)
async function getConfigRate(key, fallback) {
  try {
    const { data } = await db.from('app_config')
      .select('value').eq('key', key).single();
    const v = Number(data?.value);
    return isNaN(v) ? fallback : v;
  } catch {
    return fallback;
  }
}

// ── Vérifie si une date est un weekend (ven/sam/dim)
// JS: 0=Dim, 1=Lun, ..., 5=Ven, 6=Sam
function isWeekendDay(date) {
  const d = date.getDay();
  return d === 5 || d === 6 || d === 0;
}

// ── Compte le nombre de nuits entre 2 dates (string YYYY-MM-DD)
function nightsBetween(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  return Math.ceil((end - start) / (1000 * 60 * 60 * 24));
}

// ── Génère la liste des dates entre start et end (exclus end pour les nuits)
function listNights(startStr, endStr) {
  const dates = [];
  const start = new Date(startStr);
  const end = new Date(endStr);
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    dates.push(new Date(d));
  }
  return dates;
}

// ── Round half up (évite les flottants)
const r = (n) => Math.round(Number(n) || 0);

// ═══════════════════════════════════════════════════════════════════════════
// CALCULS PAR TYPE
// ═══════════════════════════════════════════════════════════════════════════

// ─── 🏠 APARTMENT ──────────────────────────────────────────────────────────
// params: { start_date, end_date }
// Logique :
//   1) Calcule jour-par-jour avec price_weekend pour ven/sam/dim
//   2) Calcule chaque palier défini (5nights, week, month) si éligible
//   3) Prend le MOINS CHER (avantage client)
function calculateApt(listing, params) {
  // ✅ V13.1 : sécuriser params null/undefined
  const p = params || {};
  const { start_date, end_date } = p;
  if (!start_date || !end_date) {
    throw new Error('Apt : start_date et end_date requis');
  }

  const nights = nightsBetween(start_date, end_date);
  if (nights <= 0) throw new Error('Dates invalides');

  const basePrice    = Number(listing.price)         || 0;
  const weekendPrice = Number(listing.price_weekend) || 0;
  const price5       = Number(listing.price_5nights) || 0;
  const priceWeek    = Number(listing.price_week)    || 0;
  const priceMonth   = Number(listing.price_month)   || 0;

  // ── Calcul jour-par-jour (toujours possible)
  const nightsList = listNights(start_date, end_date);
  let dailySum = 0;
  let weekendCount = 0;
  for (const d of nightsList) {
    if (weekendPrice > 0 && isWeekendDay(d)) {
      dailySum += weekendPrice;
      weekendCount++;
    } else {
      dailySum += basePrice;
    }
  }

  // ── Liste des paliers candidats (uniquement ceux définis ET éligibles)
  const candidates = [
    { name: 'daily',   total: dailySum, label: weekendCount > 0
        ? `${nights - weekendCount} nuit(s) base + ${weekendCount} nuit(s) weekend`
        : `${nights} nuit(s) au tarif base` },
  ];

  if (price5 > 0 && nights >= 5) {
    candidates.push({
      name: '5nights',
      total: r(nights * price5 / 5),
      label: `Tarif 5 nuits appliqué (${nights} nuit(s))`,
    });
  }
  if (priceWeek > 0 && nights >= 7) {
    candidates.push({
      name: 'week',
      total: r(nights * priceWeek / 7),
      label: `Tarif semaine appliqué (${nights} nuit(s))`,
    });
  }
  if (priceMonth > 0 && nights >= 30) {
    candidates.push({
      name: 'month',
      total: r(nights * priceMonth / 30),
      label: `Tarif mensuel appliqué (${nights} nuit(s))`,
    });
  }

  // ── On prend le MOINS CHER (avantage client)
  const winner = candidates.reduce((a, b) => (a.total <= b.total ? a : b));

  return {
    unit_type: 'night',
    unit_count: nights,
    subtotal: winner.total,
    breakdown: [{ label: winner.label, amount: winner.total }],
    meta: { applied_tier: winner.name, candidates_count: candidates.length },
  };
}

// ─── 🏨 HOTEL ──────────────────────────────────────────────────────────────
// params: { start_date, end_date, room_type_id }
// Logique : prix sur la room_type, jour-par-jour, ignore prix du listing
async function calculateHotel(listing, params) {
  // ✅ V13.1 : sécuriser params null/undefined
  const p = params || {};
  const { start_date, end_date, room_type_id } = p;
  if (!start_date || !end_date) {
    throw new Error('Hotel : start_date et end_date requis');
  }
  if (!room_type_id) {
    throw new Error('Hotel : room_type_id requis (chambre à réserver)');
  }

  // Récupérer la room_type depuis la BDD
  const { data: room } = await db.from('listing_room_types')
    .select('*')
    .eq('id', room_type_id)
    .eq('listing_id', listing.id)
    .single();

  if (!room) throw new Error('Chambre introuvable pour cet hôtel');

  const nights = nightsBetween(start_date, end_date);
  if (nights <= 0) throw new Error('Dates invalides');

  // ✅ V13.2 fix : la BDD utilise `price_night` (pas `price`) — wizard StepHotelRoomTypes
  // Compat retro : on lit aussi room.price au cas où certaines lignes l'auraient
  const basePrice    = Number(room.price_night ?? room.price)    || 0;
  const weekendPrice = Number(room.price_weekend)                || 0;
  const roomName     = room.name || room.label || 'Chambre';

  if (basePrice <= 0) {
    throw new Error('Prix de la chambre non défini');
  }

  // Calcul jour-par-jour avec weekend
  const nightsList = listNights(start_date, end_date);
  let dailySum = 0;
  let weekendCount = 0;
  for (const d of nightsList) {
    if (weekendPrice > 0 && isWeekendDay(d)) {
      dailySum += weekendPrice;
      weekendCount++;
    } else {
      dailySum += basePrice;
    }
  }

  const label = weekendCount > 0
    ? `${roomName} : ${nights - weekendCount} nuit(s) base + ${weekendCount} nuit(s) weekend`
    : `${roomName} : ${nights} nuit(s)`;

  return {
    unit_type: 'night',
    unit_count: nights,
    subtotal: dailySum,
    breakdown: [{ label, amount: dailySum }],
    meta: { room_type_id, room_label: roomName },
  };
}

// ─── 🚗 CAR ────────────────────────────────────────────────────────────────
// params: { start_date, end_date, with_driver, zone }
// Logique :
//   1) daily = price (ou price_in_city ou price_out_city selon zone)
//   2) Si with_driver=true ET driver_supplement défini → daily += supplement
//   3) subtotal = daily × days
//   4) Si days >= 7 ET long_rental_discount_pct → réduction sur le total
function calculateCar(listing, params) {
  // ✅ V13.1 : sécuriser params null/undefined
  const p = params || {};
  const { start_date, end_date, with_driver, zone } = p;
  if (!start_date || !end_date) {
    throw new Error('Car : start_date et end_date requis');
  }

  const days = nightsBetween(start_date, end_date);
  if (days <= 0) throw new Error('Dates invalides');

  const basePrice    = Number(listing.price)              || 0;
  const priceInCity  = Number(listing.price_in_city)      || 0;
  const priceOutCity = Number(listing.price_out_city)     || 0;
  const driverSupp   = Number(listing.driver_supplement)  || 0;
  const discountPct  = Number(listing.long_rental_discount_pct) || 0;

  // 1) Choix du prix selon zone
  let daily = basePrice;
  if (zone === 'in_city' && priceInCity > 0)        daily = priceInCity;
  else if (zone === 'out_city' && priceOutCity > 0) daily = priceOutCity;

  if (daily <= 0) throw new Error('Prix de la voiture non défini');

  // 2) Supplément chauffeur si demandé ET disponible
  let dailyWithDriver = daily;
  if (with_driver === true) {
    if (!listing.with_driver) {
      throw new Error('Cette voiture n\'est pas disponible avec chauffeur');
    }
    dailyWithDriver = daily + driverSupp;
  } else {
    if (!listing.without_driver) {
      throw new Error('Cette voiture n\'est disponible qu\'avec chauffeur');
    }
  }

  // 3) Subtotal de base
  let subtotal = dailyWithDriver * days;

  const breakdown = [];
  const zoneLabel = zone === 'in_city'  ? ' (en ville)'
                  : zone === 'out_city' ? ' (hors ville)'
                  : '';
  const driverLabel = with_driver ? ' avec chauffeur' : '';
  breakdown.push({
    label: `${days} jour(s)${zoneLabel}${driverLabel} × ${daily.toLocaleString()}${driverSupp && with_driver ? ` + ${driverSupp.toLocaleString()} suppl.` : ''}`,
    amount: subtotal,
  });

  // 4) Remise longue durée (sur le total avec chauffeur)
  let discountAmount = 0;
  if (days >= 7 && discountPct > 0) {
    discountAmount = r(subtotal * discountPct / 100);
    subtotal -= discountAmount;
    breakdown.push({
      label: `Remise longue durée -${discountPct}%`,
      amount: -discountAmount,
    });
  }

  return {
    unit_type: 'day',
    unit_count: days,
    subtotal,
    breakdown,
    meta: { with_driver: !!with_driver, zone: zone || null, discount_applied: discountAmount > 0 },
  };
}

// ─── 👨‍✈️ DRIVER ────────────────────────────────────────────────────────────
// params: { unit_type, unit_count, zone, extras: { airport_fee } }
// Logique :
//   1) Si zone=longdistance → forfait fixe (price_longdistance)
//   2) Sinon selon unit_type :
//      - 'hour'    → unit_count × price_hour
//      - 'halfday' → price_halfday (forfait 4h, ignore unit_count)
//      - 'day'     → unit_count × price
//   3) airport_fee s'ajoute TOUJOURS si demandé (même en longdistance)
function calculateDriver(listing, params) {
  // ✅ V13.1 fix : default = {} ne couvre que undefined, pas null
  const unit_type  = params?.unit_type;
  const unit_count = params?.unit_count;
  const zone       = params?.zone;
  const extras     = params?.extras || {}; // gère null ET undefined

  const priceDay      = Number(listing.price)              || 0;
  const priceHour     = Number(listing.price_hour)         || 0;
  const priceHalfday  = Number(listing.price_halfday)      || 0;
  const priceLongdist = Number(listing.price_longdistance) || 0;
  const airportFee    = Number(listing.airport_fee)        || 0;

  let subtotal = 0;
  let resolvedUnitType = unit_type;
  let resolvedUnitCount = Number(unit_count) || 1;
  const breakdown = [];

  // 1) Longue distance = forfait fixe
  if (zone === 'longdistance') {
    if (priceLongdist <= 0) {
      throw new Error('Tarif longue distance non défini par ce chauffeur');
    }
    subtotal = priceLongdist;
    resolvedUnitType = 'longdistance';
    resolvedUnitCount = 1;
    breakdown.push({ label: 'Trajet longue distance (forfait)', amount: priceLongdist });
  }
  // 2) Sinon selon unit_type
  else if (unit_type === 'hour') {
    if (priceHour <= 0) throw new Error('Tarif horaire non défini');
    if (resolvedUnitCount < 1) throw new Error('Nombre d\'heures invalide');
    subtotal = priceHour * resolvedUnitCount;
    breakdown.push({
      label: `${resolvedUnitCount} heure(s) × ${priceHour.toLocaleString()}`,
      amount: subtotal,
    });
  }
  else if (unit_type === 'halfday') {
    if (priceHalfday <= 0) throw new Error('Tarif demi-journée non défini');
    subtotal = priceHalfday;
    resolvedUnitCount = 1;
    breakdown.push({ label: 'Demi-journée (4h)', amount: priceHalfday });
  }
  else if (unit_type === 'day') {
    if (priceDay <= 0) throw new Error('Tarif journée non défini');
    if (resolvedUnitCount < 1) throw new Error('Nombre de jours invalide');
    subtotal = priceDay * resolvedUnitCount;
    breakdown.push({
      label: `${resolvedUnitCount} jour(s) × ${priceDay.toLocaleString()}`,
      amount: subtotal,
    });
  }
  else {
    throw new Error(`Driver : unit_type invalide (${unit_type}). Attendu : hour|halfday|day ou zone=longdistance`);
  }

  // 3) Frais aéroport (s'ajoutent toujours, même en longdistance)
  if (extras.airport_fee === true && airportFee > 0) {
    subtotal += airportFee;
    breakdown.push({ label: 'Frais aéroport', amount: airportFee });
  }

  return {
    unit_type: resolvedUnitType,
    unit_count: resolvedUnitCount,
    subtotal,
    breakdown,
    meta: { zone: zone || null, airport_fee: extras.airport_fee === true },
  };
}

// ─── 🚙 CARPOOL ────────────────────────────────────────────────────────────
// params: { seats_booked }
// Logique : seats × price (commission spéciale 8% appliquée plus haut)
function calculateCarpool(listing, params) {
  // ✅ V13.1 : sécuriser params null/undefined
  const p = params || {};
  const { seats_booked } = p;
  const seats = Number(seats_booked) || 0;
  const pricePerSeat = Number(listing.price) || 0;

  if (seats <= 0) throw new Error('Carpool : seats_booked doit être >= 1');
  if (pricePerSeat <= 0) throw new Error('Prix par place non défini');

  const seatsAvail = Number(listing.seats_available);
  if (!isNaN(seatsAvail) && seats > seatsAvail) {
    throw new Error(`Plus que ${seatsAvail} place(s) disponible(s)`);
  }

  const subtotal = pricePerSeat * seats;

  return {
    unit_type: 'place',
    unit_count: seats,
    subtotal,
    breakdown: [{
      label: `${seats} place(s) × ${pricePerSeat.toLocaleString()}`,
      amount: subtotal,
    }],
    meta: { seats_booked: seats },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE PUBLIC
// ═══════════════════════════════════════════════════════════════════════════

class PricingService {

  /**
   * Calcul principal — route vers la fonction adaptée au type de listing
   *
   * @param {Object} listing  Objet listing complet (avec partner_id si possible)
   * @param {Object} params   Paramètres de la réservation côté client
   * @returns {Object}        { unit_type, unit_count, subtotal, breakdown,
   *                            serviceFee, serviceFeeRate, total,
   *                            commission, commissionRate, partnerGets, meta }
   */
  async calculate(listing, params = {}) {
    if (!listing || !listing.type) {
      throw new Error('Listing invalide ou type manquant');
    }

    // ── 1) Calcul subtotal selon le type
    let core;
    switch (listing.type) {
      case 'apt':    core = calculateApt(listing, params);              break;
      case 'hotel':  core = await calculateHotel(listing, params);       break;
      case 'car':    core = calculateCar(listing, params);              break;
      case 'driver': core = calculateDriver(listing, params);           break;
      case 'cov':    core = calculateCarpool(listing, params);          break;
      default:
        throw new Error(`Type de service inconnu : ${listing.type}`);
    }

    // ── 2) Frais de service (depuis app_config — V13 plus jamais hardcodé)
    const serviceFeeRate = await getConfigRate('service_fee_rate', 5);
    const serviceFee = r(core.subtotal * serviceFeeRate / 100);
    const total = core.subtotal + serviceFee;

    // ── 3) Commission différenciée covoit vs autres
    let commissionRate;
    if (listing.type === 'cov') {
      commissionRate = await getConfigRate('commission_rate_carpool', 8);
    } else {
      // Vérifier si le partenaire a un taux personnalisé
      let partnerRate = null;
      const partnerId = listing.partner_id || listing.partners?.id;
      if (partnerId) {
        try {
          const { data: partner } = await db.from('partners')
            .select('commission_rate').eq('id', partnerId).single();
          if (partner?.commission_rate != null) {
            partnerRate = Number(partner.commission_rate);
          }
        } catch { /* ignore */ }
      }
      commissionRate = partnerRate != null
        ? partnerRate
        : await getConfigRate('commission_rate', 16);
    }

    const commission = r(core.subtotal * commissionRate / 100);
    const partnerGets = core.subtotal - commission;

    // ── 4) Résultat unifié
    return {
      // Identification
      unit_type:  core.unit_type,
      unit_count: core.unit_count,

      // Montants (en FCFA, entiers)
      subtotal: core.subtotal,
      serviceFee,
      total,
      commission,
      partnerGets,

      // Taux appliqués (pour traçabilité)
      serviceFeeRate,
      commissionRate,

      // Détail pour affichage frontend
      breakdown: core.breakdown,

      // Métadonnées spécifiques au type (room_type_id, with_driver, zone, etc.)
      meta: core.meta || {},
    };
  }
}

module.exports = new PricingService();

// ═══════════════════════════════════════════════════════════════════════════
// EXEMPLES DE TESTS (commentés — décommente pour valider en local avec node)
// ═══════════════════════════════════════════════════════════════════════════
/*

// 🏠 APT — 6 nuits semaine + weekend, sans palier
const aptListing1 = { type: 'apt', price: 20000, price_weekend: 30000 };
// du jeudi au mercredi (6 nuits : J,V,S,D,L,M → 1 base, 3 weekend, 2 base = 4 base + 3 weekend ?)
// (Note: ven, sam, dim sont weekend → 3 weekend, 3 base = 60000+90000 = 150000)
// → calculate(aptListing1, { start_date: '2026-05-07', end_date: '2026-05-13' })

// 🏠 APT — palier semaine plus avantageux
const aptListing2 = { type: 'apt', price: 20000, price_week: 100000 };
// 7 nuits → daily 7×20000=140000 vs week 7×100000/7=100000 → on prend 100000
// → calculate(aptListing2, { start_date: '2026-05-07', end_date: '2026-05-14' })

// 🚗 CAR — avec chauffeur en ville
const carListing = {
  type: 'car', price: 30000,
  price_in_city: 25000, price_out_city: 50000,
  driver_supplement: 10000, long_rental_discount_pct: 10,
  with_driver: true, without_driver: true,
};
// 8 jours en ville avec chauffeur :
// daily = 25000 + 10000 = 35000
// subtotal = 8 × 35000 = 280000
// remise -10% = -28000
// final = 252000
// → calculate(carListing, { start_date, end_date, with_driver: true, zone: 'in_city' })

// 👨‍✈️ DRIVER — 6h
const driverListing = { type: 'driver', price: 40000, price_hour: 5000, airport_fee: 8000 };
// 6h × 5000 = 30000
// + airport 8000 = 38000
// → calculate(driverListing, { unit_type: 'hour', unit_count: 6, extras: { airport_fee: true } })

// 🚙 COVOIT — 2 places à 5000 (commission 8%)
const covListing = { type: 'cov', price: 5000, seats_available: 4 };
// 2 × 5000 = 10000, commission 800, partnerGets 9200
// → calculate(covListing, { seats_booked: 2 })

*/
