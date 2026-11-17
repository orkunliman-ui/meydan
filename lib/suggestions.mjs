import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const dossierSuggestions = () => process.env.MEYDAN_SUGGESTIONS_DIR || path.join(os.homedir(), '.meydan', 'suggestions')
const ID = /^[a-f0-9]{32}-[123]$/
const texteValide = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(x)
export function valideEntree(x) {
  return x && ID.test(x.id) && ['plainte', 'suggestion'].includes(x.type) && texteValide(x.projet, 1000) && texteValide(x.session, 160) && texteValide(x.texte, 2000) && typeof x.date === 'string' && Number.isFinite(Date.parse(x.date))
}

// Aucun suivi de lien à la place d'une entrée ; limite avant lecture (pas après allocation).
export function lireEntree(f) {
  let fd
  try {
    fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > 16_384) return null
    const x = JSON.parse(fs.readFileSync(fd, 'utf8'))
    return valideEntree(x) ? x : null
  } catch { return null } finally { if (fd !== undefined) fs.closeSync(fd) }
}

export function listeSuggestions(dir, classes = []) {
  let noms
  try { noms = fs.readdirSync(dir) } catch { return [] }
  const archives = new Set(classes)
  return noms.filter((n) => n.endsWith('.json') && ID.test(n.slice(0, -5)))
    .map((n) => lireEntree(path.join(dir, n))).filter(Boolean)
    .map((x) => ({ ...x, classee: archives.has(x.id) }))
    .sort((a, b) => b.date.localeCompare(a.date))
}

export function deposeSuggestion({ type, projet, session, texte }, dir = dossierSuggestions(), date = new Date()) {
  const base = crypto.createHash('sha256').update(`${projet}\0${session}`).digest('hex').slice(0, 32)
  const entree = { id: `${base}-1`, type, projet, session, date: date.toISOString(), texte: texte?.trim() }
  if (!valideEntree(entree)) throw new Error('type, projet, session ou texte invalide (2 000 caractères au plus)')
  if (/(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN .*PRIVATE KEY-----)/i.test(entree.texte)) throw new Error('secret probable : entrée refusée')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Trois emplacements exclusifs par projet/session, plaintes et suggestions confondues.
  // Les réservations restent après classement ; deux processus ne peuvent dépasser le plafond.
  for (let i = 1; i <= 3; i++) {
    entree.id = `${base}-${i}`
    const f = path.join(dir, `${entree.id}.json`)
    try { fs.writeFileSync(f, JSON.stringify(entree) + '\n', { flag: 'wx', mode: 0o600 }); return entree }
    catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  throw new Error('trois entrées déjà déposées pour cette session et ce projet')
}

export const leconDe = (x) => `[${x.date.slice(0, 10)}] | ${x.texte.replace(/\s+/g, ' ')} | cause racine à vérifier | règle à compléter après vérification`
