// Ce qu'on lit à voix haute d'une réponse d'agent (volet « voix »). Orkun, 11/11 : « ordres à la voix, réponses
// parlées ». Module pur, sans DOM : Voix.jsx (vite) et les essais (node) l'importent tous les deux.
// Ce qui ne se dit pas tel quel (blocs de code, tableaux, chemins, adresses, marques Markdown, émojis, empreintes de
// commit) devient une mention courte ou disparaît ; une longue réponse s'arrête à ses premières phrases, puis SUITE.
// Pas de « lookbehind » dans les expressions : un ancien Safari refuserait tout le paquet JavaScript.

export const SUITE = 'La suite est dans le Chat.'
const LONGUE = 220 // une phrase plus longue est coupée
const BLOC = 'Bloc de code.'
const BLOCS = 'Blocs de code.'
const TABLEAU = 'Un tableau.'

// Repères internes (zone privée d'Unicode, retirée du texte reçu) : un bloc de code, et un morceau déjà prêt à dire
// (nom de fichier, domaine, code court) qu'aucune règle suivante ne doit retoucher.
const MARQUE_BLOC = '\uE002'
const G0 = '\uE000'
const G1 = '\uE001'
const GARDE = /\uE000(\d+)\uE001/g

// Émojis et pictogrammes : flèches, signes techniques, dessin de boîte, formes, symboles divers, pictogrammes, braille,
// sélecteurs de variante, liant d'émoji, drapeaux et teintes de peau.
const PICTO = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2500}-\u{27BF}\u{27F0}-\u{297F}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{E0020}-\u{E007F}\u{200D}\u{20E3}\u{22EE}\u{22EF}\u{2122}\u{2139}\u{00A9}\u{00AE}\u{3030}\u{303D}]/gu
const FLECHE = /\s*(?:[→⇒➜➔➡⟶⟹↦←⇐⟵↔⇔]|-+>|=>)\s*/g
const POINT_MILIEU = /\s*[·•‣⁃∙]\s*/g

// Structure d'une ligne.
const CITATION = /^\s*(?:>\s?)+/
const FILET = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const SOULIGNE = /^\s*=+\s*$/
const TITRE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const PUCE = /^\s*(?:[-*+•–—▪◦‣]|\d{1,3}[.)])\s+(?:\[[ xX✓✔]\]\s+)?/
const SEPARATION = /^[\s|:-]+$/

