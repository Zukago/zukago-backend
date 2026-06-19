// ════════════════════════════════════════════════════════════════════════
// ZUKAGO — Service pawaPay (Mobile Money MTN + Orange · Cameroun)
//   • initiateDeposit → ENCAISSEMENT : le client paie en MoMo
//   • initiatePayout  → VIREMENT     : on paie le partenaire sur son MoMo ("Virer")
//   • initiateRefund  → REMBOURSEMENT réel MoMo (annulation client)
//
//   API ASYNCHRONE : on initie une opération → réponse "ACCEPTED" → le statut
//   FINAL (COMPLETED / FAILED) arrive via un CALLBACK (même logique que le
//   webhook Stripe). Doc officielle : https://docs.pawapay.io
//
//   ⚠️ SQUELETTE — à activer une fois le compte pawaPay validé + clés en env.
//      Tant que PAWAPAY_API_TOKEN est absent, les appels sont ignorés (no-op),
//      donc l'inclure ne casse rien tant que ce n'est pas branché.
//   Nécessite Node 18+ (global fetch) — OK sur Railway.
//
//   Variables d'environnement (Railway) :
//     PAWAPAY_BASE_URL   = https://api.sandbox.pawapay.io   (puis .pawapay.io en prod)
//     PAWAPAY_API_TOKEN  = <token généré dans le dashboard pawaPay>
// ════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const PAWAPAY_BASE_URL = (process.env.PAWAPAY_BASE_URL || 'https://api.sandbox.pawapay.io').replace(/\/$/, '');
const PAWAPAY_TOKEN    = process.env.PAWAPAY_API_TOKEN || '';

// Opérateurs Cameroun → "correspondents" pawaPay
const CMR_CORRESPONDENTS = {
  mtn:    'MTN_MOMO_CMR',
  orange: 'ORANGE_CMR',
};
const CMR_COUNTRY  = 'CMR';
const CMR_CURRENCY = 'XAF'; // FCFA — pas de décimales

// ── Helpers ─────────────────────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID();
}

// XAF n'accepte pas de décimales → entier en chaîne (sans zéro de tête)
function toPawapayAmount(fcfa) {
  return String(Math.round(Number(fcfa) || 0));
}

// Normalise un numéro camerounais en MSISDN international SANS "+" : 237XXXXXXXXX
function toMsisdn(phone) {
  let p = String(phone || '').replace(/[^0-9]/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  p = p.replace(/^237/, '');
  return '237' + p;
}

function correspondentFor(operator) {
  const c = CMR_CORRESPONDENTS[String(operator || '').toLowerCase()];
  if (!c) throw new Error(`[pawapay] opérateur inconnu: ${operator}`);
  return c;
}

async function pawapayRequest(path, body) {
  if (!PAWAPAY_TOKEN) {
    console.log('[pawapay] ⚠️ PAWAPAY_API_TOKEN absent — appel ignoré (squelette non activé):', path);
    return { skipped: true };
  }
  const res = await fetch(`${PAWAPAY_BASE_URL}${path}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${PAWAPAY_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    console.log(`[pawapay] ${path} HTTP ${res.status}:`, text);
    const err = new Error(`pawaPay ${path} failed (${res.status})`);
    err.status = res.status;
    err.data   = data;
    throw err;
  }
  return data;
}

// ── 1) DEPOSIT — encaissement client (MoMo) ──────────────────────────────
//   Retour : { depositId, status: 'ACCEPTED', created }
//   Le client reçoit un push/USSD sur son téléphone pour saisir son PIN.
//   Le statut final (COMPLETED) arrivera via le callback → on crée le booking.
async function initiateDeposit({ depositId: providedId, amountFcfa, operator, phone, statementDescription, metadata }) {
  const depositId = providedId || uuid();
  const body = {
    depositId,
    amount:        toPawapayAmount(amountFcfa),
    currency:      CMR_CURRENCY,
    country:       CMR_COUNTRY,
    correspondent: correspondentFor(operator),
    payer:         { type: 'MSISDN', address: { value: toMsisdn(phone) } },
    customerTimestamp:    new Date().toISOString(),
    statementDescription: String(statementDescription || 'ZUKAGO').slice(0, 22),
    ...(Array.isArray(metadata) && metadata.length ? { metadata } : {}),
  };
  const res = await pawapayRequest('/deposits', body);
  return { depositId, ...res };
}

// ── 2) PAYOUT — virement au partenaire (MoMo) → bouton "Virer" ───────────
//   Retour : { payoutId, status: 'ACCEPTED', created }
//   Aucune action du destinataire requise ; crédité en quelques secondes.
async function initiatePayout({ amountFcfa, operator, phone, statementDescription }) {
  const payoutId = uuid();
  const body = {
    payoutId,
    amount:        toPawapayAmount(amountFcfa),
    currency:      CMR_CURRENCY,
    country:       CMR_COUNTRY,
    correspondent: correspondentFor(operator),
    recipient:     { type: 'MSISDN', address: { value: toMsisdn(phone) } },
    customerTimestamp:    new Date().toISOString(),
    statementDescription: String(statementDescription || 'ZUKAGO').slice(0, 22),
  };
  const res = await pawapayRequest('/payouts', body);
  return { payoutId, ...res };
}

// ── 3) REFUND — remboursement réel MoMo (annulation client) ──────────────
//   Rembourse un deposit existant. Retour : { refundId, status: 'ACCEPTED', created }
async function initiateRefund({ depositId, amountFcfa, statementDescription }) {
  const refundId = uuid();
  const body = {
    refundId,
    depositId,
    amount:               toPawapayAmount(amountFcfa),
    currency:             CMR_CURRENCY,
    statementDescription: String(statementDescription || 'ZUKAGO remb').slice(0, 22),
  };
  const res = await pawapayRequest('/refunds', body);
  return { refundId, ...res };
}

// ── 4) Vérification signature des callbacks (RFC-9421) — À COMPLÉTER ──────
//   pawaPay peut signer ses callbacks (en-têtes Signature / Signature-Input /
//   Content-Digest). TODO : implémenter la vérif RFC-9421 avec la clé publique
//   pawaPay (endpoint Public Keys) avant la PROD.
//   En attendant : sécuriser par WHITELIST des IP pawaPay au niveau infra :
//     Prod : 18.192.208.15, 18.195.113.136, 3.72.212.107, 54.73.125.42,
//            54.155.38.214, 54.73.130.113   ·   Sandbox : 3.64.89.224
function verifyCallbackSignature(/* headers, rawBody */) {
  // Placeholder : true tant que la vérif signée n'est pas activée.
  // ⚠️ À implémenter avant la prod (sécurité).
  return true;
}

module.exports = {
  initiateDeposit,
  initiatePayout,
  initiateRefund,
  verifyCallbackSignature,
  toMsisdn,
  toPawapayAmount,
  correspondentFor,
  CMR_CORRESPONDENTS,
  CMR_CURRENCY,
  CMR_COUNTRY,
};
