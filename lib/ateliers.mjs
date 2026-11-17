// Ateliers (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe », puis « Go ») :
// l'équivalent des « studios » de Symvibe, en cartes du plateau.
//   doc       : un document Markdown ou HTML qu'un agent écrit, suivi en direct, exporté en PDF (lib/ateliers-pdf.mjs) ;
//   code      : l'arborescence d'un projet, un fichier en lecture seule, la recherche par nom, des épingles ;
//   coffre    : un dossier de notes .md (« Markdown » à l'écran), leurs liens et leur graphe ;
//   diagramme : un sous-ensemble de Mermaid « flowchart », écrit dans la carte ou suivi dans un fichier.
// Tout est en lecture seule sur les projets : rien n'est jamais écrit dans un dossier qu'un agent peut écrire (leçon du
// 10/11). Chaque lecture passe par la garde (lib/ateliers-garde.mjs) et par `fichierPermis` (server.mjs) sur le chemin
// RÉEL, relu à chaque fois. Dessin : specs/001-ateliers/ (spec, plan, contrats).
import fs from 'node:fs'
import path from 'node:path'
import { borneDe, cache, cheminRelatif, clePrivee, decode, LOURDS, masque, nomSecret, typeDe } from './ateliers-garde.mjs'
import { ouvreImprimante } from './ateliers-pdf.mjs'
import { extraitLiens, indexNotes, resoutLien } from '../web/src/ateliers/liens.js'

const refus = (message, code = 400) => Object.assign(new Error(message), { code })

// Tailles par défaut et bornes (points du plan, comme les autres cartes ; mêmes valeurs dans web/src/ateliers/registre.jsx).
const TAILLES = {
  doc: { w: 640, h: 760, min: { w: 320, h: 240 } },
  code: { w: 860, h: 640, min: { w: 420, h: 300 } },
  coffre: { w: 860, h: 640, min: { w: 420, h: 300 } },
  diagramme: { w: 640, h: 480, min: { w: 280, h: 200 } },
}
export const TYPES_ATELIERS = Object.keys(TAILLES)
const TEXTE_MAX = 40000 // texte d'un diagramme écrit dans la carte (comme une note)
const EPINGLES_MAX = 12
const LIENS_MAX = 50000 // liens examinés au plus pour un coffre
const EXEMPLE = 'flowchart LR\n  A[Demande] --> B{Valide ?}\n  B -->|oui| C(Fait)\n  B -->|non| D[À revoir]\n  D --> A\n'

// Les champs que chaque type ajoute à une carte, et ce qui se vide quand le projet change.
const CHAMPS = {
  doc: { projet: '', chemin: '' },
  code: { projet: '', fichier: '', epingles: [] },
  coffre: { projet: '', dossier: '', note: '' },
  diagramme: { source: 'texte', texte: EXEMPLE, projet: '', chemin: '' },
}

// Le registre (forme du volet plateau-creatif : taille, defaut, applique) branché par lib/cartes.mjs.
export function typesAteliers(ctx) {
  const types = {}
  for (const type of TYPES_ATELIERS) {
    types[type] = {
      taille: TAILLES[type],
      defaut: () => structuredClone(CHAMPS[type]),
      applique: (k, corps) => applique(ctx, k, corps),
    }
  }
  return types
}

