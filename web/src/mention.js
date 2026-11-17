// Les @mentions de la barre d'ordres (volet « ordres », 13/11 ; Orkun : « On est encore loin de toutes les
// fonctionnalitēs de Symvibe »). « @site relis le README » = « dis à site : relis le README ».
// Pur : ni React, ni navigateur, ni Node. Importé par l'écran (web/src/Ordre.jsx, complétion) ET par le serveur
// (lib/ordres.mjs, compréhension de l'ordre) : les deux calculent les mêmes slugs à partir de la même liste de consoles.

// Sans accents, en minuscules. Même longueur que le texte d'origine en forme NFC : une position trouvée dans l'un vaut
// pour l'autre (lib/ordres.mjs s'en sert). Les diacritiques combinants (U+0300 à U+036F) sont construits par
// `fromCharCode` : aucun caractère invisible ni échappement dans ce fichier (leçons 138 et 167).
const ACCENTS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g')
export const plat = (s) => String(s ?? '').normalize('NFD').replace(ACCENTS, '').toLowerCase()

const MAX_SLUG = 32
const bords = (s) => s.replace(/^-+|-+$/g, '')
// « Claude · Page contact » → « claude-page-contact » (32 caractères au plus, jamais de « - » aux bords).
export const slug = (nom) => bords(bords(plat(nom).replace(/[^a-z0-9]+/g, '-')).slice(0, MAX_SLUG))

// Une mention par console : { id, nom, slug, kind, status }, dans l'ordre de la liste. Le slug vient du nom (repli : le
// type, puis « console »). Deux consoles au même slug le perdent TOUTES LES DEUX au profit de `slug-<4 derniers
// caractères de l'id>` : aucune n'est préférée en silence ; « @slug » nu ne désigne alors plus une console précise et
// lib/ordres.mjs le lit comme un morceau de nom (les deux). Suffixe compris, 32 caractères au plus.
export function mentions(consoles = []) {
  const base = consoles.map((c) => slug(c.name) || slug(c.kind) || 'console')
  const n = new Map()
  for (const b of base) n.set(b, (n.get(b) || 0) + 1)
  const pris = new Set(base.filter((b) => n.get(b) === 1))
  return consoles.map((c, i) => {
    let s = base[i]
    if (n.get(s) > 1) {
      const fin = slug(String(c.id ?? '')).replace(/-/g, '').slice(-4) || String(i)
      s = `${bords(s.slice(0, MAX_SLUG - fin.length - 1))}-${fin}`
      for (let k = 2; pris.has(s); k++) s = `${bords(base[i].slice(0, MAX_SLUG - fin.length - 2 - String(k).length))}-${fin}-${k}`
    }
    pris.add(s)
    return { id: c.id, nom: c.name, slug: s, kind: c.kind, status: c.status }
  })
}

// La mention en cours de frappe juste avant le curseur : { debut (position du « @ »), requete } ou null. Un « @ » collé
// à un mot (« a@b », une adresse) n'en est pas une.
export function mentionEnCours(texte = '', curseur = texte.length) {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(String(texte).slice(0, curseur))
  return m ? { debut: curseur - m[1].length - 1, requete: m[1] } : null
}

// Les mentions qui répondent à la requête (slug ou nom, sans accents) : celles dont le slug COMMENCE par la requête
// d'abord, puis les autres, chacune dans l'ordre de la liste.
export function filtre(liste = [], requete = '') {
  const q = plat(requete)
  if (!q) return liste.slice()
  const debut = [], dedans = []
  for (const m of liste) {
    if (m.slug.startsWith(q)) debut.push(m)
    else if (m.slug.includes(q) || plat(m.nom).includes(q)) dedans.push(m)
  }
  return [...debut, ...dedans]
}

// Pose « @slug » à la place de la mention entamée (le mot entier, même si le curseur est au milieu), sinon au curseur.
// `mention` : un objet de `mentions()` ou le slug seul. Rend { texte, curseur } (curseur juste après « @slug »).
export function insere(texte = '', curseur = texte.length, mention) {
  const s = typeof mention === 'string' ? mention.replace(/^@/, '') : mention?.slug
  if (!s) return { texte, curseur }
  const en = mentionEnCours(texte, curseur)
  let debut = curseur, fin = curseur, avant = ''
  if (en) {
    debut = en.debut
    fin += /^[^\s@]*/.exec(texte.slice(curseur))[0].length
  } else if (curseur > 0 && !/\s/.test(texte[curseur - 1])) avant = ' '
  const mot = `${avant}@${s} `
  return { texte: texte.slice(0, debut) + mot + texte.slice(fin).replace(/^ /, ''), curseur: debut + mot.length }
}
