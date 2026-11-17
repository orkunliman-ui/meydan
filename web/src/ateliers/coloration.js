// Ateliers (volet du 13/11) : coloration du code — module PUR (ni DOM, ni réseau, aucune dépendance). Un découpeur à
// états écrit à la main, une table par langage : commentaires, chaînes, nombres, mots-clés, ponctuation ; balises et
// attributs pour HTML/XML ; titres, code en ligne et blocs de code pour Markdown. Lecture seule : ce n'est pas un
// analyseur complet (voir les limites en bas de la table des langages).
// colore(texte, langage) → lignes ; chaque ligne = [{ t, v }] avec t ∈ 'com' | 'chaine' | 'nombre' | 'motcle' | 'ponct'
// | 'balise' | 'attr' | 'titre' | '' ; la suite des `v` d'une ligne redonne la ligne exacte.
// Linéaire : chaque recherche (fin de chaîne, de commentaire, d'expression régulière) avance ou consomme la fin de la
// ligne ; au-delà de 5 000 lignes, chaque ligne est un seul jeton brut.
// Règle du projet : pas de « lookbehind » dans les expressions (anciens Safari).

export const LIGNES_MAX = 5000

const EXTENSIONS = new Map(
  Object.entries({
    js: 'js mjs cjs jsx ts tsx mts cts',
    py: 'py pyw pyi',
    sh: 'sh bash zsh ksh bashrc zshrc profile',
    json: 'json jsonc json5',
    css: 'css scss less',
    html: 'html htm xhtml xml svg vue svelte',
    md: 'md markdown mdx',
    yaml: 'yaml yml',
    toml: 'toml',
    c: 'c h cc cpp cxx hpp hh',
    go: 'go',
    rust: 'rs',
    java: 'java',
    rb: 'rb rake gemspec',
    sql: 'sql',
  }).flatMap(([langage, exts]) => exts.split(' ').map((e) => [e, langage])),
)
const NOMS = new Map([
  ['dockerfile', 'sh'],
  ['makefile', 'sh'],
  ['gemfile', 'rb'],
  ['rakefile', 'rb'],
])

// Le langage d'un fichier d'après son nom (ou son chemin) ; 'texte' s'il n'est pas reconnu.
export function langageDe(nom) {
  const base = String(nom ?? '').split(/[\\/]/).pop().toLowerCase()
  if (NOMS.has(base)) return NOMS.get(base)
  const p = base.lastIndexOf('.')
  return (p >= 0 && EXTENSIONS.get(base.slice(p + 1))) || 'texte'
}

const mots = (s) => new Set(s.split(/\s+/))
const JS = mots(`break case catch class const continue debugger default delete do else export extends finally for function
  if import in instanceof let new return super switch this throw try typeof var void while with yield async await of
  static null undefined true false NaN Infinity from as interface enum implements private public protected readonly
  declare namespace`) // ni « type », ni « get » / « set » : ce sont aussi des noms de propriétés courants
const PY = mots(`False None True and as assert async await break class continue def del elif else except finally for from
  global if import in is lambda nonlocal not or pass raise return try while with yield self match case print`)
const SH = mots(`if then else elif fi case esac for while until do done in function return local export readonly set unset
  shift exit break continue echo source alias declare true false cd`)
const C = mots(`auto break case char const continue default do double else enum extern float for goto if inline int long
  register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true
  false NULL nullptr class public private protected namespace template typename using virtual new delete this`)
const GO = mots(`break case chan const continue default defer else fallthrough for func go goto if import interface map
  package range return select struct switch type var nil true false iota`)