function applique(ctx, k, corps) {
  if (corps.projet !== undefined) {
    let projet = ''
    try {
      projet = corps.projet ? ctx.safeDir(String(corps.projet)) : ''
    } catch {
      throw refus('projet introuvable ou hors du dossier personnel') // sans le message brut du système (relecture F4)
    }
    if (projet !== k.projet) {
      // Un autre projet : les chemins qui en dépendaient ne veulent plus rien dire.
      for (const c of ['chemin', 'fichier', 'dossier', 'note']) if (c in k) k[c] = ''
      if ('epingles' in k) k.epingles = []
    }
    k.projet = projet
  }
  for (const c of ['chemin', 'fichier', 'dossier', 'note']) if (c in k && corps[c] !== undefined) k[c] = cheminRelatif(corps[c])
  if (k.type === 'coffre' && k.note && !/\.md$/i.test(k.note)) throw refus('note : un fichier .md attendu')
  if (k.type === 'code' && corps.epingles !== undefined) {
    if (!Array.isArray(corps.epingles) || corps.epingles.length > EPINGLES_MAX) throw refus(`épingles : ${EPINGLES_MAX} au plus`)
    k.epingles = [...new Set(corps.epingles.map((e) => cheminRelatif(e)).filter(Boolean))]
  }
  if (k.type === 'diagramme') {
    if (corps.source !== undefined) {
      if (corps.source !== 'texte' && corps.source !== 'fichier') throw refus('source : « texte » ou « fichier »')
      k.source = corps.source
    }
    if (corps.texte !== undefined) {
      if (typeof corps.texte !== 'string') throw refus('texte attendu')
      if (corps.texte.length > TEXTE_MAX) throw refus(`diagramme trop long : ${TEXTE_MAX} caractères au plus`, 413)
      k.texte = corps.texte
    }
  }
}

// Le chemin suivi par une carte d'atelier (projet + relatif), ou null.
function suiviDe(k) {
  if (!k.projet) return null
  if (k.type === 'doc') return k.chemin ? k.chemin : null
  if (k.type === 'diagramme') return k.source === 'fichier' && k.chemin ? k.chemin : null
  if (k.type === 'code') return k.fichier || null
  if (k.type === 'coffre') return k.note ? path.posix.join(k.dossier || '', k.note) : null
  return null
}

