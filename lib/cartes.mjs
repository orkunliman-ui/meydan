// Plateau étendu (volet du 11/11, écart avec Symvibe) : des cartes posées sur le plateau à côté des consoles.
//   note : un texte en Markdown, écrit et lu sur la carte ;
//   web  : l'aperçu d'un serveur local (http://127.0.0.1:<port>), servi par le relais authentifié (lib/relais-web.mjs) ;
//   git  : le panneau Git d'un projet (lib/git-panneau.mjs) — lecture, et commit sur demande explicite d'Orkun ; jamais de push.
// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») : d'autres
// types, chacun dans son propre module (registre `CREATIFS` plus bas) — checklist, kanban, calendrier, formes et flèches,
// images annotées, fichiers ; et les traits du stylo (lib/traits.mjs, routes /api/cartes/traits).
//   nav  : ce que voit le navigateur piloté par l'agent d'une console (lib/navigateur.mjs, volet copies du 13/11), inscrite
//          au registre (lib/cartes-nav.mjs) mais posée et retirée par le serveur seulement (creeNav, retireNav).
// Les cartes vivent dans leur propre fichier (data/cartes.json), à part de state.json : rien de l'état des consoles ne bouge.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { typesChecklist } from './cartes-checklist.mjs'
import { typesCalendrier } from './cartes-calendrier.mjs'
import { typesKanban } from './cartes-kanban.mjs'
import { typesFormes } from './cartes-formes.mjs'
import { typesImage } from './cartes-image.mjs'
import { typesFichier } from './cartes-fichier.mjs'
import { typesNav } from './cartes-nav.mjs'
import { ouvreTraits } from './traits.mjs'
// Ateliers (volet du 13/11) : Document, Code, Markdown (coffre), Diagramme — inscrits dans le même registre (lib/ateliers.mjs).
import { typesAteliers } from './ateliers.mjs'

// Tailles par défaut et bornes des types du 11/11 (points du plan, comme les consoles).
const TAILLES_SOCLE = {
  note: { w: 420, h: 340, min: { w: 220, h: 140 } },
  web: { w: 820, h: 560, min: { w: 320, h: 220 } },
  git: { w: 660, h: 640, min: { w: 420, h: 320 } },
}
const MAX = { w: 2400, h: 1600 }
// Le corps d'une demande est borné à 64 Ko (readJson de server.mjs, et nginx `client_max_body_size 64k`) : 40 000
// caractères simples y tiennent, pas 40 000 « é » (80 Ko : readJson coupe la liaison, pas de 413). NoteNode.jsx refuse
// ce cas avant l'envoi (taille du corps en octets).
export const TEXTE_MAX = 40000
// 400 (200 avant le 13/11) : formes et flèches sont des cartes aussi. Les traits du stylo n'en sont pas (lib/traits.mjs).
const NB_MAX = 400
// Couleurs permises pour les formes, les flèches et l'encre : celles du thème, SANS le jaune (règle du design : le jaune
// est réservé à ce qui attend Orkun). L'interface les peint par les jetons du thème (cartes-types.js, cartes.css).
export const COULEURS = ['papier', 'gris', 'bleu', 'turquoise', 'vert', 'rouge']

export const refus = (message, code = 400) => Object.assign(new Error(message), { code })
const num = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined)
const titreDe = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
// Chemin demandé au serveur relayé : commence par « / », sans caractère de contrôle ni espace, 500 caractères au plus.
const cheminDe = (v) => {
  const s = String(v ?? '/').trim() || '/'
  if (!/^\/[^\s\u0000-\u001f\u007f]{0,499}$/.test(s)) throw refus('chemin : une adresse qui commence par « / », sans espace')
  return s
}