// Dans une ligne (mêmes marques que enLigne dans Fil.jsx).
const CODE = /`([^`\n]+)`/g
const LIEN = /!?\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"\n]*")?\s*\)/g
const LIEN_REF = /\[([^\]\n]+)\]\[[^\]\n]*\]/g
const AUTOLIEN = /<((?:https?|wss?|ftp):\/\/[^\s<>]+)>/gi
const BALISE = /<!--[^\n]*?-->|<\/?[A-Za-z][\w-]*(?:\s[^<>\n]*)?\/?>/g
const GRAS = /\*\*([^*\n]+?)\*\*/g
const GRAS_SOULIGNE = /(^|[^\w])__([^_\n]+?)__(?=$|[^\w])/g
const ITALIQUE = /(^|[\s(«"'’])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?=$|[\s.,;:!?)»"'’])/g
const ITALIQUE_SOULIGNE = /(^|[\s(«"'’])_([^_\s](?:[^_\n]*[^_\s])?)_(?=$|[\s.,;:!?)»"'’])/g
const BARRE = /~~([^~\n]+?)~~/g
const ENTITES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

// Mots particuliers.
const ADRESSE = /^(?:(?:https?|wss?|ftp):\/\/|www\.)[^\s]/i
const COURRIEL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/
const DOMAINE_NU = /^(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s]*$/ // exemple.be/contact (adresse sans « https:// »)
const WINDOWS = /^[A-Za-z]:\\./
const SUFFIXE_LIGNE = /(?::(\d+)(?:[-–](\d+)|((?:,\d+)+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/
const EXTENSION = /[^.\s]\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?:[-–]\d+|(?:,\d+)+)?(?::\d+)?|#L\d+(?:-L?\d+)?)?$/
const NOM_FICHIER = /^[\w\u00C0-\u024F@+-][\w\u00C0-\u024F.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/
const FICHIER_LIGNE = /^[\w\u00C0-\u024F@+-][\w\u00C0-\u024F.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?:[-–]\d+|(?:,\d+)+)?(?::\d+)?|#L\d+(?:-L?\d+)?)$/
const PLAGE_COMMITS = /^[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40}$/
const AVANT = '([{«"\'“‘<'
const APRES = ')]}»"\'”’>.,;:!?…'
const CODE_PUR = /[{}()[\];=<>$\\|*^]|&&/
const DATE = /\b(?:\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}\/\d{1,2}\/\d{1,2})\b/g
const LE_DATE = /(\b(?:le|du|au|dès|depuis le|jusqu’au|jusqu'au)\s+)(\d{1,2}\/\d{1,2})(?![\d/])/gi

// Fin de phrase : un point qui ne coupe pas après ces abréviations (« etc. » seulement devant une minuscule).
const SANS_COUPE = new Set(['m', 'mm', 'mme', 'mmes', 'mlle', 'dr', 'pr', 'me', 'st', 'ste', 'cf', 'vs', 'ex', 'env', 'p', 'pp', 'n°', 'no', 'nº', 'réf', 'tél', 'fig', 'chap', 'vol', 'art', 'av', 'bd', 'éd', 'approx', 'resp', 'janv', 'févr', 'fév', 'avr', 'juil', 'sept', 'oct', 'nov', 'déc'])
const ENUMERATION = /^(?:\d{1,3}|\p{L})[.)]$/u // « 1. » devant la suite d'un titre en gras (« **1. Console muette** : … »)
const FIN_PHRASE = /[.!?…]+[»”"’)\]]*(?=\s|$)/g

const estHex = (c) => /^[0-9a-f]{7,40}$/.test(c) && /\d/.test(c) && /[a-f]/.test(c)
const lisible = (p) => /[\p{L}\p{N}]/u.test(p)
const ponctue = (p) => (/[.!?…:;,][»”"’)\]]*$/.test(p) ? p : p + '.')

// Adresse web → son nom de domaine, sans « www. » ni port.
function domaine(u) {
  const m = u.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([^/?#:\s]+)/i)
  return (m ? m[1] : u).replace(/^www\./i, '').replace(/\.+$/, '')
}

// Un mot avec « / » est-il un chemin ? Pas « 35/35 », « 11/11/2026 », « et/ou », « PC/iPhone » ni « @scope/paquet ».
// `large` (dans du `code`) : tout mot avec une lettre et une barre est un chemin.
function estChemin(c, large = false) {
  if (c.startsWith('@') || c.includes('://')) return false
  const segs = c.split('/').filter(Boolean)
  if (!segs.length || !segs.some((x) => /\p{L}/u.test(x))) return false
  if (large || /^(?:~|\.{1,2})?\//.test(c) || segs.length >= 3 || c.endsWith('/')) return true
  return EXTENSION.test(segs[segs.length - 1])
}

// Chemin → nom court ; « fichier.ext:123 » → « fichier.ext, ligne 123 ». Une empreinte dans le nom est retirée
// (« constructeur-c0000000a » → « constructeur ») ; un motif (« src/**/*.jsx », « {a,b}.tsx ») → « des fichiers ».
function nomCourt(c) {
  let ligne = ''
  const m = c.match(SUFFIXE_LIGNE)
  if (m) {
    const de = m[1] || m[4]
    const a = m[2] || m[5]
    const liste = m[3] ? [de, ...m[3].split(',').filter(Boolean)] : null
    ligne = liste
      ? `, lignes ${liste.slice(0, -1).join(', ')} et ${liste[liste.length - 1]}`
      : a && a !== de
        ? `, lignes ${de} à ${a}`
        : `, ligne ${de}`
    c = c.slice(0, m.index)
  }
  const nom = c.split(/[/\\]/).filter(Boolean).pop() || c
  if (/[{}*?,]/.test(nom)) return 'des fichiers' + ligne
  const parts = nom.split(/([^0-9A-Za-z]+)/)
  if (!parts.some(estHex)) return nom + ligne
  const net = parts
    .map((x) => (estHex(x) ? '' : x))
    .join('')
    .replace(/([-_.])[-_.]+/g, '$1')
    .replace(/^[-_]+|[-_.]+$/g, '')
  return (net || nom) + ligne
}

// `code en ligne` : un chemin → son nom court ; un code court se lit tel quel ; le reste → « du code ».
function codeEnLigne(c) {
  c = c.trim()
  if (!c) return ''
  if (!/\s/.test(c)) {
    if (ADRESSE.test(c)) return domaine(c)
    if (estHex(c) || PLAGE_COMMITS.test(c)) return ''
    if (COURRIEL.test(c) || NOM_FICHIER.test(c)) return c
    if (WINDOWS.test(c) || (c.includes('/') && estChemin(c, true)) || FICHIER_LIGNE.test(c)) return nomCourt(c)
  }
  const d = c
    .split(/(\s+)/)
    .map((m) => (ADRESSE.test(m) ? domaine(m) : m.includes('/') && estChemin(m, true) ? nomCourt(m) : m))
    .join('')
    .replace(/^<\/?([A-Za-z][\w.:-]*)[^<>]*>$/, '$1') // <Ecouter … /> → Ecouter
    .replace(/\(\)$/, '') // fetch() → fetch
    .replace(/(\d+) ?\/ ?(\d+)/g, '$1 sur $2')
  return d.length > 24 || CODE_PUR.test(d) ? 'du code' : d
}

// Un mot du texte (entouré de parenthèses, guillemets ou ponctuation) : adresse, chemin, nom de fichier, mot interminable,
// empreinte.
function mot(m, garde) {
  let a = 0
  let b = m.length
  while (a < b && AVANT.includes(m[a])) a++
  while (b > a && APRES.includes(m[b - 1])) b--
  const c = m.slice(a, b)
  if (!c) return m
  let r = c
  if (ADRESSE.test(c) || DOMAINE_NU.test(c)) r = garde(domaine(c))
  else if (COURRIEL.test(c)) r = garde(c)
  else if (WINDOWS.test(c) || (c.includes('/') && estChemin(c)) || FICHIER_LIGNE.test(c)) r = garde(nomCourt(c))
  else if (NOM_FICHIER.test(c)) r = garde(c)
  else if (c.length > 30 || estHex(c) || PLAGE_COMMITS.test(c)) r = ''
  return r === c ? m : m.slice(0, a) + r + m.slice(b)
}
const mots = (s, garde) =>
  s
    .split(/(\s+)/)
    .map((m) => (!m.trim() || m.includes(G0) ? m : mot(m, garde)))
    .join('')

// Signes qui se disent mal : flèches, points médians, ×, ≥, ≤, ~, &, N/M, #N, barres verticales, pictogrammes.
function symboles(s, garde) {
  return s
    .replace(FLECHE, ', ')
    .replace(POINT_MILIEU, ', ')
    .replace(/(\d) ?[×✕✖] ?(?=\d)/g, '$1 fois ')
    .replace(/(\d) ?×/g, '$1 fois')
    .replace(/× ?(?=\d)/g, 'fois ')
    .replace(/[×✕✖]/g, ' ')
    .replace(/≥ ?/g, 'au moins ')
    .replace(/≤ ?/g, 'au plus ')
    .replace(/≈ ?/g, 'environ ')
    .replace(/≠ ?/g, 'différent de ')
    .replace(/± ?/g, 'plus ou moins ')
    .replace(/~ ?(?=\d)/g, 'environ ')
    .replace(/ ?&+ ?/g, ' et ')
    .replace(/#(?=\d)/g, 'numéro ')
    .replace(/\s*\|\s*/g, ', ')
    .replace(DATE, (d) => garde(d))
    .replace(LE_DATE, (x, avant, d) => avant + garde(d))
    .replace(/(\d+) ?\/ ?(\d+)/g, '$1 sur $2')
    .replace(PICTO, ' ')
}

// Une ligne de texte (sans sa marque de titre, de puce ou de citation) prête à dire.
function enLigne(l) {
  const gardes = []
  const garde = (v) => {
    gardes.push(v)
    return G0 + (gardes.length - 1) + G1
  }
  let s = l
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (x, e) => ENTITES[e])
    .replace(CODE, (x, c) => garde(codeEnLigne(c)))
    .replace(LIEN, (x, texte, href) => texte.trim() || (href ? garde(ADRESSE.test(href) ? domaine(href) : nomCourt(href)) : ''))
    .replace(LIEN_REF, '$1')
    .replace(AUTOLIEN, '$1')
    .replace(BALISE, ' ')
    .replace(GRAS, '$1')
    .replace(GRAS_SOULIGNE, '$1$2')
    .replace(ITALIQUE, '$1$2')
    .replace(ITALIQUE_SOULIGNE, '$1$2')
    .replace(BARRE, '$1')
  s = symboles(mots(s, garde), garde)
    .replace(/[`*~^\\{}]/g, '')
    .replace(/(^|\s)_+(?=\s|$)/g, '$1')
    .replace(GARDE, (x, n) => gardes[n])
  return finition(s)
}

