/**
 * ZUKAGO — routes/places.js
 * Google Places API côté serveur — clé sécurisée dans Railway
 * §3.7 — rien hardcodé, clé dans variables d'environnement
 */

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ─── GET /api/places/autocomplete?input=Douala&language=fr ───────────────────
// Autocomplétion de villes/adresses via Google Places
router.get('/autocomplete', asyncHandler(async (req, res) => {
  const { input, language = 'fr', types = '(cities)' } = req.query;

  if (!input || input.trim().length < 2) {
    return res.json({ predictions: [] });
  }

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'Google Places API key manquante' });
  }

  const params = new URLSearchParams({
    input:    input.trim(),
    language,
    types,    // '(cities)' pour villes, 'geocode' pour adresses complètes
    key:      GOOGLE_API_KEY,
    // Bias vers l'Afrique — priorité sans restriction stricte
    components: '',
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
// Détails d'un lieu — coordonnées GPS, pays, ville
router.get('/details', asyncHandler(async (req, res) => {
  const { place_id, language = 'fr' } = req.query;

  if (!place_id) return res.status(400).json({ error: 'place_id requis' });
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'Clé API manquante' });

  const params = new URLSearchParams({
    place_id,
    language,
    fields: 'geometry,address_components,formatted_address,name',
    key:    GOOGLE_API_KEY,
  });

  const url  = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status !== 'OK') {
    return res.json({ result: null });
  }

  const r = data.result;

  // Extraire ville et pays depuis address_components
  const getComponent = (types) => {
    const comp = (r.address_components || []).find(c =>
      types.some(t => c.types.includes(t))
    );
    return comp?.long_name || '';
  };

  const city    = getComponent(['locality', 'administrative_area_level_2', 'administrative_area_level_1']);
  const country = getComponent(['country']);
  const lat     = r.geometry?.location?.lat;
  const lng     = r.geometry?.location?.lng;

  res.json({
    result: {
      place_id,
      name:              r.name || city,
      formatted_address: r.formatted_address,
      city,
      country,
      coords: lat && lng ? { latitude: lat, longitude: lng } : null,
    },
  });
}));

module.exports = router;
