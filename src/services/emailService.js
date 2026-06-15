/**
 * ZUKAGO — services/emailService.js
 * Service email via Mailgun API
 * Domaine : mg.zukago.com
 * From    : ZUKAGO <noreply@mg.zukago.com>
 *
 * V14.5.3 i18n : Tous les emails sont traduits FR/EN/DE
 * via le service i18nService (table translations en DB).
 * La langue est résolue depuis users.preferred_lang (avec fallbacks).
 */

const i18n = require('./i18nService');

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN  = process.env.MAILGUN_DOMAIN  || 'mg.zukago.com';
const MAILGUN_FROM    = process.env.MAILGUN_FROM     || 'ZUKAGO <noreply@mg.zukago.com>';
const APP_URL         = process.env.APP_URL          || 'https://zukago.com';

// EU region — api.eu.mailgun.net
const MAILGUN_BASE = `https://api.eu.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`;
// Note: EU region utilise api.eu.mailgun.net (pas api.mailgun.net)

// ════════════════════════════════════════════════════════════════════════════
// ✅ V14.8 — CONFIG MARQUE (à remplir UNE fois)
// ════════════════════════════════════════════════════════════════════════════
// 1) LOGO : héberge ton logo (colored-logo.png) sur Cloudinary, colle l'URL ici
//    (les emails ont besoin d'une URL publique — le base64 est bloqué par Gmail).
const LOGO_URL = process.env.EMAIL_LOGO_URL
  || 'https://res.cloudinary.com/dm3fo2ji5/image/upload/v1781529723/colored-logo_yqkru5.png';

// 2) RÉSEAUX SOCIAUX (les pages existent — cible diaspora) : remplace par tes vraies URLs
//    url  = la page (au clic) · icon = l'image de l'icône hébergée (Cloudinary). Si icon vide → lien texte.
const SOCIAL = {
  facebook:  { url: process.env.SOCIAL_FACEBOOK  || 'https://www.facebook.com/share/1B6wAfjLSw/', icon: process.env.SOCIAL_ICON_FACEBOOK  || '' },
  instagram: { url: process.env.SOCIAL_INSTAGRAM || 'https://www.instagram.com/zukago.official',  icon: process.env.SOCIAL_ICON_INSTAGRAM || '' },
  tiktok:    { url: process.env.SOCIAL_TIKTOK    || 'https://www.tiktok.com/@zukago2',            icon: process.env.SOCIAL_ICON_TIKTOK    || '' },
  linkedin:  { url: process.env.SOCIAL_LINKEDIN  || 'https://www.linkedin.com/company/zukago/',   icon: process.env.SOCIAL_ICON_LINKEDIN  || '' },
};

// Police titre (Playfair si dispo chez le client mail, sinon serif système)
const FONT_SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const FONT_SANS  = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Envoyer un email via Mailgun API REST
 */
