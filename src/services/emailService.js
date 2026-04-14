const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.EMAIL_HOST,
  port:   Number(process.env.EMAIL_PORT),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ── Template HTML de base
const baseTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; background: #f7f8fc; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #162E5A, #1E3F7A); padding: 32px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 24px; letter-spacing: 2px; }
    .header p { color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 14px; }
    .body { padding: 32px; }
    .btn { display: inline-block; background: linear-gradient(135deg, #B98637, #D4A855); color: #fff;
           padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: bold; margin-top: 20px; }
    .info-box { background: #EBF0F8; border-radius: 10px; padding: 16px; margin: 16px 0; }
    .info-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #ddd; }
    .label { color: #666; }
    .value { font-weight: bold; color: #162E5A; }
    .footer { background: #f0f3f9; padding: 20px; text-align: center; color: #999; font-size: 12px; }
    .code { font-size: 24px; font-weight: 900; color: #B98637; letter-spacing: 4px; text-align: center;
            background: #FBF5E8; border: 2px solid #B98637; border-radius: 10px; padding: 16px; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>ZUKAGO</h1>
      <p>Emerge. Move.</p>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      <p>© 2026 ZUKAGO — contact@zukago.com</p>
      <p>Douala, Cameroun 🇨🇲</p>
    </div>
  </div>
</body>
</html>`;

const send = async (to, subject, html) => {
  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error(`Email error to ${to}:`, err.message);
    // Ne pas bloquer l'app si email échoue
  }
};

const emailService = {

  // ── Bienvenue nouvel utilisateur
  sendWelcome: (user) => send(
    user.email,
    'Bienvenue sur ZUKAGO 🎉',
    baseTemplate(`
      <h2>Bienvenue ${user.name} !</h2>
      <p>Votre compte ZUKAGO a été créé avec succès. Vous pouvez maintenant :</p>
      <ul>
        <li>🏠 Chercher des appartements, hôtels, voitures</li>
        <li>📅 Réserver en ligne et payer par Mobile Money</li>
        <li>💼 Devenir partenaire et louer votre bien</li>
      </ul>
      <a href="${process.env.FRONTEND_URL}" class="btn">Explorer ZUKAGO →</a>
    `)
  ),

  // ── Confirmation de réservation (client)
  sendBookingConfirmation: (user, booking, listing) => send(
    user.email,
    `Réservation confirmée — ${booking.code} 🎉`,
    baseTemplate(`
      <h2>Réservation confirmée !</h2>
      <p>Bonjour ${user.name}, votre réservation a bien été enregistrée.</p>
      <div class="code">${booking.code}</div>
      <div class="info-box">
        <div class="info-row"><span class="label">Logement</span><span class="value">${listing.title}</span></div>
        <div class="info-row"><span class="label">Lieu</span><span class="value">${listing.city_code}</span></div>
        <div class="info-row"><span class="label">Arrivée</span><span class="value">${booking.start_date}</span></div>
        <div class="info-row"><span class="label">Départ</span><span class="value">${booking.end_date}</span></div>
        <div class="info-row"><span class="label">Durée</span><span class="value">${booking.nights} nuit(s)</span></div>
        <div class="info-row"><span class="label">Total payé</span><span class="value">${Number(booking.total).toLocaleString()} FCFA</span></div>
      </div>
      <p>Conservez votre code de réservation. L'hôte vous contactera sous peu.</p>
    `)
  ),

  // ── Nouvelle réservation (partenaire)
  sendNewBookingToPartner: (partner, booking, listing, client) => send(
    partner.email,
    `Nouvelle réservation — ${booking.code} 📋`,
    baseTemplate(`
      <h2>Nouvelle réservation !</h2>
      <p>Bonjour ${partner.name}, vous avez une nouvelle réservation.</p>
      <div class="info-box">
        <div class="info-row"><span class="label">Client</span><span class="value">${client.name}</span></div>
        <div class="info-row"><span class="label">Annonce</span><span class="value">${listing.title}</span></div>
        <div class="info-row"><span class="label">Arrivée</span><span class="value">${booking.start_date}</span></div>
        <div class="info-row"><span class="label">Départ</span><span class="value">${booking.end_date}</span></div>
        <div class="info-row"><span class="label">Vous recevez</span><span class="value">${Number(booking.partner_gets).toLocaleString()} FCFA</span></div>
      </div>
    `)
  ),

  // ── Partenaire approuvé
  sendPartnerApproved: (user) => send(
    user.email,
    'Votre compte partenaire a été approuvé ✅',
    baseTemplate(`
      <h2>Félicitations ${user.name} !</h2>
      <p>Votre compte partenaire ZUKAGO a été approuvé. Vous pouvez maintenant :</p>
      <ul>
        <li>🏠 Publier vos annonces</li>
        <li>📅 Gérer votre calendrier</li>
        <li>💰 Recevoir des paiements</li>
      </ul>
      <a href="${process.env.FRONTEND_URL}" class="btn">Publier ma première annonce →</a>
    `)
  ),

  // ── Partenaire rejeté
  sendPartnerRejected: (user, message) => send(
    user.email,
    'Mise à jour de votre demande partenaire',
    baseTemplate(`
      <h2>Bonjour ${user.name}</h2>
      <p>Après examen de votre dossier, nous ne pouvons pas valider votre compte partenaire pour le moment.</p>
      ${message ? `<div class="info-box"><p><strong>Raison :</strong> ${message}</p></div>` : ''}
      <p>Vous pouvez corriger votre dossier et soumettre à nouveau.</p>
      <a href="${process.env.FRONTEND_URL}" class="btn">Mettre à jour mon dossier</a>
    `)
  ),

  // ── Annonce approuvée
  sendListingApproved: (user, listing) => send(
    user.email,
    `Votre annonce "${listing.title}" est publiée ✅`,
    baseTemplate(`
      <h2>Votre annonce est en ligne !</h2>
      <p>Bonjour ${user.name}, votre annonce <strong>${listing.title}</strong> est maintenant visible sur ZUKAGO.</p>
      <p>Les clients peuvent déjà la voir et faire des réservations.</p>
      <a href="${process.env.FRONTEND_URL}" class="btn">Voir mon annonce →</a>
    `)
  ),

  // ── Annonce rejetée
  sendListingRejected: (user, listing, message) => send(
    user.email,
    `Votre annonce "${listing.title}" nécessite des modifications`,
    baseTemplate(`
      <h2>Bonjour ${user.name}</h2>
      <p>Votre annonce <strong>${listing.title}</strong> n'a pas pu être publiée.</p>
      ${message ? `<div class="info-box"><p><strong>Raison :</strong> ${message}</p></div>` : ''}
      <p>Modifiez votre annonce selon les indications et resoumettez-la.</p>
      <a href="${process.env.FRONTEND_URL}" class="btn">Modifier mon annonce</a>
    `)
  ),

  // ── Retrait approuvé
  sendWithdrawalApproved: (user, withdrawal) => send(
    user.email,
    'Votre retrait a été effectué 💰',
    baseTemplate(`
      <h2>Virement effectué !</h2>
      <p>Bonjour ${user.name}, votre demande de retrait a été traitée.</p>
      <div class="info-box">
        <div class="info-row"><span class="label">Montant</span><span class="value">${Number(withdrawal.amount).toLocaleString()} FCFA</span></div>
        <div class="info-row"><span class="label">Méthode</span><span class="value">${withdrawal.method}</span></div>
        <div class="info-row"><span class="label">Compte</span><span class="value">${withdrawal.account}</span></div>
      </div>
      <p>Le montant sera crédité sous 24-48h selon votre opérateur.</p>
    `)
  ),

  // ── Retrait refusé
  sendWithdrawalRejected: (user, message) => send(
    user.email,
    'Votre demande de retrait',
    baseTemplate(`
      <h2>Bonjour ${user.name}</h2>
      <p>Votre demande de retrait n'a pas pu être traitée.</p>
      ${message ? `<div class="info-box"><p><strong>Raison :</strong> ${message}</p></div>` : ''}
      <p>Contactez-nous à contact@zukago.com pour plus d'informations.</p>
    `)
  ),
};

module.exports = emailService;
