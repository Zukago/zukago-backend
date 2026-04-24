/**
 * ZUKAGO — routes/places.js (V11)
 * Google Places API côté serveur — clé sécurisée dans Railway
 *
 * V11 : recherche permissive (types='geocode' par défaut) + biais Cameroun
 *       + extraction intelligente de ville/quartier dans /details
 *       → permet de trouver quartiers (Bonamoussadi, Akwa) et établissements
 */

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Centre du Cameroun pour biais géographique (Yaoundé)
// Les résultats camerounais remontent en priorité mais sans exclure le reste du monde.
const CAMEROON_BIAS = {
  location: '7.3697,12.3547',  // centre approx. du Cameroun
  radius:   '500000',           // 500 km
};

// ─── GET /api/places/autocomplete ────────────────────────────────────────────
// Params :
//   - input   : texte cherché (min 2 caractères)
//   - language: 'fr' par défaut
//   - types   : 'geocode' par défaut (villes + quartiers + lieux + adresses)
//               Autres valeurs : '(cities)', '(regions)', 'address', 'establishment'
// ✅ V11 : par défaut 'geocode' = recherche large permettant de trouver quartiers comme
//         "Bonamoussadi", "Akwa", etc. qui ne sont pas des villes officielles.
router.get('/autocomplete', asyncHandler(async (req, res) => {
  const { input, language = 'fr', types = 'geocode' } = req.query;

  if (!input || input.trim().length < 2) {
    return res.json({ predictions: [] });
  }

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'Google Places API key manquante' });
  }

  const params = new URLSearchParams({
    input:    input.trim(),
    language,
    types,
    key:      GOOGLE_API_KEY,
    // ✅ V11 : biais vers le Cameroun (résultats locaux en premier, sans exclure le reste)
    location: CAMEROON_BIAS.location,
    radius:   CAMEROON_BIAS.radius,
  });

  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;

  const response = await fetch(url);
  const data     = await response.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    console.log('Google Places error:', data.status, data.error_message);
    return res.json({ predictions: [] });
  }

  // Formater les résultats
  const predictions = (data.predictions || []).map(p => ({
    place_id:    p.place_id,
    label:       p.structured_formatting?.main_text    || p.description,
    sub:         p.structured_formatting?.secondary_text || '',
    description: p.description,
    types:       p.types || [],
  }));

  res.json({ predictions });
}));

// ─── GET /api/places/details?place_id=xxx ────────────────────────────────────
// ✅ V11 : extraction intelligente ville + quartier + pays depuis address_components
//          pour auto-remplir les 3 champs du wizard (ville, quartier, adresse).
router.get('/details', asyncHandler(async (req, res) => {
  const { place_id, language = 'fr' } = req.query;

  if (!place_id) return res.status(400).json({ error: 'place_id requis' });
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'Clé API manquante' });

  const params = new URLSearchParams({
    place_id,
    language,
    fields: 'geometry,address_components,formatted_address,name,types',
    key:    GOOGLE_API_KEY,
  });

  const url  = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status !== 'OK') {
    return res.json({ result: null });
  }

  const r = data.result;
  const components = r.address_components || [];

  // Helper : récupère le premier component matchant un des types donnés
  const getComponent = (types) => {
    const comp = components.find(c =>
      types.some(t => c.types.includes(t))
    );
    return comp?.long_name || '';
  };

  // ✅ V11 : extraction intelligente par hiérarchie de types
  //
  // Pour "Bonamoussadi, Douala, Cameroun" les address_components sont généralement :
  //   - sublocality / sublocality_level_1 / neighborhood → Bonamoussadi
  //   - locality → Douala
  //   - administrative_area_level_1 → Littoral
  //   - country → Cameroun
  //
  // Pour "Marché Central, Akwa, Douala, Cameroun" :
  //   - establishment / point_of_interest → Marché Central
  //   - sublocality → Akwa
  //   - locality → Douala
  //
  // Pour une ville officielle "Douala" seule :
  //   - locality → Douala (pas de sublocality)

  // Quartier (sublocality, neighborhood) — peut être vide si c'est une ville officielle
  const neighborhood = getComponent([
    'sublocality_level_1',
    'sublocality',
    'neighborhood',
  ]);

  // Ville (locality — priorité) sinon niveau admin 2
  const city = getComponent(['locality'])
    || getComponent(['administrative_area_level_2'])
    || getComponent(['administrative_area_level_1']);

  const country = getComponent(['country']);

  // Nom court du lieu (nom d'établissement ou titre principal)
  const placeName = r.name || '';

  // Si l'user a cherché un établissement (ex: "Marché Central"), on le met comme adresse/label
  // Si c'est juste un quartier → placeName == neighborhood (on ne duplique pas)
  const isEstablishment = (r.types || []).some(t =>
    t === 'establishment' || t === 'point_of_interest'
  );

  const lat = r.geometry?.location?.lat;
  const lng = r.geometry?.location?.lng;

  res.json({
    result: {
      place_id,
      name:              placeName,
      formatted_address: r.formatted_address,
      city,                                    // Ex: "Douala"
      neighborhood,                            // Ex: "Bonamoussadi"  (peut être vide)
      country,                                 // Ex: "Cameroun"
      is_establishment:  isEstablishment,      // true si lieu/commerce
      types:             r.types || [],
      coords: lat && lng ? { lat, lng, latitude: lat, longitude: lng } : null,
    },
  });
}));

module.exports = router;
