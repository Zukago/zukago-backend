-- ══════════════════════════════════════════════════════════════════════════════
-- ZUKAGO — Schéma Supabase (PostgreSQL)
-- §3.7 : Zéro valeur hardcodée — tout en base de données
-- ══════════════════════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── 1. CONFIGURATION GLOBALE DE L'APP ───────────────────────────────────────
-- Tout ce qui est configurable depuis le Dashboard Admin
CREATE TABLE app_config (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,  -- ex: 'slogan', 'commission_rate'
  value       TEXT NOT NULL,
  type        TEXT DEFAULT 'string', -- 'string', 'number', 'boolean', 'json'
  label       TEXT,                  -- label lisible pour l'admin
  category    TEXT DEFAULT 'general',-- 'general', 'payments', 'notifications'
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);

-- Données initiales configuration
INSERT INTO app_config (key, value, type, label, category) VALUES
  ('slogan',             'Emerge. Move.',                    'string',  'Slogan principal',         'general'),
  ('slogan_sub',         'Location & mobilité au Cameroun',  'string',  'Sous-slogan',              'general'),
  ('commission_rate',    '17',                               'number',  'Commission ZUKAGO (%)',     'payments'),
  ('min_price',          '5000',                             'number',  'Prix minimum (FCFA)',       'general'),
  ('booking_steps',      '["Dates","Recapitulatif","Paiement","Confirmation"]', 'json', 'Etapes reservation', 'general'),
  ('primary_color',      '#162E5A',                          'string',  'Couleur principale',        'general'),
  ('gold_color',         '#B98637',                          'string',  'Couleur or',                'general'),
  ('contact_email',      'contact@zukago.com',               'string',  'Email de contact',          'general'),
  ('contact_whatsapp',   '+237600000000',                    'string',  'WhatsApp contact',          'general'),
  ('instagram',          '@zukago',                          'string',  'Instagram',                 'general'),
  ('partner_free',       'true',                             'boolean', 'Inscription partenaire gratuite', 'general'),
  ('calendar_months_fr', '["Jan","Fév","Mar","Avr","Mai","Jun","Jul","Aoû","Sep","Oct","Nov","Déc"]', 'json', 'Mois calendrier FR', 'general'),
  ('calendar_days_fr',   '["Dim","Lun","Mar","Mer","Jeu","Ven","Sam"]', 'json', 'Jours calendrier FR', 'general'),
  ('calendar_months_en', '["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]', 'json', 'Mois calendrier EN', 'general'),
  ('calendar_days_en',   '["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]', 'json', 'Jours calendrier EN', 'general');