// `relais` : { portPermis(port) → '' | raison } ; `git` : { api(req, res, url, carte, reste), ancre(depot, dossier) } ; `safeDir(dossier)` : le
// dossier réel sous ~ (lève sinon). `broadcast` : le flux /ws/events. `fichierPermis(reel)` : '' si ce fichier réel peut
// être montré (mêmes exclusions que la route /fichier des consoles : dossiers et fichiers cachés, compte 2, fichiers
// d'identité, données de Meydan), sinon la raison du refus.
export function ouvreCartes({ DATA, HOME, safeDir, fichierPermis, broadcast, send, readJson, relais, git }) {
  const FICHIER = path.join(DATA, 'cartes.json')
  // Contexte remis à chaque module de type (registre ci-dessous) et au module des traits.
  const ctx = { DATA, HOME, safeDir, fichierPermis, broadcast, send, readJson, refus, COULEURS }
  // Le registre du plateau créatif : { <type>: { taille: { w, h, min: { w, h } } | null, defaut() → champs d'une carte
  // neuve, applique(k, corps) → pose les champs propres au type (lève `refus` sinon), api?(req, res, url, k, reste)
  // → routes /api/cartes/<id>/<reste…>, retire?(k) → ménage quand la carte part (fichier d'image…) } }.
  // `taille: null` : la carte n'a pas de boîte (une flèche : ses deux bouts suffisent).
  const CREATIFS = { ...typesChecklist(ctx), ...typesCalendrier(ctx), ...typesKanban(ctx), ...typesFormes(ctx), ...typesImage(ctx), ...typesFichier(ctx), ...typesAteliers(ctx), ...typesNav(ctx) }
  const TYPES = new Set(['note', 'web', 'git', ...Object.keys(CREATIFS)])
  // Les types qu'une page peut créer (POST /api/cartes) : tous sauf ceux que le serveur pose lui-même (`serveurSeul` : nav).
  const CREABLES = new Set([...TYPES].filter((t) => !CREATIFS[t]?.serveurSeul))
  const CONSOLE = /^c[0-9a-f]{8}$/
  const tailleDe = (type) => TAILLES_SOCLE[type] || CREATIFS[type]?.taille || null
  let cartes = []
  try {
    // Seules les entrées de la forme attendue sont reprises (même règle que state.json : un fichier abîmé ne fait pas
    // planter le démarrage).
    const lu = JSON.parse(fs.readFileSync(FICHIER, 'utf8'))
    cartes = (Array.isArray(lu?.cartes) ? lu.cartes : []).filter((k) => k && /^k[0-9a-f]{8}$/.test(k.id) && TYPES.has(k.type) && (k.type !== 'nav' || CONSOLE.test(k.console)))
  } catch {
    cartes = []
  }
  // Écrit `liste` (par défaut les cartes en mémoire). Une création, une modification ou un retrait écrit d'abord la liste
  // d'APRÈS, puis seulement la pose en mémoire : un disque plein laisse la mémoire et le fichier d'accord (relecture du 13/11).
  const sauve = (liste = cartes) => {
    const tmp = FICHIER + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ cartes: liste }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, FICHIER)
  }
  const trouve = (id) => cartes.find((k) => k.id === id)
  // Les traits du stylo (plateau, ou annotations d'une carte image) : leur propre fichier et leurs routes.
  const traits = ouvreTraits({ ...ctx, trouveCarte: trouve })
  ctx.retireTraits = traits.retireSupport // un module de type (image remplacée) retire les annotations de sa carte

  // Les champs qu'une demande peut poser sur une carte (création ou modification). Le type ne change jamais.
  function applique(k, corps, creation = false) {
    const t = tailleDe(k.type)
    if (t)
      for (const [cle, min, max] of [['x', -50000, 50000], ['y', -50000, 50000], ['w', t.min.w, MAX.w], ['h', t.min.h, MAX.h]]) {
        const v = num(Number(corps[cle]), min, max)
        if (corps[cle] !== undefined && v !== undefined) k[cle] = v
      }
    if (corps.titre !== undefined) k.titre = titreDe(corps.titre)
    if (k.type === 'note' && corps.texte !== undefined) {
      if (typeof corps.texte !== 'string') throw refus('texte attendu')
      if (corps.texte.length > TEXTE_MAX) throw refus(`note trop longue : ${TEXTE_MAX} caractères au plus`, 413)
      k.texte = corps.texte
    }
    if (k.type === 'web') {
      if (corps.port !== undefined) {
        const port = corps.port === null || corps.port === '' ? null : Number(corps.port)
        if (port !== null) {
          const raison = relais.portPermis(port)
          if (raison) throw refus(raison)
        }
        k.port = port
      }
      if (corps.chemin !== undefined) k.chemin = cheminDe(corps.chemin)
    }
    if (k.type === 'git') {
      if (corps.dossier !== undefined) {
        const avant = k.dossier
        k.dossier = corps.dossier ? safeDir(String(corps.dossier)) : ''
        if (!creation && k.dossier !== avant) delete k.depot // un autre projet : l'ancre de l'ancienne copie ne vaut plus
      }
      // Carte posée sur une copie par « Ouvrir le panneau de cette copie » (volet copies, seconde relecture du 13/11) : le
      // dépôt principal de la copie, d'où le panneau tire son dossier git (jamais de la copie, que son agent écrit).
      // Vérifié à la création (lib/git-panneau.mjs, ancreDeCopie), jamais changé ensuite.
      if (creation && corps.depot !== undefined && corps.depot !== '') {
        k.depot = safeDir(String(corps.depot))
        git.ancre(k.depot, k.dossier)
      }
    }
    CREATIFS[k.type]?.applique(k, corps, creation)
    if (!creation) k.modifieLe = Date.now()
  }

  async function api(req, res, url, parts) {
    const m = req.method
    if (parts.length === 2) {
      if (m === 'GET') return send(res, 200, { cartes })
      if (m === 'POST') {
        const corps = await readJson(req)
        if (!CREABLES.has(corps.type)) throw refus(`type de carte inconnu (${[...CREABLES].join(', ')})`)
        if (cartes.length >= NB_MAX) throw refus(`${NB_MAX} cartes au plus sur le plateau`, 409)
        const t = tailleDe(corps.type)
        const maintenant = Date.now()
        const k = { id: `k${crypto.randomBytes(4).toString('hex')}`, type: corps.type, ...(t ? { x: 0, y: 0, w: t.w, h: t.h } : {}), titre: '', creeLe: maintenant, modifieLe: maintenant }
        if (k.type === 'note') k.texte = ''
        if (k.type === 'web') Object.assign(k, { port: null, chemin: '/' })
        if (k.type === 'git') k.dossier = ''
        if (CREATIFS[k.type]) Object.assign(k, CREATIFS[k.type].defaut())
        applique(k, corps, true)
        sauve([...cartes, k])
        cartes.push(k)
        broadcast({ type: 'carte', carte: k })
        return send(res, 201, { carte: k })
      }
      return send(res, 405, { error: 'méthode refusée' })
    }
    // Les traits du stylo : /api/cartes/traits[/<id>] (lib/traits.mjs). « traits » n'est jamais un identifiant de carte.
    if (parts[2] === 'traits') return await traits.api(req, res, url, parts.slice(3))
    const k = trouve(parts[2])
    if (!k) return send(res, 404, { error: 'carte inconnue' })
    if (parts.length === 3) {
      if (m === 'PATCH') {
        // Sur une copie (profonde : les types créatifs portent des listes) : une demande refusée (note trop longue, port
        // refusé, liste trop longue) ne laisse rien de changé. La copie se prend APRÈS la lecture du corps : un PATCH ou
        // un retrait arrivé pendant cette lecture serait sinon écrasé, ou la carte retirée reviendrait (relecture du 13/11).
        const corps = await readJson(req)
        if (!cartes.includes(k)) return send(res, 404, { error: 'carte inconnue' })
        const copie = structuredClone(k)
        applique(copie, corps)
        sauve(cartes.map((x) => (x === k ? copie : x)))
        Object.assign(k, copie)
        broadcast({ type: 'carte', carte: k })
        return send(res, 200, { carte: k })
      }
      if (m === 'DELETE') {
        const suivantes = cartes.filter((x) => x !== k)
        sauve(suivantes)
        cartes = suivantes
        broadcast({ type: 'carte-retiree', id: k.id })
        // Ménage après coup (fichier d'image, traits d'annotation) : la carte est déjà retirée, un échec ici ne la ramène pas.
        try {
          await CREATIFS[k.type]?.retire?.(k)
        } catch (e) {
          console.error(`[cartes] ménage de ${k.id} : ${e.message}`)
        }
        traits.retireSupport(k.id)
        return send(res, 200, { ok: true })
      }
      return send(res, 405, { error: 'méthode refusée' })
    }
    // L'adresse de l'aperçu d'une carte web (relais à jeton, voir lib/relais-web.mjs).
    if (parts[3] === 'apercu' && parts.length === 4 && m === 'POST') {
      if (k.type !== 'web') return send(res, 404, { error: 'pas une carte web' })
      return send(res, 200, relais.adresse(req, k))
    }
    // Le panneau Git : tout ce qui suit /git est servi par lib/git-panneau.mjs.
    if (parts[3] === 'git') {
      if (k.type !== 'git') return send(res, 404, { error: 'pas une carte git' })
      return await git.api(req, res, url, k, parts.slice(4))
    }
    // Les routes propres à un type créatif (image, fichier…) : /api/cartes/<id>/<reste…>.
    if (CREATIFS[k.type]?.api) return await CREATIFS[k.type].api(req, res, url, k, parts.slice(3))
    return send(res, 404, { error: 'route inconnue' })
  }

  // Une modification venue d'un module de type (après l'arrivée d'un fichier d'image, par exemple) : enregistrée et
  // annoncée comme une modification par l'API.
  function maj(k) {
    k.modifieLe = Date.now()
    sauve()
    broadcast({ type: 'carte', carte: k })
  }
  ctx.majCarte = maj

  // La carte « Navigateur · <console> » (lib/navigateur.mjs) : posée au premier `meydan nav ouvre` d'une console s'il n'y
  // en a pas pour elle, à droite de la console ; rendue telle quelle si elle existe déjà (Orkun l'a peut-être déplacée).
  // Écrite comme une création de l'API : la liste d'APRÈS sur le disque d'abord, puis en mémoire.
  function creeNav(c) {
    const deja = cartes.find((k) => k.type === 'nav' && k.console === c.id)
    if (deja) return deja
    if (cartes.length >= NB_MAX) return null // plateau plein : le navigateur marche quand même, sans carte
    const t = tailleDe('nav')
    const maintenant = Date.now()
    const k = { id: `k${crypto.randomBytes(4).toString('hex')}`, type: 'nav', x: 0, y: 0, w: t.w, h: t.h, titre: '', creeLe: maintenant, modifieLe: maintenant, ...CREATIFS.nav.defaut() }
    k.console = c.id
    applique(k, { x: (Number(c.x) || 0) + (Number(c.w) || 0) + 48, y: Number(c.y) || 0, titre: `Navigateur · ${c.name || c.id}` }, true)
    sauve([...cartes, k])
    cartes.push(k)
    broadcast({ type: 'carte', carte: k })
    return k
  }
  // La console part : sa carte aussi.
  function retireNav(consoleId) {
    const parties = cartes.filter((k) => k.type === 'nav' && k.console === consoleId)
    if (!parties.length) return
    const suivantes = cartes.filter((k) => !parties.includes(k))
    sauve(suivantes)
    cartes = suivantes
    for (const k of parties) broadcast({ type: 'carte-retiree', id: k.id })
  }

  return { api, trouve, liste: () => cartes, creeNav, retireNav }
}
