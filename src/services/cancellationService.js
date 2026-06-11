// services/cancellationService.js
// ✅ V14.8 Phase 2 — Calcul du remboursement à l'annulation (politique + frais d'annulation)
const db = require('../config/database');

const DAY_MS = 24 * 60 * 60 * 1000;

// % du SOUS-TOTAL remboursé selon la politique et le nb de jours avant l'arrivée.
// Règles validées : flexible (≥24h→100), moderate (≥5j→100 / ≥24h→50), strict (≥7j→50), non_refundable (0).
function policyRefundPct(policyCode, daysBefore) {
  switch (policyCode) {
    case 'flexible':       return daysBefore >= 1 ? 100 : 0;
    case 'moderate':       return daysBefore >= 5 ? 100 : (daysBefore >= 1 ? 50 : 0);
    case 'strict':         return daysBefore >= 7 ? 50 : 0;
    case 'non_refundable': return 0;
    default:               return 100; // politique inconnue → prudent (remboursement intégral)
  }
}

class CancellationService {
  // Frais d'annulation global (0/10/20/30) depuis app_config, versé au PARTENAIRE
  async getCancellationFeePct() {
    try {
      const { data } = await db.from('app_config').select('value').eq('key', 'cancellation_fee_pct').single();
      const pct = Number(data?.value);
      return Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0;
    } catch (e) { return 0; }
  }

  // Calcule le détail financier d'une annulation.
  //   booking : { subtotal, service_fee, start_date }
  //   listing : { cancel_policy }
  async compute(booking, listing) {
    const ST = Number(booking?.subtotal) || 0;
    const SF = Number(booking?.service_fee) || 0;
    const now = Date.now();
    const startMs = booking?.start_date ? new Date(booking.start_date).getTime() : now;
    const daysBefore = (startMs - now) / DAY_MS;

    const policyCode   = listing?.cancel_policy || 'flexible';
    const refundPct    = policyRefundPct(policyCode, daysBefore);
    const cancelFeePct = await this.getCancellationFeePct();

    const r = Math.round;
    // Remboursement client = ST×politique% − ST×frais%, borné à [0, ST]. Frais de service jamais remboursé.
    let clientRefund = r(ST * refundPct / 100) - r(ST * cancelFeePct / 100);
    clientRefund = Math.max(0, Math.min(ST, clientRefund));

    // ✅ Compensation partenaire = TOUT le non-remboursé (frais d'annulation + pénalité de la
    //    politique qu'il a choisie pour protéger son calendrier). ZUKAGO ne garde que le frais de service.
    const partnerComp = ST - clientRefund;

    return {
      policyCode,
      daysBefore: Math.floor(daysBefore),
      refundPct,
      cancelFeePct,
      clientRefund,        // remboursé au client (hors frais de service)
      partnerComp,         // compensation versée au partenaire
      serviceFeeKept: SF,  // gardé par ZUKAGO (non remboursable)
    };
  }
}

module.exports = new CancellationService();