const RUST = mots(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod
  move mut pub ref return self Self static struct super trait true type unsafe use where while`)
const JAVA = mots(`abstract assert boolean break byte case catch char class const continue default do double else enum
  extends final finally float for goto if implements import instanceof int interface long native new package private
  protected public return short static super switch synchronized this throw throws transient try void volatile while true
  false null var record`)
const RB = mots(`BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next
  nil not or redo rescue retry return self super then true undef unless until when while yield require puts`)
const SQL = mots(`select from where insert into values update set delete create table drop alter add column index primary key
  foreign references join left right inner outer full on as and or not null is in exists between like order by group
  having limit offset distinct union all case when then else end default unique check constraint view begin commit
  rollback transaction returning with if replace integer int text varchar char boolean date timestamp serial bigint real
  numeric float count sum avg min max coalesce true false`)

// Table par langage :
//   ligne : début d'un commentaire de fin de ligne ; bloc : /* */ ; guillemets : ouvrent une chaîne (qui finit avec la
//   ligne, sauf `multi`) ; triple : """ et ''' sur plusieurs lignes ; diese : 'com' (# commente toujours), 'mot' (# ne
//   commente qu'en début de mot : « $# » et « ${#x} » du shell n'en sont pas), 'directive' (#include du C) ; regex :
//   expressions régulières de JavaScript ; apostrophe : en Rust, « ' » n'ouvre un caractère que s'il est fermé tout de
//   suite (sinon c'est une durée de vie) ; tiret : « - » fait partie des mots (CSS) ; arobase : « @règle » (CSS) ;
//   cles : clé en début de ligne avant « : » (YAML) ou « = » (TOML) ; casse : mots-clés sans casse (SQL).
// Limites : pas de « ${…} » lu dans les gabarits, pas de here-doc, pas de « // » en CSS (il casserait url(//…)).
const LANGAGES = new Map(
  Object.entries({
    js: { ligne: '//', bloc: true, guillemets: '\'"`', multi: '`', regex: true, mots: JS },
    json: { ligne: '//', bloc: true, guillemets: '"', mots: mots('true false null') },
    css: { bloc: true, guillemets: '\'"', tiret: true, arobase: true, mots: mots('!important') },
    c: { ligne: '//', bloc: true, guillemets: '\'"', diese: 'directive', mots: C },
    go: { ligne: '//', bloc: true, guillemets: '\'"`', multi: '`', mots: GO },
    rust: { ligne: '//', bloc: true, guillemets: '\'"', apostrophe: true, mots: RUST },
    java: { ligne: '//', bloc: true, guillemets: '\'"', mots: JAVA },
    py: { diese: 'com', guillemets: '\'"', triple: true, mots: PY },
    sh: { diese: 'mot', guillemets: '\'"', mots: SH },
    yaml: { diese: 'mot', guillemets: '\'"', cles: ':', mots: mots('true false null yes no on off True False Null') },
    toml: { diese: 'com', guillemets: '\'"', triple: true, cles: '=', mots: mots('true false') },
    rb: { diese: 'com', guillemets: '\'"', mots: RB },
    sql: { ligne: '--', bloc: true, guillemets: '\'"', casse: true, mots: SQL },
  }),
)

const LETTRE = /[\p{L}\p{N}]/u
const chiffre = (c) => c >= '0' && c <= '9'
function estMot(c, tiret) {
  if (c === undefined) return false
  const k = c.charCodeAt(0)
  if ((k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95 || k === 36) return true
  if (tiret && k === 45) return true
  return k > 127 && LETTRE.test(c)
}
const PONCT = /[!-/:-@[-`{-~]/ // ponctuation ASCII
// Après ces jetons, « / » ouvre une expression régulière (JavaScript) ; après un nom, un nombre, « ) », « ] » ou « } »,
// c'est une division. Pas « < » : « </b> » ferme une balise JSX (« > » reste, pour « => /x/ »).
const AVANT_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '>', '~', '^',
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'])

// Accumulateur de jetons d'une ligne : deux jetons voisins du même type sont fusionnés.
function jetons() {
  const out = []
  const pousse = (t, v) => {
    if (!v) return
    const d = out[out.length - 1]
    if (d && d.t === t) d.v += v
    else out.push({ t, v })
  }
  return { out, pousse }
}

// La fin d'une chaîne ouverte par `q` (« \ » échappe le caractère suivant) : position après le guillemet, -1 sinon.
function finChaine(s, i, q) {
  for (; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === q[0] && s.startsWith(q, i)) return i + q.length
  }
  return -1
}

