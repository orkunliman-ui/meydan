// Réglages communs de l'essai de bout en bout, importé EN PREMIER par test/smoke.mjs : les modules de lib/ lisent leur
// environnement au chargement. Nom de l'humain fixé (les textes attendus disent « Orkun », quel que soit le compte qui
// lance l'essai) et faux serveur MCP de navigateur (le vrai n'existe que sur le serveur d'origine) : l'essai donne le
// même résultat sur toute machine, dépôt public compris.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.MEYDAN_NOM = 'Orkun'
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'meydan-essai-nav-'))
export const FAUX_NAVIGATEUR = path.join(dossier, 'mcp.mjs')
fs.writeFileSync(FAUX_NAVIGATEUR, '// faux serveur MCP de navigateur (essai) : jamais lancé\n')
process.env.MEYDAN_NAVIGATEUR_MCP = FAUX_NAVIGATEUR
process.on('exit', () => fs.rmSync(dossier, { recursive: true, force: true }))