// Dernier passage sur ce qui sera dit : restes de marques, signes laissés par un code court, espaces et ponctuation
// orpheline (« ( ) », « , , », « , . »).
function finition(s) {
  return s
    .replace(FLECHE, ', ')
    .replace(PICTO, ' ')
    .replace(/`+|\*\*/g, '')
    .replace(/\s*\|\s*/g, ', ')
    .replace(/[\s\u00A0\u202F]+/g, ' ')
    .replace(/\(\s*[,;:.]*\s*\)|\[\s*\]/g, '')
    .replace(/\s+,/g, ',')
    .replace(/\s+\.(?=\s|$)/g, '.')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/[,;]\s*(?=[.!?…:])/g, '')
    .replace(/«\s*»|“\s*”/g, '')
    .replace(/^[\s,;:/»”)\]]+/, '')
    .replace(/^#+\s*/, '')
    .trim()
}

// Découpe en phrases sur . ! ? … suivis d'une espace ; pas après « M. », « cf. », « e.g. », ni devant une minuscule.
function decoupe(s) {
  const out = []
  let debut = 0
  FIN_PHRASE.lastIndex = 0
  let m
  while ((m = FIN_PHRASE.exec(s))) {
    const fin = m.index + m[0].length
    let i = m.index
    while (i > debut && i > m.index - 40 && !/\s/.test(s[i - 1])) i--
    const avant = s.slice(i, m.index).replace(/^[(«"“'‘[]+/, '')
    let j = fin
    while (j < s.length && /\s/.test(s[j])) j++
    const suivant = s[j] || ''
    const garde =
      m[0] === '.' &&
      (SANS_COUPE.has(avant.toLowerCase()) || /^\p{Lu}$/u.test(avant) || /^(?:\p{L}\.)+\p{L}$/u.test(avant) || /^\p{Ll}/u.test(suivant))
    if (garde) continue
    out.push(s.slice(debut, fin).trim())
    debut = fin
  }
  out.push(s.slice(debut).trim())
  return out.filter(Boolean)
}

// Phrase trop longue : coupée à la dernière virgule / point-virgule (assez loin du début), sinon à la dernière espace.
function coupeLongue(p) {
  const out = []
  while (p.length > LONGUE) {
    const f = p.slice(0, LONGUE + 1)
    const v = Math.max(f.lastIndexOf(', '), f.lastIndexOf('; '))
    const e = f.lastIndexOf(' ')
    const j = v >= 80 ? v + 1 : e > 0 ? e : LONGUE
    out.push(p.slice(0, j).trim())
    p = p.slice(j).trim()
  }
  if (p) out.push(p)
  return out
}

// Une unité (paragraphe, titre, élément de liste) → ses phrases.
const phrasesDe = (u) =>
  decoupe(u)
    .map((p) => ponctue(finition(p).replace(/[\s,;]+$/, '')))
    .filter((p, i, ps) => lisible(p) && !(ENUMERATION.test(p) && i < ps.length - 1)) // « B » seul reste une réponse
    .flatMap(coupeLongue)

export function pourLire(texte, { max = 420, phrasesMax = 5 } = {}) {
  const t = String(texte ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\uE000-\uF8FF]/g, '')
  // Réponse qui n'est qu'un objet JSON (verdict d'une revue Codex) : un bloc de code, pas lu.
  if (/^\s*[[{][\s\S]*[\]}]\s*$/.test(t)) {
    try {
      JSON.parse(t)
      return { phrases: [BLOC], coupe: false }
    } catch {}
  }
  // Blocs de code : même découpage que Texte dans Fil.jsx (tout « ``` » ouvre ou ferme un bloc). Un « ```x``` » sans
  // retour à la ligne se lit comme du `code` en ligne.
  const s = t
    .split('```')
    .map((m, i) => (i % 2 === 0 ? m : m.includes('\n') ? `\n\n${MARQUE_BLOC}\n\n` : '`' + m + '`'))
    .join('')
  // Phrases gardées dans l'ordre tant que le total ≤ max et leur nombre ≤ phrasesMax (au moins une) ; des blocs de
  // code qui se suivent (rien de lisible entre eux) ne font qu'une mention.
  const phrases = []
  let total = 0
  let coupe = false
  const dit = (p) => {
    if (coupe) return
    const n = phrases.length
    if (p === BLOC && (phrases[n - 1] === BLOC || phrases[n - 1] === BLOCS)) {
      total += BLOCS.length - phrases[n - 1].length
      phrases[n - 1] = BLOCS
    } else if (n && (n >= phrasesMax || total + p.length > max)) coupe = true
    else {
      phrases.push(p)
      total += p.length
    }
  }
  const unite = (u) => {
    if (u === MARQUE_BLOC) return dit(BLOC)
    if (u === TABLEAU) return dit(TABLEAU)
    for (const p of phrasesDe(u)) dit(p)
  }
  // Lignes d'un même paragraphe : une ligne qui finit par « , ; : » se poursuit sur la suivante ; sinon la phrase finit.
  let tampon = ''
  const vide = () => {
    if (tampon) unite(tampon)
    tampon = ''
  }
  const ls = s.split('\n')
  for (let i = 0; i < ls.length && !coupe; i++) {
    let l = ls[i]
    if (!l.trim()) {
      vide()
      continue
    }
    if (l.trim() === MARQUE_BLOC) {
      vide()
      unite(MARQUE_BLOC)
      continue
    }
    // Tableau : en-tête puis ligne de séparation, ou lignes qui commencent par « | ».
    const sep = ls[i + 1] !== undefined && ls[i + 1].includes('|') && ls[i + 1].includes('-') && SEPARATION.test(ls[i + 1])
    const barre = (x) => x.trim().startsWith('|') && x.split('|').length > 2
    if ((l.includes('|') && sep) || barre(l)) {
      vide()
      if (sep) {
        i += 2
        while (i < ls.length && ls[i].trim() && ls[i].includes('|')) i++
      } else while (i < ls.length && barre(ls[i])) i++
      i--
      unite(TABLEAU)
      continue
    }
    l = l.replace(CITATION, '')
    if (!l.trim() || FILET.test(l) || SOULIGNE.test(l)) {
      vide()
      continue
    }
    let m
    if ((m = l.match(TITRE))) {
      vide()
      unite(enLigne(m[1].replace(/^\d{1,3}[.)]\s+/, '')))
      continue
    }
    if ((m = l.match(PUCE))) {
      vide()
      unite(enLigne(l.slice(m[0].length).replace(/^(?:\d{1,3}|[A-Za-z])[.)]\s+/, ''))) // sous-liste « - a. … »
      continue
    }
    const c = enLigne(l)
    if (!c) continue
    tampon = tampon ? tampon + ' ' + c : c
    if (!/[,;:]$/.test(c)) vide()
  }
  if (!coupe) vide()
  if (coupe) phrases.push(SUITE)
  return { phrases, coupe }
}

// Nom de console lisible à voix haute : « Claude · site » → « Claude, site » ; émojis et symboles retirés.
export function nomLisible(nom) {
  const s = String(nom ?? '')
    .replace(FLECHE, ', ')
    .replace(POINT_MILIEU, ', ')
    .replace(/\s*\|\s*/g, ', ')
    .replace(PICTO, ' ')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
  return s || 'La console'
}