// La fin d'une expression régulière ouverte en `i` (après le « / ») : position après ses drapeaux, -1 si la ligne
// finit avant (ce n'était pas une expression).
function finRegex(s, i) {
  let classe = false
  for (; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '[') classe = true
    else if (c === ']') classe = false
    else if (c === '/' && !classe) {
      i++
      while (i < s.length && /[a-z]/.test(s[i])) i++
      return i
    }
  }
  return -1
}

const CLE_YAML = /^(\s*(?:-\s+)*)([\w.\-/$]+|"[^"]*"|'[^']*')(\s*)(:)(?=\s|$)/
const CLE_TOML = /^(\s*)([\w.-]+|"[^"]*")(\s*)(=)/
const SECTION_TOML = /^(\s*)(\[\[?[^\]]*\]\]?)/

function ligneCode(s, L, etat) {
  const { out, pousse } = jetons()
  let i = 0
  // Suite d'un commentaire ou d'une chaîne ouverts sur une ligne précédente.
  if (etat.bloc) {
    const j = s.indexOf('*/')
    if (j < 0) {
      pousse('com', s)
      return out
    }
    pousse('com', s.slice(0, j + 2))
    i = j + 2
    etat.bloc = false
  } else if (etat.chaine) {
    const j = finChaine(s, 0, etat.chaine)
    if (j < 0) {
      pousse('chaine', s)
      return out
    }
    pousse('chaine', s.slice(0, j))
    i = j
    etat.chaine = ''
  } else if (L.cles) {
    // Clé en début de ligne (YAML « cle: », TOML « cle = ») et section TOML « [table] ».
    const m = (L.cles === ':' ? CLE_YAML : CLE_TOML).exec(s)
    const t = !m && L.cles === '=' ? SECTION_TOML.exec(s) : null
    if (m) {
      for (const c of m[1]) pousse(c === '-' ? 'ponct' : '', c) // retrait et tirets de liste YAML
      pousse('attr', m[2])
      pousse('', m[3])
      pousse('ponct', m[4])
      i = m[0].length
    } else if (t) {
      pousse('', t[1])
      pousse('titre', t[2])
      i = t[0].length
    }
  }
  const premier = s.search(/\S/) // position du premier caractère visible (directive « #include » du C)
  let precedent = '' // dernier jeton utile (division ou expression régulière ?)
  let regexPossible = true // une tentative ratée suffit : pas de seconde lecture de la même ligne
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t') {
      let j = i + 1
      while (s[j] === ' ' || s[j] === '\t') j++
      pousse('', s.slice(i, j))
      i = j
      continue
    }
    if (L.ligne && c === L.ligne[0] && s.startsWith(L.ligne, i)) {
      pousse('com', s.slice(i))
      break
    }
    if (L.bloc && c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2)
      if (j < 0) {
        pousse('com', s.slice(i))
        etat.bloc = true
        break
      }
      pousse('com', s.slice(i, j + 2))
      i = j + 2
      continue
    }
    if (c === '#' && L.diese) {
      if (L.diese === 'com' || (L.diese === 'mot' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t'))) {
        pousse('com', s.slice(i))
        break
      }
      if (L.diese === 'directive' && i === premier) {
        let j = i + 1
        while (estMot(s[j])) j++
        pousse('motcle', s.slice(i, j))
        i = j
        precedent = 'x'
        continue
      }
    }
    if (L.triple && (c === '"' || c === "'") && s[i + 1] === c && s[i + 2] === c) {
      const q = c + c + c
      const j = finChaine(s, i + 3, q)
      if (j < 0) {
        pousse('chaine', s.slice(i))
        etat.chaine = q
        break
      }
      pousse('chaine', s.slice(i, j))
      i = j
      precedent = 'x'
      continue
    }
    if (L.guillemets.includes(c) && !(L.apostrophe && c === "'" && s[i + 1] !== '\\' && s[i + 2] !== "'")) {
      const j = finChaine(s, i + 1, c)
      if (j < 0) {
        pousse('chaine', s.slice(i))
        if (L.multi && L.multi.includes(c)) etat.chaine = c
        break
      }
      pousse('chaine', s.slice(i, j))
      i = j
      precedent = 'x'
      continue
    }
    if (L.regex && c === '/' && regexPossible && AVANT_REGEX.has(precedent)) {
      const j = finRegex(s, i + 1)
      if (j > 0) {
        pousse('chaine', s.slice(i, j))
        i = j
        precedent = 'x'
        continue
      }
      regexPossible = false
    }
    if (chiffre(c) || (c === '.' && chiffre(s[i + 1]))) {
      let j = i + 1
      while (j < s.length && (estMot(s[j]) || (s[j] === '.' && chiffre(s[j + 1])))) j++
      pousse('nombre', s.slice(i, j))
      i = j
      precedent = 'x'
      continue
    }
    if (estMot(c, L.tiret) && c !== '-') {
      let j = i + 1
      while (estMot(s[j], L.tiret)) j++
      const mot = s.slice(i, j)
      pousse(L.mots.has(L.casse ? mot.toLowerCase() : mot) ? 'motcle' : '', mot)
      i = j
      precedent = L.mots.has(mot) ? mot : 'x'
      continue
    }
    if (L.arobase && c === '@' && estMot(s[i + 1], true)) {
      let j = i + 1
      while (estMot(s[j], true)) j++
      pousse('motcle', s.slice(i, j))
      i = j
      continue
    }
    if (c === '!' && L.mots.has('!important') && s.startsWith('!important', i)) {
      pousse('motcle', '!important')
      i += 10
      continue
    }
    pousse(PONCT.test(c) ? 'ponct' : '', c)
    if (PONCT.test(c)) precedent = c
    i++
  }
  return out
}

