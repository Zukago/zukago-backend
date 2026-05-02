/**
 * DIAGNOSTIC RAILWAY — V14.0.1
 *
 * USAGE :
 *   1. Place ce fichier à la racine de ton projet backend (à côté de package.json)
 *   2. Sur Railway → Settings → ajoute une variable :
 *        START_DIAGNOSTIC = true
 *   3. Modifie ton package.json "start" :
 *        BEFORE: "start": "node src/index.js"
 *        AFTER:  "start": "node diagnostic.js && node src/index.js"
 *   4. Redéploie
 *   5. Regarde les Deploy Logs — tu auras la cause exacte du crash
 *
 *   APRÈS DEBUG : remets le start original et supprime ce fichier.
 */

console.log('');
console.log('═══════════════════════════════════════════════');
console.log('🔬 DIAGNOSTIC ZUKAGO V14.0.1 — DÉMARRE');
console.log('═══════════════════════════════════════════════');
console.log('Node version :', process.version);
console.log('Platform     :', process.platform);
console.log('CWD          :', process.cwd());
console.log('');

// ═══ TEST 1 : Modules externes ═══
console.log('─── TEST 1 : Chargement des modules externes ───');
const externalModules = [
  'express',
  'bcryptjs',
  'express-rate-limit',
  'express-validator',
  'jsonwebtoken',
  'crypto',
];

let modulesOK = true;
for (const mod of externalModules) {
  try {
    require(mod);
    console.log(`  ✅ ${mod}`);
  } catch (e) {
    console.log(`  ❌ ${mod} → ${e.message}`);
    modulesOK = false;
  }
}
console.log('');

if (!modulesOK) {
  console.log('🚨 CAUSE TROUVEE : Module(s) manquant(s).');
  console.log('   Solution : npm install <module-name>');
  process.exit(1);
}

// ═══ TEST 2 : Variables d'environnement ═══
console.log('─── TEST 2 : Variables d\'environnement ───');
const requiredEnv = [
  'JWT_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'MAILGUN_API_KEY',
];

const missing = [];
for (const env of requiredEnv) {
  if (process.env[env]) {
    console.log(`  ✅ ${env} (longueur: ${process.env[env].length})`);
  } else {
    console.log(`  ❌ ${env} → MANQUANT`);
    missing.push(env);
  }
}
console.log('');

if (missing.length > 0) {
  console.log('🚨 CAUSE TROUVEE : Variable(s) d\'environnement manquante(s) :', missing.join(', '));
  process.exit(1);
}

// ═══ TEST 3 : Charger les fichiers ZUKAGO un par un ═══
console.log('─── TEST 3 : Chargement des fichiers ZUKAGO ───');
const filesToTest = [
  './src/config/database',
  './src/middleware/auth',
  './src/middleware/errorHandler',
  './src/services/emailService',
  './src/routes/auth',
];

for (const file of filesToTest) {
  try {
    require(file);
    console.log(`  ✅ ${file}`);
  } catch (e) {
    console.log(`  ❌ ${file}`);
    console.log(`     ERREUR : ${e.message}`);
    console.log(`     STACK  :`);
    console.log(e.stack.split('\n').slice(0, 6).map(l => '       ' + l).join('\n'));
    console.log('');
    console.log('🚨 CAUSE TROUVEE : Le fichier ' + file + ' crash au chargement.');
    process.exit(1);
  }
}
console.log('');

// ═══ TEST 4 : Vérifier les exports d'emailService ═══
console.log('─── TEST 4 : Fonctions d\'emailService.js ───');
const emailService = require('./src/services/emailService');
const requiredFunctions = [
  'sendWelcome',
  'sendVerification',
  'sendBookingConfirmation',
  'sendNewBookingToPartner',
  'sendPartnerApproved',
  'sendPartnerRejected',
  'sendPasswordReset',
  'sendPasswordResetConfirmation',
];

let allFnOK = true;
for (const fn of requiredFunctions) {
  if (typeof emailService[fn] === 'function') {
    console.log(`  ✅ ${fn}`);
  } else {
    console.log(`  ❌ ${fn} → ${typeof emailService[fn]}`);
    allFnOK = false;
  }
}
console.log('');

if (!allFnOK) {
  console.log('🚨 PROBLEME : emailService.js ne exporte pas toutes les fonctions requises.');
}

// ═══ FIN ═══
console.log('═══════════════════════════════════════════════');
console.log('✅ TOUS LES TESTS PASSES — Diagnostic OK');
console.log('   Le serveur peut démarrer normalement.');
console.log('═══════════════════════════════════════════════');
console.log('');
process.exit(0);
