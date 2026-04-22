/**
 * ZUKAGO — services/emailService.js
 * Service email via Mailgun API
 * Domaine : mg.zukago.com
 * From    : ZUKAGO <noreply@mg.zukago.com>
 */

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN  = process.env.MAILGUN_DOMAIN  || 'mg.zukago.com';
const MAILGUN_FROM    = process.env.MAILGUN_FROM     || 'ZUKAGO <noreply@mg.zukago.com>';
const APP_URL         = process.env.APP_URL          || 'https://zukago.com';

// EU region — api.eu.mailgun.net
const MAILGUN_BASE = `https://api.eu.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`;
// Note: EU region utilise api.eu.mailgun.net (pas api.mailgun.net)

/**
 * Envoyer un email via Mailgun API REST
 */
async function sendEmail({ to, subject, html, text }) {
  if (!MAILGUN_API_KEY) {
    console.log('[emailService] MAILGUN_API_KEY manquant');
    return null;
  }
  if (!MAILGUN_DOMAIN) {
    console.log('[emailService] MAILGUN_DOMAIN manquant');
    return null;
  }

  // Construire le corps en URLSearchParams
  const params = new URLSearchParams();
  params.append('from',    MAILGUN_FROM);
  params.append('to',      to);
  params.append('subject', subject);
  if (html) params.append('html', html);
  if (text) params.append('text', text);

  // Encoder la clé en Base64 pour Basic Auth
  const credentials = Buffer.from('api:' + MAILGUN_API_KEY).toString('base64');

  try {
    const response = await fetch(MAILGUN_BASE, {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + credentials,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    let data;
    try { data = await response.json(); } catch(e) { data = {}; }

    if (response.ok) {
      console.log('[Mailgun] OK — envoyé à:', to, '| sujet:', subject, '| id:', data.id);
    } else {
      console.log('[Mailgun] ERREUR', response.status, ':', JSON.stringify(data));
      console.log('[Mailgun] URL:', MAILGUN_BASE);
      console.log('[Mailgun] From:', MAILGUN_FROM);
      console.log('[Mailgun] To:', to);
    }
    return data;
  } catch (e) {
    console.log('[Mailgun] Exception:', e.message);
    return null;
  }
}

// ── Template de base HTML ZUKAGO ─────────────────────────────────────────────
function baseTemplate(content) {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F7F8FC; }
    .wrapper { max-width: 600px; margin: 0 auto; padding: 24px 16px; }
    .card { background: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #0D1E3B, #162E5A); padding: 32px 24px; text-align: center; }
    .logo { color: #FFFFFF; font-size: 28px; font-weight: 900; letter-spacing: 2px; margin: 0; }
    .tagline { color: #B98637; font-size: 12px; letter-spacing: 3px; margin: 4px 0 0; text-transform: uppercase; }
    .body { padding: 32px 24px; }
    .title { font-size: 22px; font-weight: 800; color: #0D1E3B; margin: 0 0 12px; }
    .text { font-size: 15px; color: #4A5568; line-height: 1.6; margin: 0 0 16px; }
    .btn { display: inline-block; background: linear-gradient(135deg, #162E5A, #1E3F7A); color: #FFFFFF; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: 700; font-size: 15px; margin: 8px 0; }
    .btn-gold { background: linear-gradient(135deg, #B98637, #D4A855); }
    .divider { border: none; border-top: 1px solid #E2E8F0; margin: 24px 0; }
    .info-box { background: #EBF0F8; border-radius: 10px; padding: 16px; margin: 16px 0; }
    .info-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #D1DCF0; }
    .info-label { color: #4A5568; font-size: 13px; }
    .info-value { color: #0D1E3B; font-size: 13px; font-weight: 700; }
    .footer { padding: 20px 24px; text-align: center; background: #F7F8FC; }
    .footer-text { font-size: 12px; color: #9AA5B4; line-height: 1.6; }
    .footer-link { color: #B98637; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        <p class="logo">ZUKAGO</p>
        <p class="tagline">Emerge &amp; Move</p>
      </div>
      <div class="body">
        ${content}
      </div>
    </div>
    <div class="footer">
      <p class="footer-text">
        ZUKAGO · Akwa, Rue Castelnau, Douala, Cameroun<br>
        <a href="${APP_URL}" class="footer-link">zukago.com</a> · 
        <a href="mailto:contact@zukago.com" class="footer-link">contact@zukago.com</a><br>
        <a href="${APP_URL}/politique-de-confidentialite" class="footer-link">Politique de confidentialité</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── EMAILS ───────────────────────────────────────────────────────────────────

/**
 * Email de bienvenue après inscription
 */
async function sendWelcome(user) {
  const html = baseTemplate(`
    <p class="title">Bienvenue sur ZUKAGO, ${user.name} !</p>
    <p class="text">Votre compte a été créé avec succès. Vous pouvez dès maintenant explorer nos annonces et réserver votre prochaine location.</p>
    <p class="text">ZUKAGO vous offre les meilleures locations en Afrique — appartements, hôtels, voitures et chauffeurs.</p>
    <a href="${APP_URL}" class="btn btn-gold">Explorer les annonces</a>
    <hr class="divider">
    <p class="text" style="font-size:13px;color:#9AA5B4;">Si vous n'avez pas créé ce compte, ignorez cet email.</p>
  `);

  return sendEmail({
    to:      user.email,
    subject: 'Bienvenue sur ZUKAGO — Emerge & Move',
    html,
    text:    `Bienvenue sur ZUKAGO, ${user.name} ! Votre compte a été créé avec succès. Explorez nos annonces sur ${APP_URL}`,
  });
}

/**
 * Email de vérification d'adresse email
 */
async function sendVerification(user, token) {
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;
  // Aussi disponible via l'API backend
  const apiUrl = `https://zukago-backend-production.up.railway.app/api/auth/verify-email?token=${token}`;

  const html = baseTemplate(`
    <p class="title">Vérifiez votre adresse email</p>
    <p class="text">Bonjour ${user.name},</p>
    <p class="text">Merci de vous être inscrit sur ZUKAGO. Cliquez sur le bouton ci-dessous pour vérifier votre adresse email et activer votre compte.</p>
    <a href="${apiUrl}" class="btn">Vérifier mon email</a>
    <hr class="divider">
    <p class="text" style="font-size:13px;color:#9AA5B4;">Ce lien expire dans 24 heures. Si vous n'avez pas créé ce compte, ignorez cet email.</p>
    <p class="text" style="font-size:12px;color:#9AA5B4;">Si le bouton ne fonctionne pas, copiez ce lien : <br>${apiUrl}</p>
  `);

  return sendEmail({
    to:      user.email,
    subject: 'ZUKAGO — Vérifiez votre adresse email',
    html,
    text:    `Vérifiez votre email ZUKAGO : ${apiUrl}`,
  });
}

/**
 * Email de confirmation de réservation (client)
 */
async function sendBookingConfirmation(user, booking, listing) {
  const html = baseTemplate(`
    <p class="title">Réservation confirmée !</p>
    <p class="text">Bonjour ${user.name}, votre réservation a bien été enregistrée.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Référence</span><span class="info-value">${booking.code}</span></div>
      <div class="info-row"><span class="info-label">Bien</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Arrivée</span><span class="info-value">${booking.start_date}</span></div>
      <div class="info-row"><span class="info-label">Départ</span><span class="info-value">${booking.end_date}</span></div>
      <div class="info-row"><span class="info-label">Nuits</span><span class="info-value">${booking.nights}</span></div>
      <div class="info-row" style="border:none"><span class="info-label">Total</span><span class="info-value">${Number(booking.total).toLocaleString()} FCFA</span></div>
    </div>
    <p class="text">Le propriétaire va confirmer votre réservation sous 24h. Vous recevrez une notification dès confirmation.</p>
    <a href="${APP_URL}" class="btn btn-gold">Voir ma réservation</a>
  `);

  return sendEmail({
    to:      user.email,
    subject: `ZUKAGO — Réservation ${booking.code} enregistrée`,
    html,
    text:    `Réservation ${booking.code} pour ${listing.title} du ${booking.start_date} au ${booking.end_date}. Total : ${booking.total} FCFA`,
  });
}

/**
 * Email de notification au partenaire — nouvelle réservation
 */
async function sendNewBookingToPartner(partner, booking, listing, client) {
  const html = baseTemplate(`
    <p class="title">Nouvelle réservation !</p>
    <p class="text">Bonjour ${partner.name}, vous avez reçu une nouvelle demande de réservation.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Référence</span><span class="info-value">${booking.code}</span></div>
      <div class="info-row"><span class="info-label">Client</span><span class="info-value">${client.name}</span></div>
      <div class="info-row"><span class="info-label">Bien</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">Arrivée</span><span class="info-value">${booking.start_date}</span></div>
      <div class="info-row"><span class="info-label">Départ</span><span class="info-value">${booking.end_date}</span></div>
      <div class="info-row" style="border:none"><span class="info-label">Vos gains</span><span class="info-value">${Number(booking.partner_gets || 0).toLocaleString()} FCFA</span></div>
    </div>
    <p class="text">Connectez-vous à votre dashboard pour confirmer ou refuser cette réservation.</p>
    <a href="${APP_URL}" class="btn">Voir le dashboard</a>
  `);

  return sendEmail({
    to:      partner.email,
    subject: `ZUKAGO — Nouvelle réservation pour ${listing.title}`,
    html,
    text:    `Nouvelle réservation ${booking.code} de ${client.name} pour ${listing.title}`,
  });
}

/**
 * Email d'approbation partenaire
 */
async function sendPartnerApproved(user) {
  const html = baseTemplate(`
    <p class="title">Votre compte partenaire est approuvé !</p>
    <p class="text">Bonjour ${user.name}, félicitations !</p>
    <p class="text">Votre compte partenaire ZUKAGO a été vérifié et approuvé. Vous pouvez maintenant publier vos annonces et commencer à recevoir des réservations.</p>
    <a href="${APP_URL}" class="btn btn-gold">Publier ma première annonce</a>
  `);

  return sendEmail({
    to:      user.email,
    subject: 'ZUKAGO — Compte partenaire approuvé !',
    html,
    text:    `Félicitations ${user.name} ! Votre compte partenaire ZUKAGO est approuvé. Publiez votre première annonce sur ${APP_URL}`,
  });
}

/**
 * Email de rejet partenaire
 */
async function sendPartnerRejected(user, reason) {
  const html = baseTemplate(`
    <p class="title">Demande partenaire non approuvée</p>
    <p class="text">Bonjour ${user.name},</p>
    <p class="text">Votre demande partenaire n'a pas pu être approuvée pour le moment.</p>
    ${reason ? `<div class="info-box"><p class="text" style="margin:0"><strong>Raison :</strong> ${reason}</p></div>` : ''}
    <p class="text">Vous pouvez contacter notre support pour plus d'informations ou soumettre une nouvelle demande.</p>
    <a href="mailto:contact@zukago.com" class="btn">Contacter le support</a>
  `);

  return sendEmail({
    to:      user.email,
    subject: 'ZUKAGO — Demande partenaire',
    html,
    text:    `Votre demande partenaire ZUKAGO n'a pas été approuvée. ${reason ? 'Raison : ' + reason : ''} Contactez contact@zukago.com`,
  });
}

/**
 * Test de connexion Mailgun — appeler depuis Railway console
 * node -e "require('./src/services/emailService').testConnection()"
 */
async function testConnection() {
  console.log('Testing Mailgun...');
  console.log('API Key:', MAILGUN_API_KEY ? MAILGUN_API_KEY.substring(0, 8) + '...' : 'MISSING');
  console.log('Domain:', MAILGUN_DOMAIN);
  console.log('URL:', MAILGUN_BASE);
  
  const result = await sendEmail({
    to:      'thomymonkam@yahoo.fr',
    subject: 'ZUKAGO — Test Mailgun',
    html:    '<p>Test email depuis Railway</p>',
    text:    'Test email depuis Railway',
  });
  console.log('Result:', JSON.stringify(result));
  return result;
}

module.exports = {
  sendWelcome,
  sendVerification,
  sendBookingConfirmation,
  sendNewBookingToPartner,
  sendPartnerApproved,
  sendPartnerRejected,
  testConnection,
};