// HTML / XML : texte, commentaires <!-- -->, balises (nom, attributs, valeurs) ; le contenu de <script> et <style> est
// laissé brut jusqu'à sa balise fermante.
const FIN_BRUT = { script: /<\/script/gi, style: /<\/style/gi }
function ligneHtml(s, etat) {
  const { out, pousse } = jetons()
  let i = 0
  while (i < s.length) {
    if (etat.com) {
      const j = s.indexOf('-->', i)
      if (j < 0) {
        pousse('com', s.slice(i))
        break
      }
      pousse('com', s.slice(i, j + 3))
      i = j + 3
      etat.com = false
      continue
    }
    if (etat.valeur) {
      const j = s.indexOf(etat.valeur, i)
      if (j < 0) {
        pousse('chaine', s.slice(i))
        break
      }
      pousse('chaine', s.slice(i, j + 1))
      i = j + 1
      etat.valeur = ''
      continue
    }
    if (etat.brut) {
      const re = FIN_BRUT[etat.brut]
      re.lastIndex = i
      const m = re.exec(s)
      if (!m) {
        pousse('', s.slice(i))
        break
      }
      pousse('', s.slice(i, m.index))
      i = m.index
      etat.brut = ''
      continue
    }
    const c = s[i]
    if (etat.balise) {
      if (c === ' ' || c === '\t') {
        let j = i + 1
        while (s[j] === ' ' || s[j] === '\t') j++
        pousse('', s.slice(i, j))
        i = j
      } else if (c === '>' || (c === '/' && s[i + 1] === '>')) {
        const n = c === '>' ? 1 : 2
        pousse('ponct', s.slice(i, i + n))
        i += n
        if (n === 1 && etat.ouvreBrut) etat.brut = etat.ouvreBrut
        etat.balise = false
        etat.ouvreBrut = ''
      } else if (c === '=') {
        pousse('ponct', c)
        i++
        etat.egal = true
      } else if (c === '"' || c === "'") {
        const j = s.indexOf(c, i + 1)
        etat.egal = false
        if (j < 0) {
          pousse('chaine', s.slice(i))
          etat.valeur = c
          break
        }
        pousse('chaine', s.slice(i, j + 1))
        i = j + 1
      } else {
        let j = i + 1
        while (j < s.length && !' \t=>"\''.includes(s[j]) && !(s[j] === '/' && s[j + 1] === '>')) j++
        pousse(etat.egal ? 'chaine' : 'attr', s.slice(i, j))
        etat.egal = false
        i = j
      }
      continue
    }
    if (c === '<' && s.startsWith('<!--', i)) {
      pousse('com', '<!--')
      i += 4
      etat.com = true
      continue
    }
    const fermante = s[i + 1] === '/'
    const debutNom = s[i + (fermante ? 2 : 1)]
    if (c === '<' && debutNom && (/[A-Za-z]/.test(debutNom) || (!fermante && (debutNom === '!' || debutNom === '?')))) {
      pousse('ponct', fermante ? '</' : '<')
      let j = i + (fermante ? 2 : 1)
      const d = j
      j++
      while (j < s.length && /[\w:.-]/.test(s[j])) j++
      const nom = s.slice(d, j)
      pousse('balise', nom)
      i = j
      etat.balise = true
      etat.egal = false
      const bas = nom.toLowerCase()
      etat.ouvreBrut = !fermante && FIN_BRUT[bas] ? bas : ''
      continue
    }
    const j = s.indexOf('<', i + 1)
    const fin = j < 0 ? s.length : j
    pousse('', s.slice(i, fin))
    i = fin
  }
  return out
}