export function ouvreAteliers({ HOME, safeDir, fichierPermis, send, broadcast, cartes, actif = () => true, imprimante = ouvreImprimante() }) {
  // ── La garde complète : projet réel, chemin relatif sûr, caché, secret, sortie du projet, fichierPermis ──
  // Rend { racine, reel, rel } ou { refus } ; lève (400) pour un chemin mal formé.
  function resout(projet, relBrut) {
    let racine
    try {
      racine = safeDir(String(projet || ''))
    } catch {
      throw refus('projet introuvable ou hors du dossier personnel') // sans le message brut du système (relecture F4)
    }
    const rel = cheminRelatif(relBrut)
    if (rel && cache(rel)) return { refus: 'interdit' } // segment caché demandé (« .env », « .git/… »)
    if (rel && nomSecret(path.posix.basename(rel))) return { refus: 'secret' }
    let reel
    try {
      reel = fs.realpathSync(path.join(racine, rel))
    } catch {
      return { refus: 'absent' }
    }
    if (reel !== racine && !reel.startsWith(racine + path.sep)) return { refus: 'hors-projet' }
    // La racine du projet `~` elle-même n'est pas « sous » le dossier personnel : seule exception à fichierPermis.
    const verdict = verifieReel(racine, reel)
    if (verdict) return { refus: verdict }
    return { racine, reel, rel }
  }
  // Le contrôle d'un chemin RÉEL : dans le projet, permis (fichierPermis), pas un nom de secret.
  function verifieReel(racine, reel) {
    if (reel !== racine && !reel.startsWith(racine + path.sep)) return 'hors-projet'
    // La racine du projet `~` elle-même n'est pas « sous » le dossier personnel : seule exception à fichierPermis.
    if (!(reel === HOME && racine === HOME) && fichierPermis(reel)) return 'interdit'
    if (nomSecret(path.basename(reel))) return 'secret'
    return ''
  }
  // Ouvrir PUIS contrôler ce qui a été ouvert (relecture de sécurité du 13/11, M1, M2, E2) : un lien échangé entre le
  // contrôle et l'ouverture, un FIFO (qui bloquerait), un périphérique, un lien physique vers un fichier protégé ne passent
  // plus. Le chemin réel est celui du descripteur (/proc/self/fd), le type et les liens physiques viennent de fstat.
  // Rend { fd, st, reel } (l'appelant ferme fd) ou { refus }.
  function ouvre(racine, rel) {
    let fd
    try {
      fd = fs.openSync(path.join(racine, rel), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY)
    } catch {
      return { refus: 'absent' }
    }
    try {
      const reel = fs.readlinkSync(`/proc/self/fd/${fd}`)
      const verdict = verifieReel(racine, reel)
      if (verdict) throw Object.assign(new Error(verdict), { verdict })
      const st = fs.fstatSync(fd)
      if (st.isDirectory()) throw Object.assign(new Error('dossier'), { verdict: 'dossier' })
      if (!st.isFile()) throw Object.assign(new Error('interdit'), { verdict: 'interdit' })
      if (st.nlink > 1) throw Object.assign(new Error('lien-physique'), { verdict: 'lien-physique' })
      return { fd, st, reel }
    } catch (e) {
      fs.closeSync(fd)
      return { refus: e.verdict || 'absent' }
    }
  }
  // Au plus `borne` + 1 octets lus depuis le descripteur (le fichier peut grossir entre fstat et lecture).
  function litBorne(fd, borne, taille) {
    const buf = Buffer.alloc(Math.min(taille, borne) + 1)
    let lu = 0
    while (lu < buf.length) {
      const n = fs.readSync(fd, buf, lu, buf.length - lu, lu)
      if (!n) break
      lu += n
    }
    return buf.subarray(0, lu)
  }
  const empreinte = (st) => `${st.size}-${Math.round(st.mtimeMs)}-${st.ino}`

  // L'empreinte de ce que `lire` rendrait, sans lire le contenu (le suivi l'appelle chaque seconde).
  function cleDe(projet, rel) {
    try {
      const r = resout(projet, rel)
      if (r.refus) return `refus-${r.refus}`
      return empreinte(fs.statSync(r.reel))
    } catch {
      return 'refus-erreur'
    }
  }

  // Lire un fichier : { cle, type, taille, texte } ; ou { cle, refus, taille? } ; ou { cle } si l'empreinte est celle
  // que l'interface a déjà (`deja`).
  function lire(projet, relBrut, deja) {
    const r = resout(projet, relBrut)
    if (r.refus) return { cle: `refus-${r.refus}`, refus: r.refus }
    const o = ouvre(r.racine, r.rel)
    if (o.refus) return { cle: `refus-${o.refus}`, refus: o.refus }
    let buf
    let cle
    let type
    let borne
    try {
      cle = empreinte(o.st)
      if (deja && deja === cle) return { cle }
      type = typeDe(o.reel)
      borne = borneDe(type)
      if (o.st.size > borne) return { cle, refus: 'trop-gros', taille: o.st.size, borne }
      buf = litBorne(o.fd, borne, o.st.size)
    } finally {
      fs.closeSync(o.fd)
    }
    if (buf.length > borne) return { cle, refus: 'trop-gros', taille: buf.length, borne }
    const texte = decode(buf)
    if (texte === null) return { cle, refus: 'binaire', taille: buf.length }
    if (clePrivee(texte)) return { cle, refus: 'secret' }
    return { cle, type, taille: buf.length, texte: masque(texte) }
  }

  // Un niveau de l'arborescence : dossiers d'abord, caché omis, 1 000 entrées au plus.
  function arbre(projet, relBrut) {
    const r = resout(projet, relBrut)
    if (r.refus) throw refus(`dossier refusé (${r.refus})`, r.refus === 'absent' ? 404 : 403)
    if (!fs.statSync(r.reel).isDirectory()) throw refus("ce n'est pas un dossier")
    const entrees = []
    let tronque = false
    let examinees = 0
    for (const d of fs.readdirSync(r.reel, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      // Borne sur ce qui est EXAMINÉ, pas seulement sur ce qui est gardé (relecture M4 : 200 000 liens sortants, 8,6 s).
      if (++examinees > 5000) {
        tronque = true
        break
      }
      const plein = path.join(r.reel, d.name)
      let reel
      let st
      try {
        reel = fs.realpathSync.native(plein)
        st = fs.statSync(reel)
      } catch {
        continue // lien cassé
      }
      if (reel !== r.racine && !reel.startsWith(r.racine + path.sep)) continue // lien qui sort du projet
      if (fichierPermis(reel)) continue // données de Meydan, compte 2, identité, caché au bout d'un lien
      if (nomSecret(d.name) || nomSecret(path.basename(reel))) continue // nom de clé ou de secret : jamais montré, même son nom
      if (entrees.length >= 1000) {
        tronque = true
        break
      }
      const dossier = st.isDirectory()
      entrees.push({ nom: d.name, dossier, ...(dossier ? (LOURDS.has(d.name) ? { lourd: true } : {}) : { taille: st.size }) })
    }
    entrees.sort((a, b) => Number(b.dossier) - Number(a.dossier) || a.nom.localeCompare(b.nom, 'fr'))
    return { chemin: r.rel, entrees, tronque }
  }

  // Parcours borné d'un dossier (recherche, coffre) : caché, lourds et liens symboliques sautés (pas de boucle).
  function* parcours(racine, depart, { max = 5000, prof = 12 } = {}) {
    const file = [[depart, 0]]
    let vus = 0
    while (file.length) {
      const [dir, p] = file.shift()
      let liste
      try {
        liste = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      liste.sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      for (const d of liste) {
        if (d.name.startsWith('.') || d.isSymbolicLink() || nomSecret(d.name)) continue // ni caché, ni lien, ni nom de secret
        if (++vus > max) return yield { tronque: true }
        const plein = path.join(dir, d.name)
        if (d.isDirectory()) {
          if (LOURDS.has(d.name) || fichierPermis(plein)) continue
          if (p + 1 < prof) file.push([plein, p + 1])
        } else if (d.isFile()) yield { plein, rel: path.relative(racine, plein).split(path.sep).join('/'), nom: d.name }
      }
    }
  }
  const sansAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

  function recherche(projet, q) {
    if (typeof q !== 'string' || !q.trim() || q.length > 100) throw refus('recherche : 1 à 100 caractères')
    const r = resout(projet, '')
    if (r.refus) throw refus(`projet refusé (${r.refus})`, 403)
    const cherche = sansAccents(q.trim())
    const resultats = []
    let tronque = false
    for (const f of parcours(r.racine, r.reel)) {
      if (f.tronque) {
        tronque = true
        break
      }
      if (!sansAccents(f.nom).includes(cherche) || fichierPermis(f.plein)) continue
      resultats.push(f.rel)
      if (resultats.length >= 50) {
        tronque = true
        break
      }
    }
    return { resultats, tronque }
  }

  // Le coffre : ses notes, leurs liens résolus (même module que l'interface : web/src/ateliers/liens.js), les cassés.
  function coffre(projet, dossierBrut) {
    const r = resout(projet, dossierBrut)
    if (r.refus) throw refus(`dossier refusé (${r.refus})`, r.refus === 'absent' ? 404 : 403)
    if (!fs.statSync(r.reel).isDirectory()) throw refus("ce n'est pas un dossier")
    const fichiers = []
    let tronque = false
    for (const f of parcours(r.reel, r.reel, { max: 20000 })) {
      if (f.tronque) {
        tronque = true
        break
      }
      if (!/\.md$/i.test(f.nom) || nomSecret(f.nom) || fichierPermis(f.plein)) continue
      if (fichiers.length >= 1000) {
        tronque = true
        break
      }
      fichiers.push(f)
    }
    const notes = fichiers.map((f) => ({ chemin: f.rel, nom: f.nom.replace(/\.md$/i, '') }))
    const index = indexNotes(notes.map((n) => n.chemin))
    const liens = []
    const casses = []
    const ambigus = []
    const vus = new Set()
    // Une cible se résout une fois par dossier de note source (relecture E1 : 8 000 [[index]] ambigus gelaient le moteur
    // 6 s) ; 50 000 liens examinés au plus pour tout le coffre ; listes bornées PENDANT le calcul.
    const resolus = new Map()
    let examines = 0
    let lu = 0
    for (let i = 0; i < fichiers.length && !(tronque && examines >= LIENS_MAX); i++) {
      const f = fichiers[i]
      // Ouverture contrôlée comme pour `lire` (relecture E2 : un FIFO ou /dev/zero mis à la place d'une note).
      const rel = path.relative(r.racine, f.plein).split(path.sep).join('/')
      const o = ouvre(r.racine, rel)
      if (o.refus) continue
      let buf
      try {
        if (o.st.size > 2 * 1024 * 1024 || lu + o.st.size > 20 * 1024 * 1024) {
          tronque = true
          continue
        }
        buf = litBorne(o.fd, 2 * 1024 * 1024, o.st.size)
      } finally {
        fs.closeSync(o.fd)
      }
      lu += buf.length
      const texte = decode(buf)
      if (texte === null) continue
      const dossierSource = notes[i].chemin.includes('/') ? notes[i].chemin.slice(0, notes[i].chemin.lastIndexOf('/')) : ''
      for (const { cible, genre } of extraitLiens(texte)) {
        if (++examines > LIENS_MAX) {
          tronque = true
          break
        }
        const cleRes = `${dossierSource}\u0000${genre}\u0000${cible}`
        let res = resolus.get(cleRes)
        if (!res) {
          res = resoutLien(cible, genre, notes[i].chemin, index)
          resolus.set(cleRes, res)
        }
        if (res.i < 0) {
          if (casses.length < 500) casses.push({ de: i, cible: masque(cible) })
        } else {
          if (res.n > 1 && ambigus.length < 500) ambigus.push({ de: i, cible: masque(cible), n: res.n })
          const cleLien = `${i}>${res.i}`
          if (res.i !== i && !vus.has(cleLien)) {
            vus.add(cleLien)
            liens.push([i, res.i])
          }
        }
      }
    }
    return { notes, liens, casses, ambigus, tronque }
  }

  // ── Le suivi : chaque seconde (si un client est relié), l'empreinte du fichier suivi par chaque carte d'atelier ──
  const vues = new Map() // id de carte → dernière empreinte annoncée
  function tic() {
    if (!actif()) return
    const presentes = new Set()
    for (const k of cartes().liste()) {
      if (!TYPES_ATELIERS.includes(k.type)) continue
      const rel = suiviDe(k)
      if (!rel) continue
      presentes.add(k.id)
      const cle = cleDe(k.projet, rel)
      const avant = vues.get(k.id)
      vues.set(k.id, cle)
      if (avant !== undefined && avant !== cle) broadcast({ type: 'atelier', id: k.id, cle })
    }
    for (const id of vues.keys()) if (!presentes.has(id)) vues.delete(id)
  }
  const minuterie = setInterval(tic, 1000)
  minuterie.unref?.()

  // ── Les routes ──
  async function api(req, res, url, parts) {
    if (req.method !== 'GET') return send(res, 405, { error: 'méthode refusée' })
    // Une lecture demandée par un AUTRE site (navigation de premier niveau, que le cookie Lax du nom public suit) : refusée.
    // Rien n'y serait lisible pour ce site, mais elle ferait travailler le moteur (relecture F3).
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'origine refusée' })
    const q = url.searchParams
    const projet = q.get('projet') || ''
    switch (parts[2]) {
      case 'lire':
        return send(res, 200, lire(projet, q.get('chemin') || '', q.get('cle') || ''))
      case 'arbre':
        return send(res, 200, arbre(projet, q.get('chemin') || ''))
      case 'recherche':
        return send(res, 200, recherche(projet, q.get('q') || ''))
      case 'coffre':
        return send(res, 200, coffre(projet, q.get('dossier') || ''))
    }
    return send(res, 404, { error: 'route inconnue' })
  }

  // POST /api/envois/ateliers/pdf { projet, chemin, html?, titre? } : sous /api/envois/ parce que le HTML rendu d'un long
  // document dépasse les 64 Ko que nginx accepte ailleurs. `originOk` est déjà vérifié par api() de server.mjs.
  async function envoi(req, res, url, parts) {
    if (parts.length !== 4 || parts[3] !== 'pdf') return send(res, 404, { error: 'route inconnue' })
    if (req.method !== 'POST') return send(res, 405, { error: 'méthode refusée' })
    const corps = await litCorps(req, 8 * 1024 * 1024)
    const doc = lire(corps.projet, corps.chemin)
    if (doc.refus) throw refus(`document refusé (${doc.refus})`, doc.refus === 'absent' ? 404 : 403)
    if (doc.type !== 'md' && doc.type !== 'html') throw refus('seuls un document Markdown ou HTML s’exportent en PDF')
    const nom = path.posix.basename(cheminRelatif(corps.chemin)).replace(/\.[^.]+$/, '') || 'document'
    let page
    if (doc.type === 'html') page = doc.texte // sa propre mise en page ; scripts coupés, aucune requête (ateliers-pdf.mjs)
    else {
      if (typeof corps.html !== 'string' || !corps.html) throw refus('le rendu du document est attendu (html)')
      page = pageImpression(String(corps.titre || nom), masque(corps.html))
    }
    const pdf = await imprimante.imprime(page)
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': pdf.length,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(nom + '.pdf')}`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    })
    return res.end(pdf)
  }

  return { api, envoi, lire, arbre, recherche, coffre, tic }
}

