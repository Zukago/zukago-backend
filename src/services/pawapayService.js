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

// Vérification de signature des callbacks : 'off' | 'log' | 'enforce'
//   off     = ne vérifie rien (renvoie true) — comportement initial
//   log     = vérifie + écrit le résultat dans les logs MAIS ne bloque jamais
//   enforce = bloque (401) si digest OU signature invalide
const PAWAPAY_SIGNATURE_MODE = (process.env.PAWAPAY_SIGNATURE_MODE || 'off').toLowerCase();

// Lib RFC-9421 chargée paresseusement : si pas encore installée, le module
// se charge quand même (pas de crash). → npm install http-message-signatures
let _httpSig = null;
try { _httpSig = require('http-message-signatures'); } catch (_) { /* non installé */ }

// Cache des clés publiques pawaPay (rafraîchi ~1×/h)
let _pubKeys = null, _pubKeysAt = 0;

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

// ── 4) Vérification signature des callbacks (RFC-9421) ───────────────────
//   pawaPay signe ses callbacks : en-têtes Content-Digest / Signature /
//   Signature-Input (alg ecdsa-p256-sha256). On vérifie :
//     1) Content-Digest == hash(corps brut)  → le corps n'a pas été modifié
//     2) la signature RFC-9421 avec la clé publique pawaPay (GET /public-key/http)
//   Activation progressive via PAWAPAY_SIGNATURE_MODE (off → log → enforce).

// Récupère + cache les clés publiques pawaPay : { id: pemKey }
async function getPawapayPublicKeys() {
  const now = Date.now();
  if (_pubKeys && (now - _pubKeysAt) < 3600000) return _pubKeys;
  const res = await fetch(`${PAWAPAY_BASE_URL}/public-key/http`, {
    headers: { 'Authorization': `Bearer ${PAWAPAY_TOKEN}` },
  });
  if (!res.ok) throw new Error(`public-key/http HTTP ${res.status}`);
  const arr = await res.json(); // [{ id, key }]
  const map = {};
  for (const k of (Array.isArray(arr) ? arr : [])) map[k.id] = k.key;
  _pubKeys = map; _pubKeysAt = now;
  return map;
}

// Vérifie l'en-tête Content-Digest (sha-256/sha-512=:base64:) vs le corps brut
function verifyContentDigest(rawBody, header) {
  if (!header || !rawBody) return false;
  const m = String(header).match(/(sha-256|sha-512)=:([^:]+):/i);
  if (!m) return false;
  const algo = m[1].toLowerCase() === 'sha-256' ? 'sha256' : 'sha512';
  const expected = m[2];
  const actual = crypto.createHash(algo).update(rawBody).digest('base64');
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

//   headers : req.headers (clés en minuscules)
//   rawBody : Buffer du corps brut (capté via express.json({verify}) dans index.js)
//   reqInfo : { method, path, authority } pour reconstruire la base de signature
async function verifyCallbackSignature(headers = {}, rawBody, reqInfo = {}) {
  if (PAWAPAY_SIGNATURE_MODE === 'off') return true;

  let digestOk = false, sigOk = false, detail = '';

  try { digestOk = verifyContentDigest(rawBody, headers['content-digest']); }
  catch (e) { detail += ` digestErr=${e.message}`; }

  try {
    if (!_httpSig) throw new Error('http-message-signatures non installé');
    if (!PAWAPAY_TOKEN) throw new Error('PAWAPAY_API_TOKEN absent');
    const keys = await getPawapayPublicKeys();
    const authority = reqInfo.authority || headers['host'] || '';
    const url = `https://${authority}${reqInfo.path || ''}`;
    const result = await _httpSig.httpbis.verifyMessage({
      async keyLookup(params) {
        const pem = keys[params.keyid];
        if (!pem) return null;
        return {
          id: params.keyid,
          algs: ['ecdsa-p256-sha256'],
          verify: async (data, signature) =>
            crypto.verify('sha256', data, { key: pem, dsaEncoding: 'ieee-p1363' }, signature),
        };
      },
    }, { method: reqInfo.method || 'POST', url, headers });
    sigOk = (result === true);
  } catch (e) { detail += ` sigErr=${e.message}`; }

  console.log(`[pawapay signature] mode=${PAWAPAY_SIGNATURE_MODE} digest=${digestOk} sig=${sigOk}${detail}`);

  if (PAWAPAY_SIGNATURE_MODE === 'log') return true; // ne bloque jamais en mode log
  return digestOk && sigOk;                            // enforce
}

module.exports = {
  initiateDeposit,
  initiatePayout,
  initiateRefund,
  verifyCallbackSignature,
  getPawapayPublicKeys,
  toMsisdn,
  toPawapayAmount,
  correspondentFor,
  CMR_CORRESPONDENTS,
  CMR_CURRENCY,
  CMR_COUNTRY,
};
