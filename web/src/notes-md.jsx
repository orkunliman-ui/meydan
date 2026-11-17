// Le Markdown d'une carte « note » du plateau étendu (volet du 11/11), rendu en éléments React : jamais de HTML injecté
// (ni dangerouslySetInnerHTML ni innerHTML) ; un texte qui ressemble à une balise reste du texte. Les liens ne sont faits
// que pour http(s) : tout autre schéma (javascript:, data:, file:…) reste écrit tel quel, sans lien.
// Compris : titres (# à ######), paragraphes, listes à puces ou numérotées (imbriquées), listes de tâches (- [ ] / - [x]),
// citations (>), filets (---), blocs de code (``` ou ~~~) ; dans une ligne : **gras**, *italique*, ~~barré~~, `code`,
// [lien](https://…), <https://…> et adresses nues. Ni tableau, ni image, ni HTML.
// Ateliers (volet du 13/11) : trois options, absentes pour les notes (rendu inchangé) — `tableaux` (tableaux GFM),
// `lien(cible, genre, contenu)` (liens internes d'un coffre : [[Nom]], [[Nom|texte]] et liens relatifs vers un .md, rendus
// par l'appelant) et `bloc(langage, code)` (un bloc de code dessiné par l'appelant, ex. ```mermaid ; null = du code).
// Écrit à part du Chat (Fil.jsx est lié aux fichiers d'une console), avec ses règles : pas de « lookbehind » dans les
// expressions (d'anciens Safari ne les liraient pas). Relu à chaque frappe sur 40 000 caractères au plus : le texte est
// parcouru à la main, sans expression à retour arrière coûteux, et l'imbrication est bornée (PROF_MAX).
import { cloneElement, memo } from 'react'
import { cls } from './lib.js'

const PROF_MAX = 8 // citations, listes et gras imbriqués : au-delà, le reste est du texte simple