async function sendEmail({ to, subject, html, text }) {
  if (!MAILGUN_API_KEY) {
    console.log('[emailService] MAILGUN_API_KEY manquant — email non envoyé:', subject);
    return;
  }

  const body = new URLSearchParams({
    from:    MAILGUN_FROM,
    to,
    subject,
    html:    html || '',
    text:    text || '',
  });

  try {
    const response = await fetch(MAILGUN_BASE, {
      method:  'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data = await response.json();
    if (!response.ok) {
      console.log('[emailService] Mailgun error:', response.status, JSON.stringify(data));
      console.log('[emailService] URL:', MAILGUN_BASE);
      console.log('[emailService] Domain:', MAILGUN_DOMAIN);
    } else {
      console.log('[emailService] Email envoye a', to, ':', subject, '| ID:', data.id);
    }
    return data;
  } catch (e) {
    console.log('[emailService] Fetch error:', e.message);
  }
}

// ── Template de base HTML ZUKAGO ─────────────────────────────────────────────
async function baseTemplate(content, lang = 'fr', preheader = '') {
  const tagline      = await i18n.t('email_tagline',      lang, 'Émerge et Bouge');
  const privacyText  = await i18n.t('email_privacy',      lang, 'Politique de confidentialité');
  const unsubText    = await i18n.t('email_unsubscribe',  lang, 'Se désabonner');

  // ✅ Rangée réseaux : icônes images si fournies, sinon repli en liens texte
  const socialItems = [
    { name: 'Facebook',  ...SOCIAL.facebook },
    { name: 'Instagram', ...SOCIAL.instagram },
    { name: 'TikTok',    ...SOCIAL.tiktok },
    { name: 'LinkedIn',  ...SOCIAL.linkedin },
  ];
  const useIcons = socialItems.every(s => s.icon);
  const socialRow = socialItems.map(s => useIcons
    ? `<a href="${s.url}" target="_blank" style="text-decoration:none;display:inline-block;margin:0 6px;"><img src="${s.icon}" alt="${s.name}" width="28" height="28" style="width:28px;height:28px;border:0;display:inline-block;"></a>`
    : `<a href="${s.url}" target="_blank" style="color:#162E5A;text-decoration:none;">${s.name}</a>`
  ).join(useIcons ? '' : ' &nbsp;&middot;&nbsp; ');

  return `
<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    body { margin:0; padding:0; background:#F7F8FC; }
    table { border-collapse:collapse; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    /* Classes de contenu (compat avec les autres emails) */
    .title { font-size:22px; font-weight:800; color:#162E5A; margin:0 0 12px; font-family:${FONT_SERIF}; }
    .text { font-size:15px; color:#4A5568; line-height:1.6; margin:0 0 16px; font-family:${FONT_SANS}; }
    .btn { display:inline-block; background:#162E5A; color:#FFFFFF !important; text-decoration:none; padding:14px 28px; border-radius:10px; font-weight:700; font-size:15px; margin:8px 0; font-family:${FONT_SANS}; }
    .btn-gold { background:#D4A641; color:#162E5A !important; }
    .divider { border:none; border-top:1px solid #E2E8F0; margin:24px 0; }
    .info-box { background:#FBF7EF; border-radius:10px; padding:16px; margin:16px 0; }
    .info-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #ECE2CF; }
    .info-label { color:#4A5568; font-size:13px; }
    .info-value { color:#162E5A; font-size:13px; font-weight:700; }
  </style>
</head>
<body style="margin:0;padding:0;background:#F7F8FC;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7F8FC" style="background:#F7F8FC;">
    <tr><td align="center" style="padding:24px 12px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden;">
        <!-- HEADER -->
        <tr><td bgcolor="#162E5A" style="background:#162E5A;padding:30px 24px;text-align:center;">
          <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="#FFFFFF" style="background:#FFFFFF;border-radius:14px;padding:14px 22px;">
              <img src="${LOGO_URL}" alt="ZUKAGO" width="120" style="display:block;width:120px;height:auto;">
            </td>
          </tr></table>
          <div style="color:#D4A641;font-size:12px;letter-spacing:3px;text-transform:uppercase;margin-top:14px;font-family:${FONT_SANS};">${tagline}</div>
        </td></tr>
        <!-- FILET OR -->
        <tr><td bgcolor="#D4A641" style="background:#D4A641;font-size:0;line-height:0;height:3px;">&nbsp;</td></tr>
        <!-- CORPS -->
        <tr><td style="padding:32px 28px;font-family:${FONT_SANS};">
          ${content}
        </td></tr>
      </table>

      <!-- FOOTER -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr><td style="padding:22px 24px;text-align:center;font-family:${FONT_SANS};">
          <div style="font-weight:800;color:#162E5A;font-size:15px;letter-spacing:1px;">ZUKAGO.</div>
          <div style="font-size:12px;color:#9AA5B4;line-height:1.7;margin-top:6px;">
            Akwa, Rue Castelnau, Douala, Cameroun<br>
            <a href="${APP_URL}" style="color:#D4A641;text-decoration:none;">zukago.com</a> &nbsp;&middot;&nbsp;
            <a href="mailto:contact@zukago.com" style="color:#D4A641;text-decoration:none;">contact@zukago.com</a>
          </div>
          <div style="margin-top:12px;font-size:12px;font-weight:600;">
            ${socialRow}
          </div>
          <div style="margin-top:12px;font-size:11px;color:#B8C0CC;">
            <a href="${APP_URL}/politique-de-confidentialite" style="color:#9AA5B4;text-decoration:underline;">${privacyText}</a> &nbsp;&middot;&nbsp;
            <a href="${APP_URL}/unsubscribe" style="color:#9AA5B4;text-decoration:underline;">${unsubText}</a>
          </div>
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

// ── EMAILS ───────────────────────────────────────────────────────────────────

/**
 * V14.5.3 i18n : Résout la langue d'un user ou utilise la langue passée en paramètre.
 * @param {object} user - User object (peut avoir userId/id pour lookup DB)
 * @param {string} explicitLang - Langue passée explicitement (priorité max)
 */
async function _resolveLang(user, explicitLang) {
  if (explicitLang && ['fr', 'en', 'de'].includes(explicitLang)) return explicitLang;
  if (user?.preferred_lang && ['fr', 'en', 'de'].includes(user.preferred_lang)) return user.preferred_lang;
  const userId = user?.id || user?.userId || user?.user_id;
  if (userId) {
    try {
      return await i18n.getUserLang(userId);
    } catch (e) {
      console.log('[emailService] _resolveLang error:', e.message);
    }
  }
  return 'fr';
}

/**
 * Email de bienvenue après inscription
 */
async function sendWelcome(user, lang) {
  const L = await _resolveLang(user, lang);

  const title       = await i18n.t('email_welcome_title',      L, 'Bienvenue sur ZUKAGO, {name} !', { name: user.name });
  const text1       = await i18n.t('email_welcome_text1',      L, 'Votre compte a été créé avec succès. Vous pouvez dès maintenant explorer nos annonces et réserver votre prochaine location.');
  const text2       = await i18n.t('email_welcome_text2',      L, 'ZUKAGO vous offre les meilleures locations en Afrique — appartements, hôtels, voitures et chauffeurs.');
  const btnExplore  = await i18n.t('email_welcome_btn',        L, 'Explorer les annonces');
  const ignoreText  = await i18n.t('email_welcome_ignore',     L, 'Si vous n\'avez pas créé ce compte, ignorez cet email.');
  const subject     = await i18n.t('email_welcome_subject',    L, 'Bienvenue sur ZUKAGO — Emerge & Move');
  const textPlain   = await i18n.t('email_welcome_text_plain', L, 'Bienvenue sur ZUKAGO, {name} ! Votre compte a été créé avec succès. Explorez nos annonces sur {url}', { name: user.name, url: APP_URL });

  const eyebrow     = await i18n.t('email_welcome_eyebrow', L, 'Compte créé');
  const svcApt      = await i18n.t('email_service_apt',     L, 'Appartements');
  const svcHotel    = await i18n.t('email_service_hotel',   L, 'Hôtels');
  const svcCar      = await i18n.t('email_service_car',     L, 'Voitures');
  const svcDriver   = await i18n.t('email_service_driver',  L, 'Chauffeurs');

  const serviceCards = [svcApt, svcHotel, svcCar, svcDriver].map(s => `
      <td width="25%" valign="top" style="padding:4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td bgcolor="#FBF7EF" style="background:#FBF7EF;border:1px solid #ECE2CF;border-radius:10px;padding:16px 6px;text-align:center;">
            <div style="color:#162E5A;font-size:12px;font-weight:700;font-family:${FONT_SANS};">${s}</div>
          </td>
        </tr></table>
      </td>`).join('');

  const html = await baseTemplate(`
    <div style="color:#D4A641;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;font-family:${FONT_SANS};">${eyebrow}</div>
    <h1 style="font-family:${FONT_SERIF};font-size:24px;font-weight:800;color:#162E5A;margin:0 0 14px;line-height:1.25;">${title}</h1>
    <p style="font-size:15px;color:#4A5568;line-height:1.6;margin:0 0 14px;font-family:${FONT_SANS};">${text1}</p>
    <p style="font-size:15px;color:#4A5568;line-height:1.6;margin:0 0 18px;font-family:${FONT_SANS};">${text2}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr>${serviceCards}</tr></table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;"><tr>
      <td bgcolor="#D4A641" style="background:#D4A641;border-radius:10px;">
        <a href="${APP_URL}" style="display:inline-block;padding:14px 30px;color:#162E5A;font-weight:800;font-size:15px;text-decoration:none;font-family:${FONT_SANS};">${btnExplore} &rarr;</a>
      </td>
    </tr></table>
    <hr class="divider">
    <p style="font-size:13px;color:#9AA5B4;line-height:1.6;font-family:${FONT_SANS};">${ignoreText}</p>
  `, L, title);

  return sendEmail({
    to:      user.email,
    subject,
    html,
    text:    textPlain,
  });
}

/**
 * Email de vérification d'adresse email
 */
async function sendVerification(user, token, lang) {
  const L = await _resolveLang(user, lang);
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;
  // Aussi disponible via l'API backend
  const apiUrl = `https://zukago-backend-production.up.railway.app/api/auth/verify-email?token=${token}`;

  const title    = await i18n.t('email_verify_title',     L, 'Vérifiez votre adresse email');
  const greeting = await i18n.t('email_greeting',         L, 'Bonjour {name},', { name: user.name });
  const text1    = await i18n.t('email_verify_text1',     L, 'Merci de vous être inscrit sur ZUKAGO. Cliquez sur le bouton ci-dessous pour vérifier votre adresse email et activer votre compte.');
  const btnVerify= await i18n.t('email_verify_btn',       L, 'Vérifier mon email');
  const expires  = await i18n.t('email_verify_expires',   L, 'Ce lien expire dans 24 heures. Si vous n\'avez pas créé ce compte, ignorez cet email.');
  const fallback = await i18n.t('email_verify_fallback',  L, 'Si le bouton ne fonctionne pas, copiez ce lien :');
  const subject  = await i18n.t('email_verify_subject',   L, 'ZUKAGO — Vérifiez votre adresse email');
  const textPlain= await i18n.t('email_verify_text_plain',L, 'Vérifiez votre email ZUKAGO : {url}', { url: apiUrl });

  const html = await baseTemplate(`
    <p class="title">${title}</p>
    <p class="text">${greeting}</p>
    <p class="text">${text1}</p>
    <a href="${apiUrl}" class="btn">${btnVerify}</a>
    <hr class="divider">
    <p class="text" style="font-size:13px;color:#9AA5B4;">${expires}</p>
    <p class="text" style="font-size:12px;color:#9AA5B4;">${fallback} <br>${apiUrl}</p>
  `, L);

  return sendEmail({
    to:      user.email,
    subject,
    html,
    text:    textPlain,
  });
}

/**
 * Email de confirmation de réservation (client)
 */
async function sendBookingConfirmation(user, booking, listing, lang) {
  const L = await _resolveLang(user, lang);

  const title       = await i18n.t('email_booking_title',         L, 'Réservation confirmée !');
  const greeting    = await i18n.t('email_booking_greeting',      L, 'Bonjour {name}, votre réservation a bien été enregistrée.', { name: user.name });
  const lblRef      = await i18n.t('email_booking_lbl_ref',       L, 'Référence');
  const lblItem     = await i18n.t('email_booking_lbl_item',      L, 'Bien');
  const lblArrival  = await i18n.t('email_booking_lbl_arrival',   L, 'Arrivée');
  const lblDeparture= await i18n.t('email_booking_lbl_departure', L, 'Départ');
  const lblNights   = await i18n.t('email_booking_lbl_nights',    L, 'Nuits');
  const lblTotal    = await i18n.t('email_booking_lbl_total',     L, 'Total');
  const text2       = await i18n.t('email_booking_text2',         L, 'Le propriétaire va confirmer votre réservation sous 24h. Vous recevrez une notification dès confirmation.');
  const btnSee      = await i18n.t('email_booking_btn',           L, 'Voir ma réservation');
  const subject     = await i18n.t('email_booking_subject',       L, 'ZUKAGO — Réservation {code} enregistrée', { code: booking.code });
  const textPlain   = await i18n.t('email_booking_text_plain',    L, 'Réservation {code} pour {title} du {start} au {end}. Total : {total} FCFA', {
    code: booking.code, title: listing.title, start: booking.start_date, end: booking.end_date, total: booking.total,
  });

  const html = await baseTemplate(`
    <p class="title">${title}</p>
    <p class="text">${greeting}</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">${lblRef}</span><span class="info-value">${booking.code}</span></div>
      <div class="info-row"><span class="info-label">${lblItem}</span><span class="info-value">${listing.title}</span></div>
      <div class="info-row"><span class="info-label">${lblArrival}</span><span class="info-value">${booking.start_date}</span></div>
      <div class="info-row"><span class="info-label">${lblDeparture}</span><span class="info-value">${booking.end_date}</span></div>
      <div class="info-row"><span class="info-label">${lblNights}</span><span class="info-value">${booking.nights}</span></div>
      <div class="info-row" style="border:none"><span class="info-label">${lblTotal}</span><span class="info-value">${Number(booking.total).toLocaleString()} FCFA</span></div>
    </div>
    <p class="text">${text2}</p>
    <a href="${APP_URL}" class="btn btn-gold">${btnSee}</a>
  `, L);

  return sendEmail({
    to:      user.email,
    subject,
    html,
    text:    textPlain,
  });
}

/**
 * Email de notification au partenaire — nouvelle réservation
 */
async function sendNewBookingToPartner(partner, booking, listing, client, lang) {
  const L = await _resolveLang(partner, lang);

  const title      = await i18n.t('email_partner_booking_title',      L, 'Nouvelle réservation !');
  const greeting   = await i18n.t('email_partner_booking_greeting',   L, 'Bonjour {name}, vous avez reçu une nouvelle demande de réservation.', { name: partner.name });
  const lblRef     = await i18n.t('email_booking_lbl_ref',            L, 'Référence');
  const lblClient  = await i18n.t('email_partner_booking_lbl_client', L, 'Client');
  const lblItem    = await i18n.t('email_booking_lbl_item',           L, 'Bien');
  const lblArrival = await i18n.t('email_booking_lbl_arrival',        L, 'Arrivée');
  const lblDeparture= await i18n.t('email_booking_lbl_departure',     L, 'Départ');
  const lblGains   = await i18n.t('email_partner_booking_lbl_gains',  L, 'Vos gains');
  const text2      = await i18n.t('email_partner_booking_text2',      L, 'Connectez-vous à votre dashboard pour confirmer ou refuser cette réservation.');
  const btnDash    = await i18n.t('email_partner_booking_btn',        L, 'Voir le dashboard');
  const subject    = await i18n.t('email_partner_booking_subject',    L, 'ZUKAGO — Nouvelle réservation pour {title}', { title: listing.title });
  const textPlain  = await i18n.t('email_partner_booking_text_plain', L, 'Nouvelle réservation {code} de {client} pour {title}', {
    code: booking.code, client: client.name, title: listing.title,
  });

  const eyebrow     = await i18n.t('email_partner_booking_eyebrow',     L, 'Nouvelle réservation');
  const detailsLbl  = await i18n.t('email_booking_details',             L, 'Détails de la réservation');
  const gainsLbl    = await i18n.t('email_partner_booking_gains_label', L, 'Vos gains estimés');
  const ctaConfirm  = await i18n.t('email_partner_booking_cta_confirm', L, 'Confirmer ou refuser');
  const note24      = await i18n.t('email_partner_booking_note',        L, 'Connectez-vous à votre tableau de bord pour répondre à cette demande. Sans réponse sous 24 h, la réservation est automatiquement libérée.');

  const detailRow = (lbl, val, last) => `
        <tr>
          <td style="padding:9px 0;${last ? '' : 'border-bottom:1px solid #ECE2CF;'}color:#6B7280;font-size:13px;font-family:${FONT_SANS};">${lbl}</td>
          <td align="right" style="padding:9px 0;${last ? '' : 'border-bottom:1px solid #ECE2CF;'}color:#162E5A;font-size:13px;font-weight:700;font-family:${FONT_SANS};">${val}</td>
        </tr>`;

  const html = await baseTemplate(`
    <div style="color:#D4A641;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;font-family:${FONT_SANS};">${eyebrow}</div>
    <h1 style="font-family:${FONT_SERIF};font-size:24px;font-weight:800;color:#162E5A;margin:0 0 14px;line-height:1.25;">${title}</h1>
    <p style="font-size:15px;color:#4A5568;line-height:1.6;margin:0 0 18px;font-family:${FONT_SANS};">${greeting}</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FBF7EF" style="background:#FBF7EF;border:1px solid #ECE2CF;border-radius:14px;margin:0 0 22px;"><tr><td style="padding:20px 22px;">
      <div style="font-weight:700;color:#162E5A;font-size:15px;margin-bottom:8px;font-family:${FONT_SANS};">${detailsLbl}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${detailRow(lblRef, booking.code)}
        ${detailRow(lblClient, client.name)}
        ${detailRow(lblItem, listing.title)}
        ${detailRow(lblArrival, booking.start_date)}
        ${detailRow(lblDeparture, booking.end_date, true)}
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#162E5A" style="background:#162E5A;border-radius:10px;margin-top:16px;"><tr>
        <td style="padding:14px 18px;color:#C9D3E6;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-family:${FONT_SANS};">${gainsLbl}</td>
        <td align="right" style="padding:14px 18px;color:#D4A641;font-size:19px;font-weight:800;font-family:${FONT_SANS};">${Number(booking.partner_gets || 0).toLocaleString()} FCFA</td>
      </tr></table>
    </td></tr></table>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 16px;"><tr>
      <td bgcolor="#162E5A" style="background:#162E5A;border-radius:10px;">
        <a href="${APP_URL}" style="display:inline-block;padding:14px 30px;color:#FFFFFF;font-weight:800;font-size:15px;text-decoration:none;font-family:${FONT_SANS};">${ctaConfirm} &rarr;</a>
      </td>
    </tr></table>

    <p style="font-size:13px;color:#9AA5B4;line-height:1.6;text-align:center;font-family:${FONT_SANS};">${note24}</p>
  `, L, title);

  return sendEmail({
    to:      partner.email,
    subject,
    html,
    text:    textPlain,
  });
}

/**
 * Email d'approbation partenaire
 */
async function sendPartnerApproved(user, lang) {
  const L = await _resolveLang(user, lang);

  const title    = await i18n.t('email_partner_approved_title',    L, 'Votre compte partenaire est approuvé !');
  const greeting = await i18n.t('email_partner_approved_greeting', L, 'Bonjour {name}, félicitations !', { name: user.name });
  const text1    = await i18n.t('email_partner_approved_text',     L, 'Votre compte partenaire ZUKAGO a été vérifié et approuvé. Vous pouvez maintenant publier vos annonces et commencer à recevoir des réservations.');
  const btnPub   = await i18n.t('email_partner_approved_btn',      L, 'Publier ma première annonce');
  const subject  = await i18n.t('email_partner_approved_subject',  L, 'ZUKAGO — Compte partenaire approuvé !');
  const textPlain= await i18n.t('email_partner_approved_text_plain',L,'Félicitations {name} ! Votre compte partenaire ZUKAGO est approuvé. Publiez votre première annonce sur {url}', { name: user.name, url: APP_URL });

  const html = await baseTemplate(`
    <p class="title">${title}</p>
    <p class="text">${greeting}</p>
    <p class="text">${text1}</p>
    <a href="${APP_URL}" class="btn btn-gold">${btnPub}</a>
  `, L);

  return sendEmail({
    to:      user.email,
    subject,
    html,
    text:    textPlain,
  });
}

/**
 * Email de rejet partenaire
 */
async function sendPartnerRejected(user, reason, lang) {
  const L = await _resolveLang(user, lang);

  const title     = await i18n.t('email_partner_rejected_title',    L, 'Demande partenaire non approuvée');
  const greeting  = await i18n.t('email_greeting',                  L, 'Bonjour {name},', { name: user.name });
  const text1     = await i18n.t('email_partner_rejected_text1',    L, 'Votre demande partenaire n\'a pas pu être approuvée pour le moment.');
  const lblReason = await i18n.t('email_partner_rejected_reason',   L, 'Raison :');
  const text2     = await i18n.t('email_partner_rejected_text2',    L, 'Vous pouvez contacter notre support pour plus d\'informations ou soumettre une nouvelle demande.');
  const btnSupport= await i18n.t('email_partner_rejected_btn',      L, 'Contacter le support');
  const subject   = await i18n.t('email_partner_rejected_subject',  L, 'ZUKAGO — Demande partenaire');
  const textPlain = await i18n.t('email_partner_rejected_text_plain',L,'Votre demande partenaire ZUKAGO n\'a pas été approuvée. {reason}Contactez contact@zukago.com', { reason: reason ? `Raison : ${reason} ` : '' });

  const html = await baseTemplate(`
    <p class="title">${title}</p>
    <p class="text">${greeting}</p>
    <p class="text">${text1}</p>
    ${reason ? `<div class="info-box"><p class="text" style="margin:0"><strong>${lblReason}</strong> ${reason}</p></div>` : ''}
    <p class="text">${text2}</p>
    <a href="mailto:contact@zukago.com" class="btn">${btnSupport}</a>
  `, L);

  return sendEmail({
    to:      user.email,
    subject,
    html,
    text:    textPlain,
  });
}

/**
 * V14.0.1 — Email de réinitialisation de mot de passe (code 6 chiffres)
 */
async function sendPasswordReset(user, code, lang) {
  const L = await _resolveLang(user, lang);

  const title       = await i18n.t('email_pwd_reset_title',     L, 'Réinitialisation de votre mot de passe');
  const greeting    = await i18n.t('email_greeting',            L, 'Bonjour {name},', { name: user.name });
  const text1       = await i18n.t('email_pwd_reset_text1',     L, 'Vous avez demandé à réinitialiser votre mot de passe ZUKAGO. Voici votre code de vérification :');
  const codeLbl     = await i18n.t('email_pwd_reset_code_lbl',  L, 'Code de vérification');
  const validity    = await i18n.t('email_pwd_reset_validity',  L, 'Valable 30 minutes');
  const text2       = await i18n.t('email_pwd_reset_text2',     L, 'Saisissez ce code dans l\'application ZUKAGO pour choisir un nouveau mot de passe.');
  const notYouTitle = await i18n.t('email_pwd_reset_not_you',   L, 'Vous n\'êtes pas à l\'origine de cette demande ?');
  const notYouText  = await i18n.t('email_pwd_reset_not_you_text', L, 'Ignorez cet email, votre mot de passe restera inchangé. Aucune action n\'a été effectuée sur votre compte.');
  const security    = await i18n.t('email_pwd_reset_security',  L, 'Pour votre sécurité, ne communiquez jamais ce code à qui que ce soit. ZUKAGO ne vous le demandera jamais.');
  const subject     = await i18n.t('email_pwd_reset_subject',   L, 'ZUKAGO — Code de réinitialisation : {code}', { code });
  const textPlain   = await i18n.t('email_pwd_reset_text_plain',L, 'Bonjour {name}, votre code de réinitialisation ZUKAGO est : {code} (valable 30 minutes). Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet email.', { name: user.name, code });

  const html = await baseTemplate(`
    <p class="title">${title}</p>
    <p class="text">${greeting}</p>
    <p class="text">${text1}</p>

    <div style="background:#F7F8FC;border:2px solid #B98637;border-radius:14px;padding:24px;text-align:center;margin:24px 0;">
      <p style="margin:0 0 8px;font-size:12px;color:#9AA5B4;letter-spacing:2px;text-transform:uppercase;">${codeLbl}</p>
      <p style="margin:0;font-size:36px;font-weight:900;color:#0D1E3B;letter-spacing:12px;font-family:Menlo,Monaco,Consolas,monospace;">${code}</p>
      <p style="margin:12px 0 0;font-size:12px;color:#9AA5B4;">${validity}</p>
    </div>

    <p class="text">${text2}</p>

    <hr class="divider">
    <p class="text" style="font-size:13px;color:#9AA5B4;">
      <strong>${notYouTitle}</strong><br>
      ${notYouText}
    </p>
    <p class="text" style="font-size:12px;color:#9AA5B4;">
      ${security}
    </p>
  `, L);

  return sendEmail({
    to:      user.email,
    subject,
    html,
    text:    textPlain,
  });
}

/**
 * V14.0.1 — Email de confirmation après changement de mot de passe (sécurité)
 */
async function sendPasswordResetConfirmation(user, lang) {
  const L = await _resolveLang(user, lang);

  const title       = await i18n.t('email_pwd_changed_title',     L, 'Mot de passe modifié');
  const greeting    = await i18n.t('email_greeting',              L, 'Bonjour {name},', { name: user.name });
  const text1       = await i18n.t('email_pwd_changed_text1',     L, 'Votre mot de passe ZUKAGO a été modifié avec succès.');
  const text2       = await i18n.t('email_pwd_changed_text2',     L, 'Pour votre sécurité, vous avez été déconnecté de tous vos appareils. Reconnectez-vous avec votre nouveau mot de passe.');
  const warningT    = await i18n.t('email_pwd_changed_warning',   L, '⚠️ Vous n\'êtes pas à l\'origine de ce changement ?');
  const warningD    = await i18n.t('email_pwd_changed_warning_desc',L,'Contactez immédiatement notre support à {email} pour sécuriser votre compte.', { email: '<a href="mailto:contact@zukago.com" style="color:#B91C1C;font-weight:700;">contact@zukago.com</a>' });
  const subject     = await i18n.t('email_pwd_changed_subject',   L, 'ZUKAGO — Votre mot de passe a été modifié');
  const textPlain   = await i18n.t('email_pwd_changed_text_plain',L, 'Bonjour {name}, votre mot de passe ZUKAGO a été modifié avec succès. Si vous n\'êtes pas à l\'origine de ce changement, contactez immédiatement contact@zukago.com.', { name: user.name });

  const html = await baseTemplate(`
    <p class="title">${title}</p>
    <p class="text">${greeting}</p>
    <p class="text">${text1}</p>
    <p class="text">${text2}</p>

    <hr class="divider">
    <div style="background:#FEE2E2;border-radius:10px;padding:16px;margin:16px 0;">
      <p class="text" style="margin:0;color:#B91C1C;font-weight:700;">${warningT}</p>
      <p class="text" style="margin:8px 0 0;font-size:13px;color:#7F1D1D;">
        ${warningD}
      </p>
    </div>
  `, L);

  return sendEmail({
    to:      user.email,
    subject,
    html,
    text:    textPlain,
  });
}

module.exports = {
  sendWelcome,
  sendVerification,
  sendBookingConfirmation,
  sendNewBookingToPartner,
  sendPartnerApproved,
  sendPartnerRejected,
  sendPasswordReset,
  sendPasswordResetConfirmation,
};