// Markdown : titres, blocs de code (``` ou ~~~), puces et citations, code en ligne.
const CLOTURE = /^ {0,3}(`{3,}|~{3,})/
const TITRE = /^ {0,3}#{1,6}(\s|$)/
const PREFIXE = /^(\s*(?:>\s?)*)((?:[-*+]|\d{1,9}[.)])(?=\s|$))?/
function ligneMd(s, etat) {
  const { out, pousse } = jetons()
  if (etat.cloture) {
    const t = s.trim()
    if (t.length >= etat.cloture.length && t === etat.cloture[0].repeat(t.length)) {
      pousse('ponct', s)
      etat.cloture = ''
    } else pousse('chaine', s)
    return out
  }
  const f = CLOTURE.exec(s)
  if (f) {
    etat.cloture = f[1]
    pousse('ponct', s)
    return out
  }
  if (TITRE.test(s)) {
    pousse('titre', s)
    return out
  }
  const p = PREFIXE.exec(s)
  let i = 0
  if (p) {
    for (const c of p[1]) pousse(c === '>' ? 'ponct' : '', c)
    pousse('ponct', p[2] || '')
    i = p[0].length
  }
  // Code en ligne : une suite de n accents graves se ferme par la suivante de même longueur. Les suites de la ligne
  // sont relevées une fois ; pour chaque longueur, un curseur n'avance que vers la droite (linéaire).
  const suites = []
  for (let k = i; k < s.length; k++) {
    if (s[k] !== '`') continue
    let e = k
    while (s[e] === '`') e++
    suites.push([k, e - k])
    k = e - 1
  }
  const parLongueur = new Map()
  suites.forEach(([, n], q) => {
    if (!parLongueur.has(n)) parLongueur.set(n, { liste: [], p: 0 })
    parLongueur.get(n).liste.push(q)
  })
  for (let q = 0; q < suites.length; q++) {
    const [debut, n] = suites[q]
    if (debut < i) continue
    const L = parLongueur.get(n)
    while (L.p < L.liste.length && L.liste[L.p] <= q) L.p++
    if (L.p >= L.liste.length) continue
    const [fin] = suites[L.liste[L.p]]
    pousse('', s.slice(i, debut))
    pousse('chaine', s.slice(debut, fin + n))
    i = fin + n
  }
  pousse('', s.slice(i))
  return out
}

export function colore(texte, langage) {
  const lignes = String(texte ?? '').split(/\r\n|\r|\n/)
  if (lignes.length > LIGNES_MAX) return lignes.map((v) => [{ t: '', v }])
  const etat = {}
  if (langage === 'html') return lignes.map((s) => ligneHtml(s, etat))
  if (langage === 'md') return lignes.map((s) => ligneMd(s, etat))
  const L = LANGAGES.get(langage)
  if (!L) return lignes.map((v) => (v ? [{ t: '', v }] : []))
  return lignes.map((s) => ligneCode(s, L, etat))
}