-- ─── 2. SERVICES ──────────────────────────────────────────────────────────────
CREATE TABLE services (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,  -- 'apt', 'hotel', 'car', 'driver', 'cov'
  label       TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  enabled     BOOLEAN DEFAULT TRUE,
  coming_soon BOOLEAN DEFAULT FALSE,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO services (code, label, emoji, enabled, coming_soon, sort_order) VALUES
  ('apt',    'Appartements', '🏠', TRUE,  FALSE, 1),
  ('hotel',  'Hotels',       '🏨', TRUE,  FALSE, 2),
  ('car',    'Voitures',     '🚗', TRUE,  FALSE, 3),
  ('driver', 'Chauffeurs',   '🚖', TRUE,  FALSE, 4),
  ('cov',    'Covoiturage',  '🤝', FALSE, TRUE,  5);

-- ─── 3. LANGUES ───────────────────────────────────────────────────────────────
CREATE TABLE languages (
  id      UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code    TEXT UNIQUE NOT NULL,  -- 'fr', 'en', 'de'
  label   TEXT NOT NULL,
  flag    TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE
);

INSERT INTO languages (code, label, flag) VALUES
  ('fr', 'Français', '🇫🇷'),
  ('en', 'English',  '🇬🇧'),
  ('de', 'Deutsch',  '🇩🇪');

-- ─── 4. TRADUCTIONS ───────────────────────────────────────────────────────────
CREATE TABLE translations (
  id       UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  lang     TEXT NOT NULL REFERENCES languages(code),
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  UNIQUE(lang, key)
);

-- ─── 5. DEVISES ───────────────────────────────────────────────────────────────
CREATE TABLE currencies (
  id      UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code    TEXT UNIQUE NOT NULL,  -- 'FCFA', 'EUR', 'USD'
  symbol  TEXT NOT NULL,
  flag    TEXT NOT NULL,
  rate    DECIMAL(10, 6) DEFAULT 1, -- taux par rapport au FCFA
  enabled BOOLEAN DEFAULT TRUE
);

INSERT INTO currencies (code, symbol, flag, rate) VALUES
  ('FCFA', 'FCFA', '🇨🇲', 1),
  ('EUR',  '€',    '🇪🇺', 0.00152),
  ('USD',  '$',    '🇺🇸', 0.00164);

-- ─── 6. VILLES ────────────────────────────────────────────────────────────────
CREATE TABLE cities (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  label      TEXT NOT NULL,
  emoji      TEXT,
  country    TEXT DEFAULT 'CM',
  active     BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0
);

INSERT INTO cities (code, label, emoji, sort_order) VALUES
  ('douala',   'Douala',    '🏙️', 1),
  ('yaounde',  'Yaoundé',   '🏛️', 2),
  ('kribi',    'Kribi',     '🏖️', 3),
  ('bafouss',  'Bafoussam', '🏔️', 4),
  ('garoua',   'Garoua',    '🌅', 5),
  ('bamenda',  'Bamenda',   '🏞️', 6);

-- ─── 7. QUARTIERS ─────────────────────────────────────────────────────────────
CREATE TABLE quartiers (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  city_code  TEXT NOT NULL REFERENCES cities(code),
  label      TEXT NOT NULL,
  active     BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0
);

INSERT INTO quartiers (city_code, label, sort_order) VALUES
  ('douala', 'Bonapriso', 1), ('douala', 'Akwa', 2), ('douala', 'Makepe', 3),
  ('douala', 'Bali', 4), ('douala', 'Bonanjo', 5), ('douala', 'Logpom', 6),
  ('yaounde', 'Bastos', 1), ('yaounde', 'Melen', 2), ('yaounde', 'Nlongkak', 3),
  ('yaounde', 'Mvog-Mbi', 4), ('yaounde', 'Mfoundi', 5),
  ('kribi', 'Centre ville', 1), ('kribi', 'Plage', 2);

-- ─── 8. ÉQUIPEMENTS ───────────────────────────────────────────────────────────
CREATE TABLE amenities (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  label      TEXT NOT NULL,
  emoji      TEXT,
  priority   BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  active     BOOLEAN DEFAULT TRUE
);

INSERT INTO amenities (code, label, emoji, priority, sort_order) VALUES
  ('wifi',  'WiFi',           '📶', TRUE,  1),
  ('clim',  'Climatisation',  '❄️', TRUE,  2),
  ('elec',  'Groupe élec.',   '⚡', TRUE,  3),
  ('park',  'Parking',        '🅿️', TRUE,  4),
  ('pool',  'Piscine',        '🏊', FALSE, 5),
  ('secu',  'Sécurité 24h',   '🔒', TRUE,  6),
  ('kitch', 'Cuisine éq.',    '🍳', FALSE, 7),
  ('tv',    'TV / Déco.',     '📺', FALSE, 8),
  ('water', 'Eau chaude',     '🚿', FALSE, 9),
  ('gym',   'Salle sport',    '🏋️', FALSE, 10),
  ('laund', 'Laverie',        '👕', FALSE, 11),
  ('balc',  'Balcon/Terrasse','🌿', FALSE, 12);

-- ─── 9. MÉTHODES DE PAIEMENT ──────────────────────────────────────────────────
CREATE TABLE payment_methods (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,  -- 'mtn', 'orange', 'card', 'paypal'
  label      TEXT NOT NULL,
  emoji      TEXT,
  color      TEXT,
  sub        TEXT,
  enabled    BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0
);

INSERT INTO payment_methods (code, label, emoji, color, sub, sort_order) VALUES
  ('mtn',    'MTN Mobile Money',     '📱', '#FFC300', 'Paiement instantané',  1),
  ('orange', 'Orange Money',          '🟠', '#FF6B00', 'Paiement instantané',  2),
  ('card',   'Carte Visa/Mastercard', '💳', '#1B6B3A', 'Securise par Stripe',  3),
  ('paypal', 'PayPal',                '🅿️', '#003087', 'International',        4);

-- ─── 10. NAVIGATION TABS ──────────────────────────────────────────────────────
CREATE TABLE nav_tabs (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  icon       TEXT NOT NULL,
  label_fr   TEXT NOT NULL,
  label_en   TEXT NOT NULL,
  label_de   TEXT NOT NULL,
  is_center  BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  enabled    BOOLEAN DEFAULT TRUE
);

INSERT INTO nav_tabs (name, icon, label_fr, label_en, label_de, is_center, sort_order) VALUES
  ('Accueil',   '🏠', 'Accueil',  'Home',    'Start',         FALSE, 1),
  ('Recherche', '🔍', 'Chercher', 'Search',  'Suchen',        FALSE, 2),
  ('Publier',   '✚',  'Publier',  'Publish', 'Posten',        TRUE,  3),
  ('Favoris',   '🤍', 'Favoris',  'Favorites','Favoriten',    FALSE, 4),
  ('Profil',    '👤', 'Profil',   'Profile', 'Profil',        FALSE, 5);

-- ─── 11. MENU PROFIL ──────────────────────────────────────────────────────────
CREATE TABLE profile_menu (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  emoji      TEXT NOT NULL,
  label_fr   TEXT NOT NULL,
  label_en   TEXT NOT NULL,
  sub_fr     TEXT,
  route      TEXT NOT NULL,
  enabled    BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0
);

INSERT INTO profile_menu (code, emoji, label_fr, label_en, sub_fr, route, sort_order) VALUES
  ('bookings', '📋', 'Mes reservations', 'My bookings',    'Voir vos reservations',         'MyBookings',  1),
  ('payments', '💳', 'Paiements',        'Payments',        'Historique et methodes',         'MyPayments',  2),
  ('notifs',   '🔔', 'Notifications',    'Notifications',   'Gerer vos alertes',              'Notifications',3),
  ('security', '🔒', 'Sécurité',         'Security',        'Mot de passe et confidentialite','Security',    4),
  ('help',     '❓', 'Aide & Support',   'Help & Support',  'FAQ et contact',                 'Help',        5),
  ('cgu',      '📄', 'CGU & Politique',  'Terms & Privacy', 'Conditions generales',           'CGU',         6);

-- ─── 12. BANNIÈRES PROMO ──────────────────────────────────────────────────────
CREATE TABLE promo_banners (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  text       TEXT NOT NULL,
  emoji      TEXT,
  color_from TEXT DEFAULT '#B98637',
  color_to   TEXT DEFAULT '#D4A855',
  filter_type TEXT,  -- 'hotel', 'apt', 'car', 'driver' — filtre automatique
  enabled    BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ
);

INSERT INTO promo_banners (text, emoji, color_from, color_to, filter_type, sort_order) VALUES
  ('-20% sur les hotels ce week-end',         '🏨', '#B98637', '#D4A855', 'hotel',  1),
  ('Nouveaux chauffeurs certifies a Douala',  '🚖', '#162E5A', '#1E3F7A', 'driver', 2),
  ('Voitures avec chauffeur des 40 000 FCFA', '🚗', '#0D3B66', '#1565C0', 'car',    3);

-- ─── 13. COMMENT ÇA MARCHE ────────────────────────────────────────────────────
CREATE TABLE how_it_works (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  step_num   TEXT NOT NULL,
  title_fr   TEXT NOT NULL,
  title_en   TEXT NOT NULL,
  desc_fr    TEXT NOT NULL,
  desc_en    TEXT NOT NULL,
  emoji      TEXT,
  sort_order INTEGER DEFAULT 0
);

INSERT INTO how_it_works (step_num, title_fr, title_en, desc_fr, desc_en, emoji, sort_order) VALUES
  ('01', 'Cherchez', 'Search',  'Appartement, hotel, voiture ou chauffeur',   'Apartment, hotel, car or driver',        '🔍', 1),
  ('02', 'Reservez', 'Book',    'Choisissez vos dates et payez en securite',  'Choose your dates and pay securely',     '📅', 2),
  ('03', 'Profitez', 'Enjoy',   'Accedez a votre location. L''hote vous attend','Access your rental. Host is waiting', '🎉', 3);

-- ─── 14. SECTION PARTENAIRE ───────────────────────────────────────────────────
CREATE TABLE partner_section (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  title_fr    TEXT DEFAULT 'Vous avez un bien à louer ?',
  title_en    TEXT DEFAULT 'Do you have a property to rent?',
  subtitle_fr TEXT DEFAULT 'Rejoignez ZUKAGO gratuitement et commencez à gagner en FCFA',
  subtitle_en TEXT DEFAULT 'Join ZUKAGO for free and start earning',
  features    JSONB DEFAULT '["Inscription gratuite","Commission seulement sur ventes","Paiement Mobile Money"]',
  cta_label_fr TEXT DEFAULT 'Devenir partenaire',
  cta_label_en TEXT DEFAULT 'Become a partner',
  cta_enabled BOOLEAN DEFAULT TRUE
);

INSERT INTO partner_section (title_fr, title_en, subtitle_fr, subtitle_en, features, cta_label_fr, cta_label_en, cta_enabled) VALUES
  (
    'Vous avez un bien a louer ?',
    'Do you have a property to rent?',
    'Rejoignez ZUKAGO gratuitement et commencez a gagner en FCFA',
    'Join ZUKAGO for free and start earning',
    '["Inscription gratuite","Commission seulement sur ventes","Paiement Mobile Money"]',
    'Devenir partenaire',
    'Become a partner',
    TRUE
  );

-- ─── 15. UTILISATEURS ─────────────────────────────────────────────────────────
CREATE TABLE users (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  password     TEXT,  -- null si OAuth
  avatar       TEXT,
  phone        TEXT,
  whatsapp     TEXT,
  role         TEXT DEFAULT 'client',  -- 'client', 'partner', 'admin'
  provider     TEXT DEFAULT 'email',   -- 'email', 'google'
  provider_id  TEXT,
  verified     BOOLEAN DEFAULT FALSE,
  active       BOOLEAN DEFAULT TRUE,
  refresh_token TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 16. PARTENAIRES ──────────────────────────────────────────────────────────
CREATE TABLE partners (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,  -- 'proprietaire', 'hoteliers', 'voiture', 'chauffeur'
  status        TEXT DEFAULT 'pending',  -- 'pending', 'approved', 'rejected', 'suspended'
  id_document   TEXT,  -- URL Cloudinary
  rejection_msg TEXT,
  approved_by   UUID REFERENCES users(id),
  approved_at   TIMESTAMPTZ,
  solde         DECIMAL(12, 2) DEFAULT 0,
  commission_rate DECIMAL(5, 2),  -- null = utilise commission globale
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 17. ANNONCES ─────────────────────────────────────────────────────────────
CREATE TABLE listings (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  partner_id   UUID NOT NULL REFERENCES partners(id),
  type         TEXT NOT NULL,  -- 'apt', 'hotel', 'car', 'driver'
  title        TEXT NOT NULL,
  description  TEXT,
  sub_type     TEXT,
  city_code    TEXT REFERENCES cities(code),
  quartier     TEXT,
  address      TEXT,
  latitude     DECIMAL(10, 8),
  longitude    DECIMAL(11, 8),
  price        DECIMAL(12, 2) NOT NULL,
  price_weekend DECIMAL(12, 2),
  unit         TEXT DEFAULT 'nuit',  -- 'nuit', 'jour'
  min_nights   INTEGER DEFAULT 1,
  caution      DECIMAL(12, 2),
  status       TEXT DEFAULT 'pending',  -- 'pending', 'active', 'rejected', 'inactive'
  featured     BOOLEAN DEFAULT FALSE,
  rejection_msg TEXT,
  approved_by  UUID REFERENCES users(id),
  approved_at  TIMESTAMPTZ,
  views        INTEGER DEFAULT 0,
  badge        TEXT,
  gradient_from TEXT DEFAULT '#162E5A',
  gradient_to   TEXT DEFAULT '#1E3F7A',
  emoji        TEXT DEFAULT '🏠',
  whatsapp     TEXT,
  contact_email TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 18. PHOTOS ANNONCES ──────────────────────────────────────────────────────
CREATE TABLE listing_photos (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,       -- URL Cloudinary
  public_id  TEXT NOT NULL,       -- Public ID Cloudinary pour suppression
  is_main    BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 19. ÉQUIPEMENTS PAR ANNONCE ─────────────────────────────────────────────
CREATE TABLE listing_amenities (
  listing_id   UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  amenity_code TEXT NOT NULL REFERENCES amenities(code),
  PRIMARY KEY (listing_id, amenity_code)
);

-- ─── 20. FAVORIS ──────────────────────────────────────────────────────────────
CREATE TABLE favorites (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, listing_id)
);

-- ─── 21. RÉSERVATIONS ─────────────────────────────────────────────────────────
CREATE TABLE bookings (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,  -- ex: ZKG-MNJAS3
  user_id      UUID NOT NULL REFERENCES users(id),
  listing_id   UUID NOT NULL REFERENCES listings(id),
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  nights       INTEGER NOT NULL,
  price_per_night DECIMAL(12, 2) NOT NULL,
  subtotal     DECIMAL(12, 2) NOT NULL,
  service_fee  DECIMAL(12, 2) NOT NULL,  -- frais ZUKAGO (5%)
  total        DECIMAL(12, 2) NOT NULL,
  commission   DECIMAL(12, 2) NOT NULL,  -- commission ZUKAGO (17% du subtotal)
  partner_gets DECIMAL(12, 2) NOT NULL,  -- ce que reçoit le partenaire
  status       TEXT DEFAULT 'pending',   -- 'pending', 'confirmed', 'cancelled', 'completed'
  payment_method TEXT,
  payment_ref  TEXT,                     -- référence paiement
  payment_status TEXT DEFAULT 'pending', -- 'pending', 'paid', 'refunded'
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 22. PAIEMENTS ────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  booking_id    UUID NOT NULL REFERENCES bookings(id),
  user_id       UUID NOT NULL REFERENCES users(id),
  amount        DECIMAL(12, 2) NOT NULL,
  currency      TEXT DEFAULT 'FCFA',
  method        TEXT NOT NULL,         -- 'mtn', 'orange', 'card', 'paypal'
  provider      TEXT,                  -- 'cinetpay', 'stripe', 'paypal'
  provider_ref  TEXT,                  -- ID transaction chez le provider
  status        TEXT DEFAULT 'pending',-- 'pending', 'success', 'failed', 'refunded'
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 23. COMMISSIONS ──────────────────────────────────────────────────────────
CREATE TABLE commissions (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  partner_id  UUID NOT NULL REFERENCES partners(id),
  amount      DECIMAL(12, 2) NOT NULL,  -- montant commission ZUKAGO
  rate        DECIMAL(5, 2) NOT NULL,   -- taux appliqué
  status      TEXT DEFAULT 'pending',   -- 'pending', 'paid'
  paid_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 24. RETRAITS ─────────────────────────────────────────────────────────────
CREATE TABLE withdrawals (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  partner_id  UUID NOT NULL REFERENCES partners(id),
  amount      DECIMAL(12, 2) NOT NULL,
  method      TEXT NOT NULL,           -- 'mtn', 'orange', 'bank'
  account     TEXT NOT NULL,           -- numéro de compte / téléphone
  status      TEXT DEFAULT 'pending',  -- 'pending', 'approved', 'rejected', 'sent'
  rejected_msg TEXT,
  processed_by UUID REFERENCES users(id),
  processed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 25. AVIS ─────────────────────────────────────────────────────────────────
CREATE TABLE reviews (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  booking_id UUID REFERENCES bookings(id),
  rating     INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment    TEXT,
  verified   BOOLEAN DEFAULT FALSE,  -- TRUE si lié à une vraie réservation
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 26. NOTIFICATIONS ────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id    UUID REFERENCES users(id),   -- null = broadcast
  target     TEXT DEFAULT 'all',          -- 'all', 'clients', 'partners', 'user_id'
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  type       TEXT DEFAULT 'info',         -- 'info', 'booking', 'payment', 'promo'
  read       BOOLEAN DEFAULT FALSE,
  sent       BOOLEAN DEFAULT FALSE,
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 27. STATISTIQUES ─────────────────────────────────────────────────────────
CREATE TABLE stats_daily (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  date          DATE UNIQUE NOT NULL,
  total_bookings INTEGER DEFAULT 0,
  total_revenue  DECIMAL(12, 2) DEFAULT 0,
  total_commission DECIMAL(12, 2) DEFAULT 0,
  new_users      INTEGER DEFAULT 0,
  new_partners   INTEGER DEFAULT 0,
  new_listings   INTEGER DEFAULT 0
);

-- ════════════════════════════════════════════════════════════════════════════
-- INDEXES pour performance
-- ════════════════════════════════════════════════════════════════════════════
CREATE INDEX idx_listings_type    ON listings(type);
CREATE INDEX idx_listings_status  ON listings(status);
CREATE INDEX idx_listings_city    ON listings(city_code);
CREATE INDEX idx_listings_partner ON listings(partner_id);
CREATE INDEX idx_bookings_user    ON bookings(user_id);
CREATE INDEX idx_bookings_listing ON bookings(listing_id);
CREATE INDEX idx_bookings_status  ON bookings(status);
CREATE INDEX idx_reviews_listing  ON reviews(listing_id);
CREATE INDEX idx_favorites_user   ON favorites(user_id);

-- ════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS) — Supabase
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorites       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews         ENABLE ROW LEVEL SECURITY;

-- Policies users
CREATE POLICY "Users can read own data" ON users FOR SELECT USING (auth.uid()::text = id::text);
CREATE POLICY "Users can update own data" ON users FOR UPDATE USING (auth.uid()::text = id::text);

-- Policies listings (lecture publique pour actives)
CREATE POLICY "Anyone can read active listings" ON listings FOR SELECT USING (status = 'active');

-- Policies bookings
CREATE POLICY "Users can read own bookings" ON bookings FOR SELECT USING (auth.uid()::text = user_id::text);
CREATE POLICY "Users can create bookings" ON bookings FOR INSERT WITH CHECK (auth.uid()::text = user_id::text);

-- Policies favorites
CREATE POLICY "Users manage own favorites" ON favorites USING (auth.uid()::text = user_id::text);

-- Policies reviews
CREATE POLICY "Anyone can read reviews" ON reviews FOR SELECT USING (TRUE);
CREATE POLICY "Users can create reviews" ON reviews FOR INSERT WITH CHECK (auth.uid()::text = user_id::text);