const CLOTURE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const TITRE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const FILET = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const CITATION = /^ {0,3}>/
const PUCE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/
const TACHE = /^\[([ xX])\](?:[ \t]+(.*))?$/
const PONCT = /[!-/:-@[-`{-~]/ // ponctuation ASCII : ce qu'un « \ » rend littéral
const MOT = /[\p{L}\p{N}]/u
const ESPACE = /\s/

// Une ouverture de bloc de code (```js, ~~~) ; avec des accents graves, l'information qui suit n'en contient aucun.
const ouvreCode = (t) => {
  const m = CLOTURE.exec(t)
  return m && !(m[1][0] === '`' && m[2].includes('`')) ? m[1] : ''
}
const fermeCode = (t, f) => {
  const s = t.trim()
  return s.length >= f.length && s === f[0].repeat(s.length)
}
// Retrait d'une ligne en colonnes (tabulation = 4) ; retire au plus `w` colonnes du début.
const largeur = (s) => {
  let w = 0
  for (const c of s) {
    if (c === ' ') w++
    else if (c === '\t') w += 4 - (w % 4)
    else break
  }
  return w
}
const deretire = (s, w) => {
  let i = 0
  let c = 0
  while (i < s.length && c < w && (s[i] === ' ' || s[i] === '\t')) {
    c += s[i] === '\t' ? 4 - (c % 4) : 1
    i++
  }
  return s.slice(i)
}
// « ## Titre ## » → « Titre » (les dièses de fin ne sont retirés que s'ils sont détachés du texte).
const sansDieses = (s) => {
  const t = s.trimEnd()
  let j = t.length
  while (j > 0 && t[j - 1] === '#') j--
  return j < t.length && (j === 0 || t[j - 1] === ' ' || t[j - 1] === '\t') ? t.slice(0, j).trimEnd() : t
}
const lignesDe = (texte) => texte.split(/\r\n|\r|\n/)
// Une puce qui coupe un paragraphe : une puce suivie de texte, ou une liste numérotée qui commence à 1 (« né en\n1990. »
// reste une phrase).
const coupeParagraphe = (t) => {
  if (ouvreCode(t) || TITRE.test(t) || FILET.test(t) || CITATION.test(t)) return true
  const m = PUCE.exec(t)
  return !!(m && m[3]?.trim() && (!/^\d/.test(m[2]) || parseInt(m[2], 10) === 1))
}

// Le titre d'une note : son premier titre (#…), sans la mise en forme ; '' s'il n'y en a pas.
export function premierTitre(texte) {
  let code = ''
  for (const l of lignesDe(texte || '')) {
    if (code) {
      if (fermeCode(l, code)) code = ''
      continue
    }
    code = ouvreCode(l)
    if (code) continue
    const m = TITRE.exec(l)
    if (!m) continue
    const t = sansDieses(m[2] || '')
      .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')
      .replace(/\\([!-/:-@[-`{-~])/g, '$1')
      .replace(/[*`]|~~/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (t) return t.slice(0, 80)
  }
  return ''
}

// Coche ou décoche la tâche de la ligne `n` (numéro de ligne du texte source) ; rend le texte tel quel sinon.
export function basculeTache(texte, n) {
  const lignes = lignesDe(texte)
  const l = lignes[n]
  if (l === undefined) return texte
  const neuve = l.replace(/^((?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)+)\[([ xX])\]/, (_, avant, c) => `${avant}[${c === ' ' ? 'x' : ' '}]`)
  if (neuve === l) return texte
  lignes[n] = neuve
  return lignes.join('\n')
}

// ── Dans une ligne ──
// `o` : { statique (plateau du téléphone : ni lien actif ni case à cocher), onTache }. Le texte est parcouru une fois ;
// chaque recherche de fermeture passe par `prochain`, qui retient la position trouvée (pas de recherche quadratique sur
// une suite d'ouvertures sans fermeture).
function enLigne(s, prof, o, dansLien = false) {
  if (prof > PROF_MAX) return avecRetours(s, 0)
  const out = []
  let texte = ''
  const vide = () => {
    if (texte) out.push(...avecRetours(texte, out.length))
    texte = ''
  }
  const pousse = (el) => {
    vide()
    out.push(cloneElement(el, { key: String(out.length) }))
  }
  const cache = new Map()
  const prochain = (c, depuis) => {
    const v = cache.get(c)
    if (v !== undefined && (v < 0 || v >= depuis)) return v
    const p = s.indexOf(c, depuis)
    cache.set(c, p)
    return p
  }
  // Une suite d'exactement `n` caractères `c` à partir de `depuis`, collée au texte qui la précède (et, pour « _ »,
  // pas suivie d'une lettre : snake_case reste du texte).
  const fermeture = (c, n, depuis) => {
    let j = prochain(c, depuis)
    while (j >= 0) {
      let e = j
      while (s[e] === c) e++
      if (e - j === n && j > depuis && !ESPACE.test(s[j - 1]) && (c !== '_' || !MOT.test(s[e] ?? ' '))) return j
      j = prochain(c, e)
    }
    return -1
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length && PONCT.test(s[i + 1])) {
      texte += s[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      let r = 1
      while (s[i + r] === '`') r++
      let j = prochain('`', i + r)
      while (j >= 0) {
        let e = j
        while (s[e] === '`') e++
        if (e - j === r) break
        j = prochain('`', e)
      }
      if (j < 0) {
        texte += s.slice(i, i + r)
        i += r
        continue
      }
      let code = s.slice(i + r, j).replace(/\n/g, ' ')
      if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1)
      pousse(<code>{code}</code>)
      i = j + r
      continue
    }
    if (c === '[' && !dansLien && o.lien && s[i + 1] === '[') {
      const re = /\[\[([^\[\]\n]{1,200})\]\]/y
      re.lastIndex = i
      const m = re.exec(s)
      if (m) {
        const [cible, alias] = m[1].split('|')
        const vue = (alias ?? cible).trim() || cible.trim()
        pousse(o.lien(cible.split('#')[0].trim(), 'wiki', vue))
        i += m[0].length
        continue
      }
    }
    if (c === '[' && !dansLien) {
      const lien = lienA(s, i, prochain, !!o.lien)
      if (lien) {
        const nom = lien.nom.trim() ? enLigne(lien.nom, prof + 1, o, true) : lien.url
        if (lien.interne) pousse(o.lien(lien.url, 'md', nom))
        else pousse(o.statique ? <span className="et-note-lien">{nom}</span> : <a href={lien.url} target="_blank" rel="noopener noreferrer">{nom}</a>)
        i = lien.fin
        continue
      }
    }
    if (c === '<' && !dansLien) {
      const re = /<(https?:\/\/[^\s<>]+)>/iy
      re.lastIndex = i
      const m = re.exec(s)
      if (m) {
        pousse(o.statique ? <span className="et-note-lien">{m[1]}</span> : <a href={m[1]} target="_blank" rel="noopener noreferrer">{m[1]}</a>)
        i += m[0].length
        continue
      }
    }
    if ((c === 'h' || c === 'H') && !dansLien && (i === 0 || !MOT.test(s[i - 1]))) {
      const re = /https?:\/\/[^\s<>]+/iy
      re.lastIndex = i
      const m = re.exec(s)
      if (m) {
        let url = m[0]
        // La ponctuation qui suit une adresse dans une phrase n'en fait pas partie ; une parenthèse fermante non ouverte
        // dans l'adresse non plus (« (voir https://exemple.be) »).
        const ouvertes = url.split('(').length - 1
        let fermees = url.split(')').length - 1
        for (;;) {
          const d = url[url.length - 1]
          if ('.,;:!?»"\'’*_~'.includes(d)) url = url.slice(0, -1)
          else if (d === ')' && ouvertes < fermees) {
            url = url.slice(0, -1)
            fermees--
          } else break
        }
        if (/^https?:\/\/[^/?#\s]/i.test(url)) {
          pousse(o.statique ? <span className="et-note-lien">{url}</span> : <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>)
          i += url.length
          continue
        }
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      let r = 1
      while (s[i + r] === c) r++
      const avant = i > 0 ? s[i - 1] : ' '
      const apres = s[i + r] ?? ' '
      const ouvre = !ESPACE.test(apres) && (c !== '_' || !MOT.test(avant)) && (c === '~' ? r === 2 : r <= 3)
      const j = ouvre ? fermeture(c, r, i + r) : -1
      if (j >= 0) {
        const dedans = enLigne(s.slice(i + r, j), prof + 1, o, dansLien)
        pousse(c === '~' ? <del>{dedans}</del> : r === 1 ? <em>{dedans}</em> : r === 2 ? <strong>{dedans}</strong> : <strong><em>{dedans}</em></strong>)
        i = j + r
        continue
      }
      texte += s.slice(i, i + r)
      i += r
      continue
    }
    texte += c
    i++
  }
  vide()
  return out
}

// Les retours à la ligne d'un paragraphe sont gardés (comme dans le Chat) : une note se lit comme elle a été écrite.
function avecRetours(t, base) {
  const out = []
  t.split('\n').forEach((morceau, k) => {
    if (k) out.push(<br key={`br${base}-${k}`} />)
    if (morceau) out.push(morceau)
  })
  return out
}

// [nom](https://… "titre facultatif") à la position `i` → { nom, url, fin } ; null si ce n'est pas un lien http(s).
// `interne` (ateliers) : un lien relatif vers un .md est rendu aussi, marqué `interne` (aucun schéma, pas de « / » au début).
function lienA(s, i, prochain, interne = false) {
  const j = prochain(']', i + 1)
  if (j < 0 || s[j + 1] !== '(') return null
  let k = j + 2
  let prof = 0
  while (k < s.length && !ESPACE.test(s[k])) {
    if (s[k] === '(') prof++
    else if (s[k] === ')') {
      if (!prof) break
      prof--
    }
    k++
  }
  const url = s.slice(j + 2, k)
  if (s[k] !== ')') {
    // un titre entre guillemets après l'adresse, puis « ) »
    const m = /[ \t]+"[^"\n]*"[ \t]*\)/y
    m.lastIndex = k
    const t = m.exec(s)
    if (!t) return null
    k += t[0].length - 1
  }
  if (!/^https?:\/\/[^/?#\s]/i.test(url)) {
    if (interne && /\.md(#[^\s]*)?$/i.test(url) && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('/')) return { nom: s.slice(i + 1, j), url, fin: k + 1, interne: true }
    return null
  }
  return { nom: s.slice(i + 1, j), url, fin: k + 1 }
}

// ── Les blocs ──
// `L` : les lignes, chacune avec son numéro dans le texte source (`n`) : une tâche cochée retrouve sa ligne, et un
// double-clic place le curseur au début du bloc touché (data-l).
function blocs(L, prof, o) {
  const out = []
  let i = 0
  while (i < L.length) {
    const { t, n } = L[i]
    if (!t.trim()) {
      i++
      continue
    }
    const f = ouvreCode(t)
    if (f) {
      const code = []
      i++
      while (i < L.length && !fermeCode(L[i].t, f)) code.push(L[i++].t)
      i++ // la clôture (ou la fin du texte)
      const dessin = o.bloc ? o.bloc((CLOTURE.exec(t)[2] || '').trim().split(/\s+/)[0].toLowerCase(), code.join('\n')) : null
      if (dessin) {
        out.push(
          <div key={n} data-l={n} className="et-note-bloc">
            {dessin}
          </div>,
        )
        continue
      }
      out.push(
        <pre key={n} data-l={n}>
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }
    let m = TITRE.exec(t)
    if (m) {
      const H = `h${m[1].length}`
      out.push(
        <H key={n} data-l={n}>
          {enLigne(sansDieses(m[2] || ''), prof, o)}
        </H>,
      )
      i++
      continue
    }
    if (FILET.test(t)) {
      out.push(<hr key={n} data-l={n} />)
      i++
      continue
    }
    if (CITATION.test(t)) {
      const dedans = []
      while (i < L.length && CITATION.test(L[i].t)) {
        dedans.push({ t: L[i].t.replace(/^ {0,3}> ?/, ''), n: L[i].n })
        i++
      }
      out.push(
        <blockquote key={n} data-l={n}>
          {prof < PROF_MAX ? blocs(dedans, prof + 1, o) : <p>{avecRetours(dedans.map((l) => l.t).join('\n'), 0)}</p>}
        </blockquote>,
      )
      continue
    }
    if (PUCE.test(t)) {
      i = liste(L, i, prof, o, out)
      continue
    }
    if (o.tableaux && i + 1 < L.length && t.includes('|')) {
      const fin = tableau(L, i, prof, o, out)
      if (fin > i) {
        i = fin
        continue
      }
    }
    const lignes = [t.trim()]
    i++
    while (i < L.length && L[i].t.trim() && !coupeParagraphe(L[i].t)) lignes.push(L[i++].t.trim())
    out.push(
      <p key={n} data-l={n}>
        {enLigne(lignes.join('\n'), prof, o)}
      </p>,
    )
  }
  return out
}

// Une liste (et ses sous-listes), à partir de la ligne `i` ; rend la ligne qui suit la liste.
function liste(L, i, prof, o, out) {
  const m0 = PUCE.exec(L[i].t)
  const numerotee = /^\d/.test(m0[2])
  const signe = numerotee ? m0[2].slice(-1) : m0[2] // une autre puce (ou « 1) » après « 1. ») commence une autre liste
  const base = largeur(m0[1])
  const debut = L[i].n
  const items = []
  while (i < L.length) {
    const m = PUCE.exec(L[i].t)
    if (!m || FILET.test(L[i].t) || largeur(m[1]) > base + 1 || /^\d/.test(m[2]) !== numerotee || (numerotee ? m[2].slice(-1) : m[2]) !== signe) break
    // L'élément : sa première ligne, puis ce qui est en retrait (sous-listes, paragraphes), ou la suite d'une phrase.
    const retrait = largeur(m[1]) + m[2].length + 1
    const contenu = [{ t: m[3] ?? '', n: L[i].n }]
    i++
    while (i < L.length) {
      const s = L[i].t
      if (!s.trim()) {
        let j = i
        while (j < L.length && !L[j].t.trim()) j++
        if (j < L.length && largeur(L[j].t) >= retrait) {
          for (; i < j; i++) contenu.push({ t: '', n: L[i].n })
          continue
        }
        i = j
        break
      }
      const r = largeur(s)
      if (r >= retrait || (r > base + 1 && PUCE.test(s))) {
        contenu.push({ t: deretire(s, retrait), n: L[i].n })
        i++
        continue
      }
      if (contenu[contenu.length - 1].t.trim() && !coupeParagraphe(s) && !PUCE.test(s)) {
        contenu.push({ t: s, n: L[i].n })
        i++
        continue
      }
      break
    }
    const n = contenu[0].n
    const tache = TACHE.exec(contenu[0].t)
    if (tache) contenu[0] = { t: tache[2] ?? '', n }
    const corps = prof < PROF_MAX ? blocs(contenu, prof + 1, o) : <p>{avecRetours(contenu.map((l) => l.t).join('\n'), 0)}</p>
    if (!tache) {
      items.push(
        <li key={n} data-l={n}>
          {corps}
        </li>,
      )
      continue
    }
    const coche = tache[1] !== ' '
    items.push(
      <li key={n} data-l={n} className={cls('et-note-tache', coche && 'est-faite')}>
        {o.statique || !o.onTache ? (
          <span className={cls('et-note-case', coche && 'est-cochee')} role="img" aria-label={coche ? 'fait' : 'à faire'} />
        ) : (
          <input type="checkbox" className="et-note-case" checked={coche} onChange={() => o.onTache(n)} aria-label={coche ? 'Décocher la tâche' : 'Cocher la tâche'} />
        )}
        <div className="et-note-tache-texte">{corps}</div>
      </li>,
    )
  }
  out.push(
    numerotee ? (
      <ol key={debut} data-l={debut} start={parseInt(m0[2], 10)}>
        {items}
      </ol>
    ) : (
      <ul key={debut} data-l={debut}>
        {items}
      </ul>
    ),
  )
  return i
}

// ── Tableaux GFM (option `tableaux`, ateliers) ──
// Les cellules d'une ligne « | a | b | » : bords retirés, « | » échappé (\|) ou dans du `code` gardé dans la cellule.
function cellules(t) {
  let s = t.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const out = []
  let cur = ''
  let code = false
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === '\\' && s[k + 1] === '|') {
      cur += '|'
      k++
    } else if (c === '`') {
      code = !code
      cur += c
    } else if (c === '|' && !code) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  out.push(cur.trim())
  return out
}
const SEPARATION = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
// Rend l'indice de la ligne qui suit le tableau, ou `i` si ce n'en est pas un (en-tête + ligne de séparation de même largeur).
function tableau(L, i, prof, o, out) {
  const sep = L[i + 1].t
  if (!SEPARATION.test(sep) || !sep.includes('-')) return i
  const tete = cellules(L[i].t)
  const aligne = cellules(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined))
  if (aligne.length !== tete.length || (tete.length < 2 && !L[i].t.includes('|'))) return i
  const n = L[i].n
  const lignes = []
  let j = i + 2
  while (j < L.length && L[j].t.trim() && L[j].t.includes('|') && lignes.length < 5000) lignes.push(cellules(L[j++].t))
  const cellule = (Tag, v, k) => (
    <Tag key={k} style={aligne[k] ? { textAlign: aligne[k] } : undefined}>
      {enLigne(v ?? '', prof + 1, o)}
    </Tag>
  )
  out.push(
    <div key={n} data-l={n} className="et-note-table">
      <table>
        <thead>
          <tr>{tete.map((v, k) => cellule('th', v, k))}</tr>
        </thead>
        <tbody>
          {lignes.map((r, y) => (
            <tr key={y}>{tete.map((_, k) => cellule('td', r[k], k))}</tr>
          ))}
        </tbody>
      </table>
    </div>,
  )
  return j
}

// Le rendu d'une note. `statique` : plateau du téléphone (ni lien actif ni case à cocher, rien à toucher).
// `onTache(n)` : une case cochée sur l'ordinateur (n = sa ligne dans le texte source).
// Ateliers : `tableaux`, `lien`, `bloc` (voir l'en-tête) et `className` (classe de plus sur la racine).
export const Markdown = memo(function Markdown({ texte, statique = false, onTache, tableaux = false, lien, bloc, className }) {
  const L = lignesDe(texte || '').map((t, n) => ({ t, n }))
  return <div className={cls('et-note-md', className)}>{blocs(L, 0, { statique, onTache, tableaux, lien, bloc })}</div>
})
