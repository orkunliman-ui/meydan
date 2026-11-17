#!/usr/bin/env node
// Crée les identifiants de la porte publique de Meydan (identifiant + mot de passe + code à 6 chiffres) :
// data/auth.json (0600), au format que server.mjs lit (MEYDAN_AUTH_FILE pour un autre chemin).
// Usage : node scripts/creer-acces.mjs <identifiant>
//   Le mot de passe est demandé sans écho (12 caractères au moins). Le secret du code s'affiche UNE fois, avec le lien
//   otpauth:// à coller dans une application d'authentification (ou à transformer en QR code).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { hashPassword, newSessionSecret, newTotpSecret, otpauthUri } from '../lib/auth-core.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DATA = process.env.MEYDAN_DATA || path.join(ROOT, 'data')
const FICHIER = process.env.MEYDAN_AUTH_FILE || path.join(DATA, 'auth.json')
const user = process.argv[2]
if (!user || !/^[A-Za-z0-9._-]{2,40}$/.test(user)) {
  console.error('usage : node scripts/creer-acces.mjs <identifiant>   (lettres, chiffres, . _ -, 2 à 40 caractères)')
  process.exit(2)
}
if (fs.existsSync(FICHIER) && !process.argv.includes('--remplacer')) {
  console.error(`${FICHIER} existe déjà : ajoute --remplacer pour en créer de nouveaux (toutes les sessions seront fermées).`)
  process.exit(2)
}

function demande(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : '') // pas d'écho
    rl.question(question, (r) => {
      rl.close()
      process.stdout.write('\n')
      resolve(r)
    })
  })
}

const mdp = await demande('Mot de passe : ')
if (mdp.length < 12) {
  console.error('mot de passe trop court (12 caractères au moins)')
  process.exit(2)
}
if ((await demande('Encore une fois : ')) !== mdp) {
  console.error('les deux saisies diffèrent')
  process.exit(2)
}
const totpSecret = newTotpSecret()
const c = { user, passwordHash: await hashPassword(mdp), totpSecret, sessionSecret: newSessionSecret() }
fs.mkdirSync(path.dirname(FICHIER), { recursive: true, mode: 0o700 })
fs.writeFileSync(FICHIER, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
fs.chmodSync(FICHIER, 0o600)
console.log(`\nIdentifiants écrits dans ${FICHIER} (0600).`)
console.log('Ajoute ce compte dans ton application d\'authentification (affiché une seule fois) :')
console.log(`  secret : ${totpSecret}`)
console.log(`  lien   : ${otpauthUri(user, totpSecret)}`)
