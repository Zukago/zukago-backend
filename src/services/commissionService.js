/**
 * ZUKAGO — Commission Service
 * §3.7 : Taux de commission vient de la base de données, jamais hardcodé
 */

const db = require('../config/database');

class CommissionService {

  // ── Récupérer le taux de commission depuis la DB
  async getRate(partnerId = null) {
    // 1. Vérifier si le partenaire a un taux personnalisé
    if (partnerId) {
      const { data: partner } = await db.from('partners')
        .select('commission_rate').eq('id', partnerId).single();
      if (partner?.commission_rate) return Number(partner.commission_rate);
    }

    // 2. Utiliser le taux global depuis app_config
    const { data: config } = await db.from('app_config')
      .select('value').eq('key', 'commission_rate').single();

    return Number(config?.value || 17);
  }

  // ── Calculer les montants d'une réservation
  async calculate(pricePerNight, nights, partnerId = null) {
    const commissionRate = await this.getRate(partnerId);

    // Frais de service côté client (5% affiché dans le récap)
    const serviceFeeRate = 5;

    const subtotal      = pricePerNight * nights;
    const serviceFee    = Math.round(subtotal * serviceFeeRate / 100);
    const total         = subtotal + serviceFee;

    // Commission ZUKAGO sur le subtotal (pas sur les frais de service)
    const commission    = Math.round(subtotal * commissionRate / 100);
    const partnerGets   = subtotal - commission;

    return {
      pricePerNight,
      nights,
      subtotal,
      serviceFee,
      total,
      commission,
      commissionRate,
      partnerGets,
    };
  }

  // ── Enregistrer une commission en DB
  async record(bookingId, partnerId, amount, rate) {
    const { data, error } = await db.from('commissions').insert({
      booking_id: bookingId,
      partner_id: partnerId,
      amount,
      rate,
      status: 'pending',
    }).select().single();

    if (error) throw new Error(`Commission record error: ${error.message}`);
    return data;
  }

  // ── Marquer commission comme payée
  async markPaid(bookingId) {
    await db.from('commissions')
      .update({ status: 'paid', paid_at: new Date() })
      .eq('booking_id', bookingId);
  }

  // ── Mettre à jour le solde du partenaire
  async creditPartner(partnerId, amount) {
    const { data: partner } = await db.from('partners')
      .select('solde').eq('id', partnerId).single();

    const newSolde = Number(partner.solde || 0) + amount;
    await db.from('partners').update({ solde: newSolde }).eq('id', partnerId);
    return newSolde;
  }

  // ── Déduire du solde (pour retrait)
  async debitPartner(partnerId, amount) {
    const { data: partner } = await db.from('partners')
      .select('solde').eq('id', partnerId).single();

    if (Number(partner.solde) < amount) {
      throw new Error('Solde insuffisant');
    }

    const newSolde = Number(partner.solde) - amount;
    await db.from('partners').update({ solde: newSolde }).eq('id', partnerId);
    return newSolde;
  }

  // ── Stats commissions pour l'admin
  async getStats(period = 'month') {
    const startDate = new Date();
    if (period === 'month') startDate.setDate(1);
    else if (period === 'week') startDate.setDate(startDate.getDate() - 7);
    else if (period === 'year') startDate.setMonth(0, 1);
    startDate.setHours(0, 0, 0, 0);

    const { data } = await db.from('commissions')
      .select('amount, status, created_at')
      .gte('created_at', startDate.toISOString());

    const total   = data?.reduce((sum, c) => sum + Number(c.amount), 0) || 0;
    const paid    = data?.filter(c => c.status === 'paid').reduce((sum, c) => sum + Number(c.amount), 0) || 0;
    const pending = total - paid;

    return { total, paid, pending, count: data?.length || 0, period };
  }
}

module.exports = new CommissionService();
