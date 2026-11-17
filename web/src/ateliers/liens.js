// Ateliers (volet du 13/11) : les liens entre notes d'un coffre Markdown — module PUR, lu par le serveur (lib/ateliers.mjs,
// le graphe) et par l'interface (CoffreNode.jsx, la navigation), pour qu'un lien mène au même endroit des deux côtés.
// Compris : [[Nom]], [[Nom|texte]], [[Nom#titre]], [[dossier/Nom]], et les liens Markdown relatifs vers un .md
// ([texte](../x/autre.md), [texte](autre.md#titre)). Les blocs de code (``` et ~~~) et le code en ligne sont sautés.

const CLOTURE = /^ {0,3}(`{3,}|~{3,})/

// Les cibles citées par une note, dans l'ordre : [{ cible, genre: 'wiki' | 'md' }].
export function extraitLiens(texte) {
  const out = []
  let dansCode = ''
  for (const ligne of String(texte).split('\n')) {
    const f = CLOTURE.exec(ligne)
    if (f) {
      if (!dansCode) dansCode = f[1][0]
      else if (f[1][0] === dansCode) dansCode = ''
      continue
    }
    if (dansCode) continue
    const sansCode = ligne.replace(/`[^`]*`/g, '')
    for (const m of sansCode.matchAll(/\[\[([^\[\]\n]{1,200})\]\]/g)) {
      const cible = m[1].split('|')[0].split('#')[0].trim()
      if (cible) out.push({ cible, genre: 'wiki' })
    }
    for (const m of sansCode.matchAll(/\]\(([^()\s]{1,300})\)/g)) {
      const cible = cibleMd(m[1])
      if (cible) out.push({ cible, genre: 'md' })
    }
  }
  return out
}

// Un lien Markdown relatif vers un .md : le chemin sans ancre, décodé ; '' si ce n'en est pas un (http, mailto, absolu…).
export function cibleMd(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) return ''
  let c = url.split('#')[0].split('?')[0]
  try {
    c = decodeURIComponent(c)
  } catch {
    return ''
  }
  return /\.md$/i.test(c) ? c : ''
}

const dossierDe = (chemin) => (chemin.includes('/') ? chemin.slice(0, chemin.lastIndexOf('/')) : '')
const nomDe = (chemin) => chemin.slice(chemin.lastIndexOf('/') + 1).replace(/\.md$/i, '')
const normalise = (s) => s.normalize('NFC').toLowerCase()

// Résout un chemin relatif (« a/../b/c.md ») par rapport au dossier `base` ; null s'il sort du coffre.
function joint(base, rel) {
  const parts = base ? base.split('/') : []
  for (const s of rel.split('/')) {
    if (!s || s === '.') continue
    if (s === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(s)
  }
  return parts.join('/')
}

// Un index des notes d'un coffre (chemins relatifs au coffre, avec « .md ») pour résoudre vite.
export function indexNotes(chemins) {
  const parChemin = new Map(chemins.map((c, i) => [normalise(c), i]))
  const parNom = new Map()
  chemins.forEach((c, i) => {
    const k = normalise(nomDe(c))
    if (!parNom.has(k)) parNom.set(k, [])
    parNom.get(k).push(i)
  })
  // Le dossier de chaque note, découpé une fois (la résolution d'un nom ambigu compare des dossiers).
  const dossiers = chemins.map((c) => (dossierDe(c) ? dossierDe(c).split('/') : []))
  return { chemins, parChemin, parNom, dossiers }
}

// Où mène `cible` (genre 'wiki' ou 'md') écrit dans la note `source` (chemin relatif au coffre) :
// { i: indice de la note visée ou -1 (lien cassé), n: nombre de notes candidates (> 1 = nom ambigu) }.
// Wiki : chemin depuis la racine du coffre s'il contient « / », sinon le nom ; parmi plusieurs notes du même nom, la plus
// proche de la source (plus long dossier commun, puis chemin le plus court). Md : chemin relatif au dossier de la source.
export function resoutLien(cible, genre, source, index) {
  if (genre === 'md') {
    const c = joint(dossierDe(source), cible)
    const i = c === null ? undefined : index.parChemin.get(normalise(c))
    return { i: i ?? -1, n: i === undefined ? 0 : 1 }
  }
  if (cible.includes('/')) {
    const c = joint('', /\.md$/i.test(cible) ? cible : `${cible}.md`)
    const i = c === null ? undefined : index.parChemin.get(normalise(c))
    if (i !== undefined) return { i, n: 1 }
  }
  const candidats = index.parNom.get(normalise(nomDe(cible))) || []
  if (!candidats.length) return { i: -1, n: 0 }
  if (candidats.length === 1) return { i: candidats[0], n: 1 }
  // Un seul passage (pas de tri) : le plus long dossier commun avec la source, puis le chemin le plus court.
  const dSource = dossierDe(source) ? dossierDe(source).split('/') : []
  let meilleur = -1
  let mCommun = -1
  for (const c of candidats) {
    const d = index.dossiers ? index.dossiers[c] : dossierDe(index.chemins[c]).split('/')
    let k = 0
    while (k < d.length && k < dSource.length && d[k] === dSource[k]) k++
    if (k > mCommun || (k === mCommun && index.chemins[c].length < index.chemins[meilleur].length)) {
      meilleur = c
      mCommun = k
    }
  }
  return { i: meilleur, n: candidats.length }
}
