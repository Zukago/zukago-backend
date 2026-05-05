/**
 * ZUKAGO — diagnostic_v2.js (V14.3.1)
 *
 * Version AMÉLIORÉE qui montre le contenu RÉEL du fichier index.js
 * pour démasquer les bugs d'encoding ou de match de string.
 */

const fs = require('fs');

console.log('\n══════════════════════════════════════════════════');
console.log('  DIAGNOSTIC V2 — Inspection BRUTE');
console.log('══════════════════════════════════════════════════\n');

if (!fs.existsSync('src/index.js')) {
  console.log('❌ src/index.js introuvable');
  process.exit(1);
}

const buf = fs.readFileSync('src/index.js');
const content = buf.toString('utf-8');

console.log(`📏 Taille du fichier : ${buf.length} bytes`);
console.log(`📄 Lignes : ${content.split('\n').length}`);
console.log('');

// ─── BOM detection ──────────────────────────────────────────────────────
const hasBOM = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
if (hasBOM) {
  console.log('⚠️ BOM UTF-8 détecté en début de fichier (peut causer des bugs)');
} else {
  console.log('✅ Pas de BOM');
}
console.log('');

// ─── Listing TOUTES les lignes avec "messages" ──────────────────────────
console.log('─── Toutes les lignes contenant "messages" ───');
const lines = content.split('\n');
let found = false;
lines.forEach((line, i) => {
  if (line.toLowerCase().includes('messages')) {
    console.log(`  Ligne ${i+1}: ${line}`);
    found = true;
  }
});
if (!found) console.log('  ❌ AUCUNE ligne avec "messages" trouvée');
console.log('');

// ─── Regex stricte ──────────────────────────────────────────────────────
console.log('─── Test des patterns ───');
console.log(`  Match "/api/messages"           : ${content.includes('/api/messages')}`);
console.log(`  Match "'/api/messages'"         : ${content.includes("'/api/messages'")}`);
console.log(`  Match 'require("./routes/messages")' : ${content.includes("require('./routes/messages')")}`);
console.log(`  Match 'require(\\"./routes/messages\\")'   : ${content.includes('require("./routes/messages")')}`);
console.log('');

// ─── Listing TOUTES les routes app.use(/api/...) ────────────────────────
console.log('─── Toutes les routes app.use(\'/api/...\') ───');
const matches = [...content.matchAll(/app\.use\s*\(\s*['"]([^'"]+)['"]/g)];
if (matches.length === 0) {
  console.log('  ❌ Aucune route app.use trouvée');
} else {
  matches.forEach(m => {
    console.log(`  • ${m[1]}`);
  });
}
console.log('');

// ─── DUMP les 10 lignes autour de "carpool" ────────────────────────────
console.log('─── DUMP autour de "carpool" (contexte) ───');
const idx = content.indexOf('carpool');
if (idx >= 0) {
  const before = content.substring(Math.max(0, idx - 200), idx);
  const after = content.substring(idx, Math.min(content.length, idx + 300));
  console.log('--- AVANT ---');
  console.log(before);
  console.log('--- "carpool" ICI ---');
  console.log(after);
} else {
  console.log('  ❌ Mot "carpool" introuvable !!');
}
console.log('');

console.log('══════════════════════════════════════════════════');
console.log('  Envoie ce résultat complet à Claude');
console.log('══════════════════════════════════════════════════\n');
