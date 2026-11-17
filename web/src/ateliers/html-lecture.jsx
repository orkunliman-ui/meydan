// Ateliers (volet du 13/11) : lecture d'un document HTML au téléphone, sans cadre web. Le HTML est lu par DOMParser
// (document inerte : rien n'y est chargé ni exécuté) puis rendu en éléments React par LISTE BLANCHE ; jamais de HTML
// injecté (aucune propriété ni méthode qui insère du HTML brut). Seuls attributs gardés : l'adresse http(s) d'un lien
// (ouvert dans un nouvel onglet, sans « opener ») et colspan / rowspan (entiers de 1 à 50) des cellules.
// Retirés avec leur contenu : scripts, styles, cadres, objets, médias, formulaires, SVG, MathML, <head> ; une image
// devient « [image : texte alternatif] » ; une balise inconnue laisse ses enfants. Parcours borné : 40 niveaux,
// 20 000 nœuds ; au-delà, la suite n'est pas montrée et le rendu le dit.
import { useMemo } from 'react'

const PROF_MAX = 40
const NOEUDS_MAX = 20000
const liste = (s) => new Set(s.split(' '))
const GARDEES = liste(
  'h1 h2 h3 h4 h5 h6 p br hr ul ol li blockquote pre code strong b em i u s del mark sub sup table thead tbody tfoot tr th td caption dl dt dd figure figcaption div section article header footer main nav aside span details summary a',
)
const RETIREES = liste(
  'script style template noscript iframe object embed img svg math form input button select textarea link meta base video audio canvas head title frame frameset',
)
const VIDES = liste('br hr')
const SANS_TEXTE_BLANC = liste('table thead tbody tfoot tr ul ol dl') // un blanc entre leurs enfants n'est pas du contenu
const BLOCS = liste(
  'h1 h2 h3 h4 h5 h6 p br hr ul ol li blockquote pre table thead tbody tfoot tr caption dl dt dd figure figcaption div section article header footer main nav aside details summary',
)
const ADRESSE = /^https?:\/\/[^/?#\s]/i

// colspan / rowspan : entier de 1 à 50, sinon rien.
function portee(v) {
  if (!/^\s*\d{1,2}\s*$/.test(v || '')) return 0
  const n = parseInt(v, 10)
  return n >= 1 && n <= 50 ? n : 0
}

// Les enfants filtrés d'un nœud du DOM → [texte | { tag, enfants, href?, colSpan?, rowSpan? }]. Lit seulement
// nodeType, localName, childNodes, nodeValue et getAttribute (jamais `a.href`, qui résoudrait une adresse relative).
function filtre(parent, prof, budget, tagParent) {
  const out = []
  const enfants = parent.childNodes || []
  for (let k = 0; k < enfants.length; k++) {
    if (budget.reste <= 0) {
      budget.coupe = true
      break
    }
    budget.reste--
    const n = enfants[k]
    if (n.nodeType === 3) {
      const t = n.nodeValue || ''
      if (t && !(SANS_TEXTE_BLANC.has(tagParent) && !t.trim())) out.push(t)
      continue
    }
    if (n.nodeType !== 1) continue // commentaires, instructions…
    // Un <form> peut masquer ses propriétés par ses champs nommés (<input name="localName">) : un nom qui n'est pas
    // une chaîne fait jeter le nœud avec son contenu.
    if (typeof n.localName !== 'string') continue
    const tag = n.localName.toLowerCase()
    if (tag === 'img') {
      const alt = String(n.getAttribute('alt') || '').trim()
      if (alt) out.push(`[image : ${alt}]`)
      continue
    }
    if (RETIREES.has(tag)) continue
    if (prof >= PROF_MAX) {
      budget.coupe = true
      continue
    }
    const sous = VIDES.has(tag) ? [] : filtre(n, prof + 1, budget, tag)
    if (!GARDEES.has(tag)) {
      for (const s of sous) out.push(s) // balise inconnue : ses enfants seuls
      continue
    }
    if (tag === 'a') {
      const href = String(n.getAttribute('href') || '')
      if (ADRESSE.test(href)) out.push({ tag, enfants: sous, href })
      else {
        const t = texteDe(sous).join('') // lien refusé : son texte seul
        if (t) out.push(t)
      }
      continue
    }
    const el = { tag, enfants: sous }
    if (tag === 'td' || tag === 'th') {
      const c = portee(n.getAttribute('colspan'))
      const r = portee(n.getAttribute('rowspan'))
      if (c) el.colSpan = c
      if (r) el.rowSpan = r
    }
    out.push(el)
  }
  return out
}

// Texte d'un arbre filtré : les blancs d'un texte valent une espace (comme à l'écran), retour à la ligne après un bloc,
// espace après une cellule.
function texteDe(items, out = []) {
  for (const it of items) {
    if (typeof it === 'string') {
      out.push(it.replace(/\s+/g, ' '))
      continue
    }
    texteDe(it.enfants, out)
    if (BLOCS.has(it.tag)) out.push('\n')
    else if (it.tag === 'td' || it.tag === 'th') out.push(' ')
  }
  return out
}

// Racine d'un document (DOM ou équivalent) → { items, coupe } : l'arbre filtré, et s'il a fallu couper.
export function filtreDocument(racine) {
  const budget = { reste: NOEUDS_MAX, coupe: false }
  const items = racine ? filtre(racine, 0, budget, 'body') : []
  return { items, coupe: budget.coupe }
}

function lis(html) {
  if (typeof DOMParser === 'undefined') return { items: [], coupe: false }
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html')
  return filtreDocument(doc.body)
}

function rendu(items) {
  return items.map((it, k) => {
    if (typeof it === 'string') return it
    const T = it.tag
    if (VIDES.has(T)) return <T key={k} /> // br, hr : aucun enfant (React refuse même une liste vide)
    if (T === 'a')
      return (
        <a key={k} href={it.href} target="_blank" rel="noopener noreferrer">
          {rendu(it.enfants)}
        </a>
      )
    return (
      <T key={k} colSpan={it.colSpan} rowSpan={it.rowSpan}>
        {rendu(it.enfants)}
      </T>
    )
  })
}

// Le texte brut d'un document HTML (pour la recherche) : même filtre que le rendu, donc sans scripts ni styles.
export function texteDuHtml(html) {
  return texteDe(lis(html).items)
    .join('')
    .replace(/ *\n\s*/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim()
}

export function HtmlLecture({ html }) {
  const { items, coupe } = useMemo(() => lis(html), [html])
  return (
    <div className="at-html">
      {rendu(items)}
      {coupe && <p className="at-html-coupe">… la suite du document n'est pas montrée (trop longue ou trop imbriquée)</p>}
    </div>
  )
}
