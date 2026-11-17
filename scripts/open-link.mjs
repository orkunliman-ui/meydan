// Écrit une page relais locale qui ouvre Meydan avec la clé, sans jamais afficher la clé.
// node scripts/open-link.mjs <fichier.html>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2]
if (!out) throw new Error('usage : node scripts/open-link.mjs <fichier.html>')
const key = fs.readFileSync(path.join(root, 'data', 'access.key'), 'utf8').trim()
const port = process.env.MEYDAN_PORT || 3070
fs.writeFileSync(out, `<!doctype html><meta http-equiv="refresh" content="0;url=http://127.0.0.1:${port}/?k=${key}">`, { mode: 0o600 })
console.log(`relais écrit (${fs.statSync(out).size} octets, clé non affichée)`)