// Corps JSON d'une demande, borné à `max` octets (le corps d'un export dépasse les 64 Ko de readJson). Au-delà : refus
// 413 sans couper la liaison — `send()` de server.mjs rend la réponse entière et laisse s'écouler le reste du corps
// (couper ferait rendre 502 à nginx, ou « socket hang up » au client : leçon du 10/11).
function litCorps(req, max) {
  return new Promise((ok, ko) => {
    let taille = 0
    let trop = false
    const morceaux = []
    req.on('data', (c) => {
      if (trop) return
      taille += c.length
      if (taille > max) {
        trop = true
        morceaux.length = 0
        ko(refus(`corps trop gros (${Math.round(max / 1024 / 1024)} Mo au plus)`, 413))
      } else morceaux.push(c)
    })
    req.on('end', () => {
      if (trop) return
      try {
        ok(JSON.parse(Buffer.concat(morceaux).toString('utf8') || '{}'))
      } catch {
        ko(refus('JSON invalide'))
      }
    })
    req.on('error', ko)
  })
}

// La page imprimée d'un document Markdown : l'article rendu à l'écran (éléments React sérialisés par l'interface, rien
// du fichier n'y est du HTML), dans une feuille d'impression. Police de Meydan (Host Grotesk) intégrée en data: si le
// fichier est là (aucune requête), sinon une police de la machine.
const echappe = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
let police = null
function policeImpression() {
  if (police !== null) return police
  try {
    const f = fs.readFileSync(new URL('../web/src/fonts/HostGrotesk-var.woff2', import.meta.url))
    police = `@font-face{font-family:'Host Grotesk';src:url(data:font/woff2;base64,${f.toString('base64')}) format('woff2');font-weight:300 800}`
  } catch {
    police = ''
  }
  return police
}
export function pageImpression(titre, article) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${echappe(titre)}</title><style>
${policeImpression()}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font:11pt/1.55 'Host Grotesk','Liberation Sans','DejaVu Sans',sans-serif;color:#16161a}
.at-doc{max-width:none}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.2em 0 .5em;break-after:avoid;page-break-after:avoid}
h1{font-size:22pt}h2{font-size:16pt;border-bottom:1px solid #ddd;padding-bottom:.2em}h3{font-size:13pt}
p,li{orphans:3;widows:3}
a{color:#1d4ed8;text-decoration:none}
code{font:9.5pt/1.45 'DejaVu Sans Mono','Liberation Mono',monospace;background:#f3f3f1;padding:.05em .3em;border-radius:3px}
pre{background:#f3f3f1;padding:.7em .9em;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
pre code{background:none;padding:0}
blockquote{margin:.8em 0;padding:.1em 1em;border-left:3px solid #ccc;color:#444}
table{border-collapse:collapse;margin:.8em 0;width:auto;max-width:100%}
th,td{border:1px solid #ccc;padding:.3em .6em;text-align:left;vertical-align:top}
th{background:#f3f3f1}
tr,img,svg,figure{break-inside:avoid;page-break-inside:avoid}
hr{border:0;border-top:1px solid #ccc;margin:1.4em 0}
ul,ol{padding-left:1.4em}
.at-diagramme svg{max-width:100%;height:auto}
button{all:unset}
</style></head><body><article class="at-doc">${article}</article></body></html>`
}
