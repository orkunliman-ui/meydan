// Navigateur piloté par l'agent d'une console (volet « copies », 13/11, rattrapage de Symvibe 1.1.0 : les pages localhost
// s'ouvrent « dans un navigateur du plateau branché à un agent »). L'agent le pilote par `meydan nav …` (lib/meydan-nav.mjs) ;
// Orkun voit sur le plateau, dans la carte « Navigateur · <console> », ce que voit ce navigateur, en lecture seule.
//
// Ce que ce module garantit (essais : test/volets/copies/nav-api.mjs, nav-securite.mjs, nav-haiku.mjs) :
//   - porte de débogage JAMAIS exposée : CDP passe par un tube (--remote-debugging-pipe : fd 3 lu par Chromium, fd 4 écrit
//     par lui, messages JSON séparés par NUL), aucun port de débogage. Tube fermé (serveur arrêté, même tué), Chromium
//     s'arrête de lui-même (sondé le 13/11 : 16 ms pour chrome-headless-shell, 61 ms pour le Chromium du snap).
//   - bac à sable de Chromium : Chromium du snap (/snap/bin/chromium), le seul ici qui l'ait : l'AppArmor d'Ubuntu 24.04
//     refuse les espaces de noms au chrome-headless-shell de Playwright (« No usable sandbox », sondé le 13/11). Rendus sous
//     seccomp et dans leurs propres espaces de noms (relu dans /proc/<rendu>/status). MEYDAN_NAV_SANS_BAC=1 ne sert qu'à
//     essayer un binaire sans bac à sable (`--no-sandbox`), en connaissance de cause.
//   - seulement http://localhost:<port>, http://127.0.0.1:<port>, http://[::1]:<port>, port permis (portPermis : ni Meydan,
//     ni les ports refusés, ni la plage éphémère), pour CHAQUE connexion :
//       1. un mandataire SOCKS5 propre à chaque navigateur, seul chemin réseau de Chromium (--proxy-server, et
//          --proxy-bypass-list=<-loopback> pour que la boucle locale y passe aussi) : il refuse tout ce qui n'est pas
//          exactement un de ces trois noms et un port permis, sans jamais résoudre un nom. Il voit tout ce que Chromium ouvre
//          (pages, workers, service workers, WebSocket, préchargements, services de Chromium lui-même) ;
//       2. --host-resolver-rules : aucune résolution de nom par Chromium (hors l'adresse du mandataire) ;
//       3. l'interception CDP (Fetch, motif « * ») sur la page : ce qui sort de la règle échoue en BlockedByClient et
//          s'écrit au journal de la page ;
//       4. WebRTC sans UDP hors mandataire, par les DEUX moyens (sondé le 13/11, témoin UDP : le Chromium du snap ne lit
//          que la préférence `webrtc.ip_handling_policy` du profil, chrome-headless-shell que le drapeau
//          --force-webrtc-ip-handling-policy ; chacun seul laisse partir le STUN), et pas de mDNS
//          (--disable-features=WebRtcHideLocalIpsWithMdns…, sinon Chromium écoute 224.0.0.251:5353).
//     Sondé le 13/11 : avec un mandataire « mort » et Fetch seuls, un WebSocket de la page, ou d'un worker, vers
//     127.0.0.1:<port refusé> ARRIVE (Fetch ne voit pas les WebSocket, et la boucle locale ne passe par aucun mandataire
//     sans <-loopback>) ; avec ce mandataire, rien n'arrive.
//   - rien de la session de Meydan : profil neuf par navigateur (dossier 0700, effacé à la fermeture), environnement réduit
//     (aucune variable de Meydan), aucun cookie ni en-tête de Meydan transmis.
//   - un navigateur par console, MEYDAN_NAV_MAX (3) vivants en tout ; fermé avec la console, sur `meydan nav ferme`, après
//     MEYDAN_NAV_INACTIF_MS (10 min) sans commande de l'agent ; tué par groupe de processus ; mort seul : constaté, nettoyé.
//   - une commande à la fois par console (file), chacune avec son délai ; textes rendus sans caractère de contrôle, bornés ;
//     sélecteurs et textes de l'agent passés en ARGUMENTS CDP (jamais collés dans du code).
//
// Contrat (server.mjs) :
//   ouvreNavigateurs({ DATA, send, readJson, broadcast, find, portPermis, dossierCaptures, cartes, originOk }) →
//     agent(req, res, url, me)  : /agent/nav… (jeton de la console `me` déjà vérifié, boucle locale seulement)
//     api(req, res, url, parts) : /api/nav… (porte de session passée ; origine revérifiée ici, même en GET)
//     ws(ws, consoleId)         : /ws/nav/<console> (session et origine déjà vérifiées ; lecture seule)
//     ferme(consoleId)          : la console part, son navigateur et sa carte aussi
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'

const BIN = process.env.MEYDAN_NAV_BIN || '/snap/bin/chromium'
const SANS_BAC = process.env.MEYDAN_NAV_SANS_BAC === '1'
const MAX = Math.max(1, Math.min(10, Number(process.env.MEYDAN_NAV_MAX) || 3))
const INACTIF_MS = Math.max(1000, Number(process.env.MEYDAN_NAV_INACTIF_MS) || 10 * 60 * 1000)
// Profils : sous ~/snap/chromium/common (le Chromium du snap ne voit ni /tmp ni les dossiers cachés de ~), un dossier par
// serveur (empreinte de son DATA : un serveur d'essai ne touche jamais aux profils de la production).
const PROFILS = process.env.MEYDAN_NAV_PROFILS || path.join(os.homedir(), 'snap', 'chromium', 'common', 'meydan-nav')
const LARGEUR = 1280
const HAUTEUR = 800
const DELAI = { lancement: 30000, navigation: 20000, commande: 10000, capture: 15000 }
const TEXTE_MAX = 20000 // caractères rendus par `meydan nav texte`
const LIGNE_MAX = 500 // une entrée du journal
const JOURNAL_MAX = 200 // entrées gardées
const SORTIE_MAX = 20000 // caractères rendus par `meydan nav console`
const SAISIE_MAX = 10000 // caractères tapés d'un coup
// Un message CDP : 2 Mo au plus (au-delà, jeté jusqu'au NUL suivant, jamais accumulé ni analysé : une page qui écrit
// 'a b'.repeat(1e7) dans sa console figeait le serveur et le menait à 2,1 Go, relecture du 13/11) ; 64 Mo seulement
// pendant qu'une capture est attendue (PNG en base64).
const MESSAGE_MAX = 2 * 1024 * 1024
const GROS_MAX = 64 * 1024 * 1024
const PORTS_MAX = 20 // ports ouverts ou permis par navigateur
// Profil : mesuré toutes les VEILLE_MS, navigateur fermé au-delà de PROFIL_MAX (une page peut écrire des Go : Cache, IndexedDB).
const PROFIL_MAX = Math.max(1, Number(process.env.MEYDAN_NAV_PROFIL_MAX_MO) || 500) * 1024 * 1024
const VEILLE_MS = Math.max(500, Number(process.env.MEYDAN_NAV_VEILLE_MS) || 10000)
// Plafond mémoire de chaque navigateur (cgroup systemd : scope à lui, ou celui où le snap le place).
const MEMOIRE_MO = Math.max(200, Number(process.env.MEYDAN_NAV_MEMOIRE_MO) || 1536)
// ESSAI SEULEMENT (test/volets/copies/nav-api.mjs) : une tuile qui se branche pendant une navigation ne lance sa diffusion
// qu'à la réponse de Page.navigate, dans la fenêtre (~3 ms) où Chromium refuse Page.startScreencast et la capture (« Not
// attached to an active page ») : le défaut intermittent du banc de la tuile (13/11) devient sûr à reproduire.
const ESSAI_FENETRE = process.env.MEYDAN_NAV_ESSAI_FENETRE === '1'
const CAPTURES_GARDEES = 50 // captures `nav-*.png` gardées par console (les plus récentes)
const LIAISONS_MAX = 256 // connexions ouvertes en même temps par le mandataire d'un navigateur
const IMAGE_INTERVALLE_MS = 200 // au plus 5 images par seconde vers les tuiles (l'acquittement est retardé d'autant)
const CONSOLE = /^c[0-9a-f]{8}$/
const NOMS = new Set(['localhost', '127.0.0.1', '[::1]']) // noms d'hôte permis, écrits exactement ainsi

const refus = (message, code = 400) => Object.assign(new Error(message), { code })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Textes rendus à l'agent (ils finissent dans son terminal) et à la page d'Orkun ──
// Séquences d'échappement entières d'abord (CSI, OSC, DCS…), puis tout caractère de contrôle, de format (bidi, largeur
// nulle), privé, non attribué ou demi-paire, par RETRAIT. Les retours de ligne et tabulations restent dans un texte long.
const SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g
const INVISIBLES = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu
// Coupé d'abord (4 × max : ce qu'on retire en nettoyant), pour que rien ne travaille sur un texte de 20 Mo ; puis
// seulement des passes linéaires (`[ \t]+\n` était quadratique : 3 s pour ' \t' × 40 000, relecture du 13/11).
export function propre(v, max, lignes = false) {
  const brut = String(v ?? '')
  let t = brut.slice(0, max * 4).replace(/\r\n?/g, '\n').replace(SEQUENCES, '')
  t = t.replace(INVISIBLES, (c) => (c === '\n' || c === '\t' ? (lignes ? c : ' ') : ''))
  t = lignes
    ? t
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : t.replace(/\s+/g, ' ').trim()
  if (t.length > max || brut.length > max * 4) t = `${t.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')}… (tronqué : ${brut.length} caractères au départ)`
  return t
}
// Une valeur venue de la page, coupée AVANT tout traitement (journal, refus, dialogues).
const borne = (v, n = LIGNE_MAX * 2) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)).slice(0, n)

// ── Adresses ──
// Ce que l'agent demande d'ouvrir : le texte BRUT doit déjà avoir la forme exacte (`new URL` remet 2130706433, 0x7f000001
// ou 127.1 en 127.0.0.1 : une comparaison après analyse seule les accepterait), puis l'analyse doit redonner le même hôte
// et le même port. Refuser est toujours sûr.
const BRUT = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?=[/?#]|$)/
export function adresseAgent(texte, portPermis) {
  const s = String(texte ?? '').trim()
  const forme = 'adresse refusée : seulement http://localhost:<port>/…, http://127.0.0.1:<port>/… ou http://[::1]:<port>/… (port écrit en entier)'
  if (!s || s.length > 2000 || /[\s\p{Cc}\p{Cf}]/u.test(s)) throw refus(forme)
  const m = BRUT.exec(s)
  if (!m) throw refus(forme)
  let u
  try {
    u = new URL(s)
  } catch {
    throw refus(forme)
  }
  if (u.protocol !== 'http:' || u.hostname !== m[1] || u.username || u.password || Number(u.port || 80) !== Number(m[2])) throw refus(forme)
  const raison = portPermis(Number(m[2]))
  if (raison) throw refus(raison)
  return u.href
}
// Une requête vue par l'interception (forme canonique, celle de Chromium) : '' si permise, sinon la raison.
function raisonRequete(texte, portPermis, ouverts) {
  let u
  try {
    u = new URL(texte)
  } catch {
    return 'adresse illisible'
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return '' // contenu déjà dans la page : aucune connexion
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return `protocole ${u.protocol} refusé`
  if (u.username || u.password) return 'identifiants dans l’adresse refusés'
  if (!NOMS.has(u.hostname)) return `hôte ${u.hostname} refusé (seulement localhost, 127.0.0.1, [::1])`
  if (!u.port) return 'port implicite refusé'
  return portPermis(Number(u.port)) || ouverts(Number(u.port))
}

// ── Mandataire SOCKS5 d'un navigateur (RFC 1928, sans authentification, CONNECT seulement) ──
// Destination permise : exactement localhost, 127.0.0.1 ou ::1, et un port permis. Le nom n'est jamais résolu : localhost
// est relié à 127.0.0.1, puis ::1 si rien n'y répond (un serveur de développement n'écoute parfois que sur ::1).
function ouvreMandataire({ regle, refuse }) {
  const liaisons = new Set()
  const repond = (c, code) => c.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
  const serveur = net.createServer((c) => {
    c.on('error', () => {})
    if (liaisons.size >= LIAISONS_MAX) return c.destroy()
    liaisons.add(c)
    c.on('close', () => liaisons.delete(c))
    c.setTimeout(10000, () => c.destroy()) // poignée de main muette
    let tampon = Buffer.alloc(0)
    let etape = 0
    const lis = (d) => {
      tampon = Buffer.concat([tampon, d])
      if (tampon.length > 600) return c.destroy()
      if (etape === 0) {
        if (tampon.length < 2 || tampon.length < 2 + tampon[1]) return
        if (tampon[0] !== 5) return c.destroy()
        const sansAuth = tampon.subarray(2, 2 + tampon[1]).includes(0)
        tampon = tampon.subarray(2 + tampon[1])
        if (!sansAuth) return c.end(Buffer.from([5, 0xff]))
        c.write(Buffer.from([5, 0]))
        etape = 1
      }
      if (tampon.length < 5) return
      if (tampon[0] !== 5) return c.destroy()
      let hote
      let fin
      if (tampon[3] === 1) {
        if (tampon.length < 10) return
        hote = [...tampon.subarray(4, 8)].join('.')
        fin = 8
      } else if (tampon[3] === 3) {
        if (tampon.length < 7 + tampon[4]) return
        hote = tampon.subarray(5, 5 + tampon[4]).toString('latin1')
        fin = 5 + tampon[4]
      } else if (tampon[3] === 4) {
        if (tampon.length < 22) return
        const o = tampon.subarray(4, 20)
        hote = o.subarray(0, 15).every((x) => x === 0) && o[15] === 1 ? '::1' : `[${o.toString('hex').replace(/(.{4})(?!$)/g, '$1:')}]`
        fin = 20
      } else return repond(c, 8) // type d'adresse inconnu
      const port = tampon.readUInt16BE(fin)
      const reste = tampon.subarray(fin + 2)
      c.removeListener('data', lis)
      c.setTimeout(0)
      if (tampon[1] !== 1) {
        refuse(`${propre(hote, 120)}:${port}`, 'seule la connexion directe (CONNECT) est permise')
        return repond(c, 7)
      }
      const raison = hote === 'localhost' || hote === '127.0.0.1' || hote === '::1' ? regle(port) : 'hôte hors de la boucle locale'
      if (raison) {
        refuse(`${propre(hote, 120)}:${port}`, raison)
        return repond(c, 2)
      }
      relie(c, hote === '::1' ? ['::1'] : hote === '127.0.0.1' ? ['127.0.0.1'] : ['127.0.0.1', '::1'], port, reste)
    }
    c.on('data', lis)
  })
  function relie(c, hotes, port, reste) {
    if (c.destroyed) return
    const a = net.connect({ host: hotes[0], port })
    const coupe = () => a.destroy() // le client part pendant la connexion à l'amont : l'amont aussi
    c.once('close', coupe)
    a.once('connect', () => {
      a.removeAllListeners('error')
      a.on('error', () => c.destroy())
      c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      if (reste.length) a.write(reste)
      a.pipe(c)
      c.pipe(a)
      a.on('close', () => c.destroy())
    })
    a.once('error', () => {
      c.removeListener('close', coupe)
      if (hotes.length > 1 && !c.destroyed) relie(c, hotes.slice(1), port, reste)
      else if (!c.destroyed) repond(c, 5)
    })
  }
  return new Promise((resolve, reject) => {
    serveur.once('error', reject)
    serveur.listen(0, '127.0.0.1', () =>
      resolve({
        port: serveur.address().port,
        ferme() {
          serveur.close()
          for (const l of liaisons) l.destroy()
        },
      }),
    )
  })
}

// ── Client CDP sur le tube ──
function tubeCdp(ecrit, lit, jete) {
  let n = 0
  let morceaux = []
  let taille = 0
  let gros = 0 // appels en cours dont la réponse peut dépasser MESSAGE_MAX (captures)
  let jette = false // un message trop long : ses octets sont jetés jusqu'au NUL qui le termine
  const DEBUT = Buffer.from('{"id":')
  const reponse = () => (morceaux[0].length >= DEBUT.length ? morceaux[0] : Buffer.concat(morceaux)).subarray(0, DEBUT.length).equals(DEBUT)
  const attente = new Map()
  const ecouteurs = new Set()
  const traite = (brut) => {
    let m
    try {
      m = JSON.parse(brut.toString('utf8'))
    } catch {
      return // message illisible : ignoré
    }
    if (m.id !== undefined) {
      const a = attente.get(m.id)
      if (!a) return
      attente.delete(m.id)
      clearTimeout(a.minuteur)
      if (m.error) a.rejette(refus(`navigateur : ${propre(m.error.message, 200)}`, 502))
      else a.resout(m.result || {})
    } else
      for (const f of ecouteurs) {
        try {
          f(m)
        } catch (e) {
          console.error(`[nav] événement ${m.method} : ${e.message}`)
        }
      }
  }
  lit.on('data', (d) => {
    let debut = 0
    let i
    while ((i = d.indexOf(0, debut)) >= 0) {
      if (jette) jette = false // fin du message trop long : rien à analyser
      else {
        morceaux.push(d.subarray(debut, i))
        const brut = morceaux.length === 1 ? morceaux[0] : Buffer.concat(morceaux)
        traite(brut)
      }
      morceaux = []
      taille = 0
      debut = i + 1
    }
    if (debut < d.length && !jette) {
      morceaux.push(d.subarray(debut))
      taille += d.length - debut
      // Au-delà de 2 Mo, seule une RÉPONSE attendue (« {"id": ») peut continuer pendant qu'une capture est attendue ; un
      // événement de la page (console, exception…) jamais.
      if (taille > MESSAGE_MAX && (!gros || taille > GROS_MAX || !reponse())) {
        morceaux = []
        taille = 0
        jette = true
        jete()
      }
    }
  })
  const coupe = (raison) => {
    for (const a of attente.values()) {
      clearTimeout(a.minuteur)
      a.rejette(refus(raison, 503))
    }
    attente.clear()
  }
  return {
    // `grosse` : la réponse peut dépasser MESSAGE_MAX (capture) ; le plafond monte à GROS_MAX tant qu'elle est attendue.
    appel(method, params = {}, sessionId, ms = DELAI.commande, grosse = false) {
      const p = new Promise((resout, rejette) => {
        if (ecrit.destroyed) return rejette(refus('navigateur fermé', 503))
        const id = ++n
        const minuteur = setTimeout(() => {
          attente.delete(id)
          rejette(refus(`le navigateur n’a pas répondu à temps (${method}, ${Math.round(ms / 1000)} s)`, 504))
        }, ms)
        attente.set(id, { resout, rejette, minuteur })
        ecrit.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
      })
      if (!grosse) return p
      gros++
      return p.finally(() => gros--)
    },
    ecoute: (f) => ecouteurs.add(f),
    coupe,
  }
}

// ── Exécutées DANS la page, dans un monde isolé (les scripts de la page ne les voient pas et ne peuvent pas les fausser),
// avec leurs arguments passés par CDP : jamais de texte de l'agent collé dans du code. ──
function pageVise(selecteur, saisie) {
  let el
  try {
    el = document.querySelector(selecteur)
  } catch {
    return { erreur: 'sélecteur CSS invalide' }
  }
  if (!el) return { erreur: 'aucun élément ne correspond à ce sélecteur' }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  if (!(r.width > 0 && r.height > 0)) return { erreur: 'élément invisible (taille nulle)' }
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const dessus = document.elementFromPoint(x, y)
  const texte = String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 80)
  if (saisie) {
    el.focus()
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.select === 'function') el.select()
    else if (el.isContentEditable) {
      const plage = document.createRange()
      plage.selectNodeContents(el)
      getSelection().removeAllRanges()
      getSelection().addRange(plage)
    } else return { erreur: 'cet élément n’est pas un champ de saisie (input, textarea ou contenteditable)' }
    if (document.activeElement !== el) return { erreur: 'le champ n’a pas pris le focus (désactivé ?)' }
  }
  return { x, y, nom: el.tagName.toLowerCase(), texte, couvert: Boolean(dessus) && dessus !== el && !el.contains(dessus) }
}
function pageTexte(max) {
  const racine = document.body || document.documentElement
  return { titre: document.title, url: location.href, texte: String(racine ? racine.innerText : '').slice(0, max) }
}

// Retire WebRTC d'un document (fenêtre ou cadre), avant ses propres scripts : propriétés remplacées par `undefined`, non
// configurables (la page ne peut pas les remettre).
const SANS_RTC = `(() => { for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) { try { Object.defineProperty(globalThis, n, { value: undefined, writable: false, configurable: false, enumerable: false }) } catch (e) {} } })()`

// Ce qu'une erreur de navigation de Chromium veut dire pour l'agent.
const INDICES = [
  [/BLOCKED_BY_CLIENT/, 'adresse refusée par le navigateur de Meydan (détail : meydan nav console)'],
  [/SOCKS|PROXY|TUNNEL/, 'connexion impossible : rien n’écoute sur ce port, ou destination refusée (détail : meydan nav console)'],
  [/CONNECTION_REFUSED/, 'rien n’écoute sur ce port'],
]
const valeurConsole = (a) => borne(a.type === 'string' ? a.value : a.value !== undefined ? borne(JSON.stringify(a.value)) : a.unserializableValue || a.description || a.type)

export function ouvreNavigateurs({ DATA, send, readJson, broadcast, find, portPermis, dossierCaptures, cartes, originOk }) {
  const RACINE = path.join(PROFILS, crypto.createHash('sha256').update(path.resolve(DATA)).digest('hex').slice(0, 16))
  // Restes d'un serveur précédent sur ce même DATA (arrêté ou tué : ses Chromium sont partis avec le tube) : effacés.
  try {
    fs.rmSync(RACINE, { recursive: true, force: true })
  } catch (e) {
    console.error(`[nav] profils d'avant non effacés : ${e.message}`)
  }
  // Environnement de Chromium : liste blanche, rien du serveur (ni jeton, ni clé, ni variable de Meydan).
  // XDG_RUNTIME_DIR : pour joindre le systemd de l'utilisateur (scope à plafond mémoire), comme le tmux du serveur.
  const ENV = { HOME: os.homedir(), USER: os.userInfo().username, LOGNAME: os.userInfo().username, PATH: process.env.PATH || '/usr/bin:/bin:/snap/bin', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}` }
  // Chaque Chromium dans un scope systemd à lui, plafonné en mémoire (MemoryMax). Le Chromium du snap se replace lui-même
  // dans son scope « snap.chromium.* » (sondé le 13/11 : plafond perdu) : ce scope-là reçoit le plafond après le lancement
  // (systemctl --user set-property --runtime). Sans systemd de l'utilisateur : lancé tel quel, sans plafond (dit au journal).
  const SCOPE = (() => {
    try {
      execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'], { env: ENV, stdio: 'ignore', timeout: 5000 })
      return true
    } catch {
      return false
    }
  })()
  const navs = new Map() // console → navigateur vivant (ou en lancement)
  const fermant = new Set() // navigateurs en train de se fermer : ils comptent encore dans le plafond MAX
  const fermees = new Set() // consoles parties : plus aucune commande ni aucun lancement pour elles
  const portsDe = new Map() // console → ports que l'agent a ouverts (`ouvre`) ou permis (`permet`) : la liste BLANCHE
  const fins = new Map() // console → pourquoi son dernier navigateur s'est fermé (dit à l'agent)
  const etats = new Map() // console → { console, ouvert, url, titre, depuis, maj }, gardé après la fermeture
  const journaux = new Map() // console → lignes du journal de la page (gardé après la fermeture : pourquoi s'est-il fermé ?)
  const regards = new Map() // console → tuiles qui regardent (WebSocket)
  const files = new Map() // console → fin de la dernière commande
  const publications = new Map() // console → publication différée de l'état

  // ── État, rendu à la page d'Orkun ──
  const etatDe = (id) => etats.get(id) || { console: id, ouvert: false, url: '', titre: '', depuis: 0, maj: 0 }
  function publie(id) {
    const e = etatDe(id)
    broadcast({ type: 'nav', nav: { console: id, ouvert: e.ouvert, url: e.url, titre: e.titre, maj: e.maj } })
    const msg = JSON.stringify({ type: 'etat', ouvert: e.ouvert, url: e.url, titre: e.titre })
    for (const ws of regards.get(id) || []) if (ws.readyState === 1) ws.send(msg)
  }
  // Plusieurs changements de suite (navigation, puis titre) : une seule publication.
  function change(id, champs) {
    const avant = etatDe(id)
    const e = { ...avant, ...champs }
    if (e.ouvert === avant.ouvert && e.url === avant.url && e.titre === avant.titre && etats.has(id)) return
    etats.set(id, { ...e, maj: Date.now() })
    clearTimeout(publications.get(id))
    publications.set(id, setTimeout(() => (publications.delete(id), publie(id)), 50))
  }
  function note(id, genre, texte) {
    const j = journaux.get(id)
    if (!j) return
    j.push(`${new Date().toISOString().slice(11, 19)} ${genre} : ${propre(texte, LIGNE_MAX)}`)
    if (j.length > JOURNAL_MAX) j.splice(0, j.length - JOURNAL_MAX)
  }

  // ── Liste blanche des ports : seulement ceux que l'agent a ouverts (`ouvre`) ou permis (`permet`) pour ce navigateur ──
  const ouvert = (id, port) => (portsDe.get(id)?.has(port) ? '' : `port ${port} ni ouvert ni permis par l’agent (meydan nav permet ${port})`)
  function permetPort(id, port) {
    const raison = portPermis(port)
    if (raison) throw refus(raison)
    const s = portsDe.get(id) || new Set()
    if (!s.has(port) && s.size >= PORTS_MAX) throw refus(`${PORTS_MAX} ports au plus par navigateur`, 409)
    s.add(port)
    portsDe.set(id, s)
  }

  // ── Plafond mémoire : le cgroup où Chromium vit vraiment (scope à nous, ou celui du snap) ──
  const lis = (f) => fs.promises.readFile(f, 'utf8').then((t) => t.trim(), () => '')
  async function plafonne(n) {
    try {
      const cg = (await lis(`/proc/${n.proc.pid}/cgroup`)).replace(/^0::/, '')
      const unite = path.basename(cg)
      const fichier = path.join('/sys/fs/cgroup', cg, 'memory.max')
      const echange = path.join('/sys/fs/cgroup', cg, 'memory.swap.max')
      const voulu = String(MEMOIRE_MO * 1024 * 1024)
      // Sans MemorySwapMax=0, le plafond atteint fait partir la page en mémoire d'échange (elle rame au lieu d'être
      // arrêtée : relevé le 13/11, une page qui dévore restait « ouverte » sans avancer).
      if ((await lis(fichier)) !== voulu || (await lis(echange)) !== '0') {
        // Seulement le scope du snap (jamais le groupe du serveur : il plafonnerait Meydan entier).
        if (!/^snap\.chromium\.[A-Za-z0-9._-]+\.scope$/.test(unite)) throw new Error(`groupe ${unite || 'inconnu'}`)
        await new Promise((ok, ko) => execFile('systemctl', ['--user', 'set-property', '--runtime', unite, `MemoryMax=${MEMOIRE_MO}M`, 'MemorySwapMax=0'], { env: ENV, timeout: 5000 }, (e) => (e ? ko(e) : ok())))
      }
      if ((await lis(fichier)) !== voulu || (await lis(echange)) !== '0') throw new Error('memory.max ou memory.swap.max non relus')
      n.plafond = unite
      console.log(`[nav] ${n.console} : plafond mémoire ${MEMOIRE_MO} Mo, sans mémoire d'échange (${unite})`)
    } catch (e) {
      console.error(`[nav] ${n.console} : SANS plafond mémoire (${propre(e.message, 200)})`)
    }
  }

  // ── Veille du profil : taille mesurée (parcours borné), navigateur fermé au-delà de PROFIL_MAX ──
  async function tailleDossier(dir, plafond) {
    let total = 0
    let vus = 0
    const pile = [dir]
    while (pile.length) {
      const d = pile.pop()
      const entrees = await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])
      for (const e of entrees) {
        if (++vus > 200000) return Infinity // trop de fichiers pour être mesuré : compté comme trop gros
        if (total > plafond) return total
        const f = path.join(d, e.name)
        if (e.isDirectory()) pile.push(f)
        else if (e.isFile()) total += await fs.promises.lstat(f).then((st) => Math.max(st.size, st.blocks * 512), () => 0)
      }
    }
    return total
  }
  async function veilleProfil(n) {
    if (n.fini || n.mesure) return
    n.mesure = true
    try {
      const t = await tailleDossier(n.profil, PROFIL_MAX)
      if (t > PROFIL_MAX && !n.fini) {
        const raison = `la page a écrit plus de ${Math.round(PROFIL_MAX / 1048576)} Mo${t === Infinity ? ' (ou plus de 200 000 fichiers)' : ''} dans le profil du navigateur (cache, stockage) : fermé`
        note(n.console, 'navigateur', raison)
        await termine(n, raison)
      }
    } finally {
      n.mesure = false
    }
  }

  // ── Profils ──
  function nouveauProfil() {
    for (const d of [PROFILS, RACINE]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 })
      const st = fs.lstatSync(d)
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw refus('dossier des profils du navigateur inutilisable', 500)
      if (st.mode & 0o077) fs.chmodSync(d, 0o700)
    }
    const profil = fs.mkdtempSync(path.join(RACINE, 'p-')) // 0700
    // Préférences du profil neuf, lues au lancement : WebRTC n'envoie rien en UDP hors mandataire (aucun mandataire UDP
    // ici : donc rien en UDP), et n'énumère pas les adresses de la machine.
    fs.mkdirSync(path.join(profil, 'Default'), { mode: 0o700 })
    fs.writeFileSync(path.join(profil, 'Default', 'Preferences'), JSON.stringify({ webrtc: { ip_handling_policy: 'disable_non_proxied_udp', multiple_routes_enabled: false, nonproxied_udp_enabled: false } }), { mode: 0o600 })
    return profil
  }
  // Les processus de CE navigateur : ceux qui portent son profil sur leur ligne de commande, et ceux de son groupe qui
  // sont un Chromium (certains processus de chrome-headless-shell ne portent pas le profil). Jamais un motif plus large.
  function processusDe(n) {
    const marque = `--user-data-dir=${n.profil}`
    const out = []
    for (const p of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(p)) continue
      try {
        if (fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').includes(marque)) out.push(Number(p))
        else {
          const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8')
          const groupe = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
          if (groupe === n.proc?.pid && /chrom/i.test(path.basename(fs.readlinkSync(`/proc/${p}/exe`)))) out.push(Number(p))
        }
      } catch {} // processus parti entre-temps, ou pas à nous
    }
    return out
  }
  const sortie = (proc, ms) =>
    proc.exitCode !== null || proc.signalCode !== null
      ? Promise.resolve(true)
      : new Promise((r) => {
          const t = setTimeout(() => r(false), ms)
          proc.once('exit', () => (clearTimeout(t), r(true)))
        })

  // ── Fermeture (idempotente) : Browser.close, puis le groupe tué tant que son meneur vit (son numéro ne peut pas avoir été
  // repris), puis tout processus restant qui porte ce profil, puis le profil effacé.
  function termine(n, raison) {
    if (n.fini) return n.finPromesse
    n.fini = true
    fermant.add(n) // la place n'est rendue qu'à la mort réelle de Chromium
    n.finPromesse = (async () => {
      if (navs.get(n.console) === n) navs.delete(n.console)
      clearTimeout(n.minuteur)
      clearTimeout(n.reprise)
      clearInterval(n.veille)
      n.diffuse = false
      fins.set(n.console, raison)
      portsDe.delete(n.console) // la liste des ports vaut pour CE navigateur
      if (n.proc && n.proc.exitCode === null && n.proc.signalCode === null) {
        if (n.cdp && n.pret) await n.cdp.appel('Browser.close', {}, undefined, 2000).catch(() => {})
        if (!(await sortie(n.proc, 2000))) {
          try {
            process.kill(-n.proc.pid, 'SIGKILL')
          } catch {} // groupe déjà parti
          await sortie(n.proc, 3000)
        }
      }
      n.cdp?.coupe('navigateur fermé')
      for (const s of [n.proc?.stdio?.[3], n.proc?.stdio?.[4]]) s?.destroy()
      n.mandataire?.ferme()
      if (n.profil) {
        for (let essai = 0; essai < 5; essai++) {
          const restes = processusDe(n)
          if (!restes.length) break
          for (const pid of restes) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {}
          }
          await sleep(200)
        }
        await fs.promises.rm(n.profil, { recursive: true, force: true, maxRetries: 3 }).catch((e) => console.error(`[nav] profil non effacé ${n.profil} : ${e.message}`))
      }
      fermant.delete(n)
      note(n.console, 'navigateur', `fermé (${raison})`)
      if (etats.has(n.console)) change(n.console, { ouvert: false })
      else broadcast({ type: 'nav', nav: { console: n.console, ouvert: false, url: '', titre: '', maj: Date.now() } })
      console.log(`[nav] ${n.console} : navigateur fermé (${raison})`)
    })()
    return n.finPromesse
  }

  // ── Lancement ──
  async function lance(c) {
    if (fermees.has(c.id) || !find(c.id)) throw refus('console fermée', 409)
    if (navs.size + fermant.size >= MAX) throw refus(`déjà ${MAX} navigateur(s) ouvert(s) sur ce Meydan (un par console) : ferme-en un (meydan nav ferme, dans sa console) ou attends qu’il se ferme seul après ${Math.round(INACTIF_MS / 60000)} min sans commande`, 409)
    const n = { console: c.id, fini: false, pret: false, diffuse: false, image: null, imageLe: 0, cycles: new Map(), attentes: new Set(), navigation: null }
    navs.set(c.id, n) // la place est prise dès maintenant
    journaux.set(c.id, [])
    try {
      // Chaque refus du mandataire va au journal de la page, une fois par destination et par 30 s (Chromium relance ses
      // propres services, www.google.com et accounts.google.com, toujours refusés : le journal ne s'en remplit pas). Remis à
      // zéro avec le journal, à chaque `ouvre`.
      n.dejaNotes = new Map()
      n.mandataire = await ouvreMandataire({
        regle: (port) => portPermis(port) || ouvert(c.id, port),
        refuse: (dest, raison) => {
          if (Date.now() - (n.dejaNotes.get(dest) || 0) < 30000) return
          n.dejaNotes.set(dest, Date.now())
          if (n.dejaNotes.size > 500) n.dejaNotes.clear()
          note(c.id, 'réseau refusé', `${dest} — ${raison}`)
        },
      })
      // La console a pu partir pendant l'attente (ferme → termine) : aucun Chromium lancé pour personne.
      if (n.fini || fermees.has(c.id)) {
        n.mandataire.ferme()
        throw refus('console fermée pendant le lancement', 409)
      }
      n.profil = nouveauProfil()
      const args = [
        ...(SANS_BAC ? ['--no-sandbox'] : []),
        '--headless=new',
        '--remote-debugging-pipe', // et aucun --remote-debugging-port : aucune porte de débogage n'écoute
        `--user-data-dir=${n.profil}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-domain-reliability',
        '--disable-client-side-phishing-detection',
        '--disable-breakpad',
        '--disable-field-trial-config',
        '--disable-search-engine-choice-screen',
        '--disable-component-extensions-with-background-pages',
        '--metrics-recording-only',
        '--no-pings',
        '--deny-permission-prompts',
        '--password-store=basic',
        '--use-mock-keychain',
        '--mute-audio',
        '--hide-scrollbars',
        `--window-size=${LARGEUR},${HAUTEUR}`,
        `--proxy-server=socks5://127.0.0.1:${n.mandataire.port}`,
        '--proxy-bypass-list=<-loopback>',
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // chrome-headless-shell (le snap : préférence du profil)
        '--disable-features=WebRtcHideLocalIpsWithMdns,MediaRouter,DialMediaRouteProvider,CastMediaRouteProvider,Translate,OptimizationHints',
        'about:blank',
      ]
      // Liste d'arguments, sans shell ; groupe de processus à lui (tué d'un coup) ; fd 3 et 4 : le tube CDP. Par systemd-run
      // --scope (qui exécute Chromium à sa place : même numéro de processus, même tube), plafonné en mémoire.
      const commande = SCOPE ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${MEMOIRE_MO}M`, '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=kill', '--', BIN, ...args]] : [BIN, args]
      n.proc = spawn(commande[0], commande[1], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true, cwd: n.profil, env: ENV })
      let erreurs = ''
      n.proc.on('error', (e) => termine(n, `lancement impossible (${e.code || e.message})`))
      n.proc.once('exit', (code, sig) => {
        if (!n.fini) {
          if (erreurs) console.error(`[nav] ${c.id} : fin de la sortie d'erreur de Chromium :\n${erreurs.slice(-1500)}`)
          termine(n, `Chromium s’est arrêté seul (${sig || `code ${code}`})`)
        }
      })
      for (const s of n.proc.stdio) s?.on('error', () => {}) // un tube cassé ne doit jamais faire tomber le serveur
      n.proc.stderr.on('data', (d) => (erreurs = (erreurs + d).slice(-4000)))
      n.cdp = tubeCdp(n.proc.stdio[3], n.proc.stdio[4], () => note(c.id, 'message jeté', `un message du navigateur dépassait ${MESSAGE_MAX >> 20} Mo (une console ou une valeur énorme de la page) : il n’a pas été lu`))
      // Tube fermé : Chromium est parti (ou part). L'événement « exit » qui suit dit comment ; sinon, le tube suffit.
      n.proc.stdio[4].on('close', () => setTimeout(() => n.fini || termine(n, 'tube du navigateur fermé'), 500))
      n.cdp.ecoute((m) => evenement(n, m))
      const a = (methode, params, ms) => n.cdp.appel(methode, params, undefined, ms)
      await a('Browser.getVersion', {}, DELAI.lancement)
      await a('Browser.setDownloadBehavior', { behavior: 'deny' }) // aucun téléchargement
      const { targetInfos } = await a('Target.getTargets')
      n.cible = targetInfos.find((t) => t.type === 'page')?.targetId || (await a('Target.createTarget', { url: 'about:blank' })).targetId
      n.cadre = n.cible
      n.session = (await a('Target.attachToTarget', { targetId: n.cible, flatten: true })).sessionId
      const p = (methode, params) => n.cdp.appel(methode, params, n.session)
      await Promise.all([
        p('Page.enable'),
        p('Page.setLifecycleEventsEnabled', { enabled: true }),
        p('Runtime.enable'),
        p('Log.enable'),
        // Toute requête de la page passe ici : permise, elle continue ; sinon elle échoue (BlockedByClient) et se note.
        p('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }),
        p('Page.setInterceptFileChooserDialog', { enabled: true }), // aucun fichier du VPS ne part par un <input type=file>
        // Taille de la page fixée (la fenêtre sans écran retire sa barre : 1280 × 657 sinon) : captures et images 1280 × 800.
        p('Emulation.setDeviceMetricsOverride', { width: LARGEUR, height: HAUTEUR, deviceScaleFactor: 1, mobile: false }),
        // Plus de WebRTC dans la page (il ouvrait des sockets UDP sur 0.0.0.0, joignables selon le pare-feu) : retiré de
        // chaque document neuf, et du document actuel ; les cadres d'un autre site (autres processus) par l'attachement
        // automatique ci-dessous. Les workers n'ont pas RTCPeerConnection.
        p('Page.addScriptToEvaluateOnNewDocument', { source: SANS_RTC, runImmediately: true }),
        p('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
      ])
      await a('Target.setDiscoverTargets', { discover: true }) // fenêtres surgissantes : vues, puis fermées (evenement)
      if (fermees.has(c.id)) throw refus('console fermée', 409)
      await plafonne(n)
      n.pret = true
      // Chien de garde du profil : une page qui écrit des centaines de Mo (Cache, IndexedDB) ferme son navigateur.
      n.veille = setInterval(() => veilleProfil(n), VEILLE_MS)
      change(c.id, { ouvert: true, url: 'about:blank', titre: '', depuis: Date.now() })
      console.log(`[nav] ${c.id} : navigateur ouvert (pid ${n.proc.pid}${SANS_BAC ? ', SANS bac à sable' : ''})`)
      diffuse(n) // une tuile regardait déjà
      return n
    } catch (e) {
      await termine(n, `lancement impossible : ${e.message}`)
      throw refus(`navigateur impossible à lancer : ${propre(e.message, 300)}`, e.code === 409 ? 409 : 502)
    }
  }

  // ── Événements du navigateur ──
  function evenement(n, { method, params, sessionId }) {
    if (n.fini) return
    if (!sessionId) {
      const t = params?.targetInfo
      // Nouvelle fenêtre (window.open, lien target=_blank…) : toute autre page que la nôtre est fermée aussitôt, sauf les
      // pages internes de Chromium (chrome://…), qu'il ouvre parfois pour lui-même ; ses connexions passent par le mandataire.
      if (method === 'Target.targetCreated' && t?.type === 'page' && n.cible && t.targetId !== n.cible && !/^(chrome|chrome-untrusted|devtools):/.test(t.url || '')) {
        note(n.console, 'fenêtre refusée', `${borne(t.url, 300) || 'about:blank'} (fermée)`)
        n.cdp.appel('Target.closeTarget', { targetId: t.targetId }).catch(() => {})
      } else if (method === 'Target.targetInfoChanged' && t?.targetId === n.cible) change(n.console, { url: propre(t.url, 2000), titre: propre(t.title, 200) })
      else if (method === 'Target.targetDestroyed' && params.targetId === n.cible) termine(n, 'page fermée')
      else if (method === 'Target.targetCrashed' && params.targetId === n.cible) termine(n, `la page a planté (${borne(params.status, 40)})`)
      return
    }
    if (method === 'Target.attachedToTarget') {
      // Attaché en pause par la page ou par un de ses cadres (cadre d'un autre site dans un autre processus, worker…) :
      // WebRTC retiré d'un cadre (et ses propres sous-cadres attachés de même), puis il repart. Tout le reste repart tel quel.
      // Page.enable d'abord : sans lui, le script n'atteint pas le document du cadre (sondé le 13/11 : RTCPeerConnection
      // restait une fonction dans un cadre d'un autre site).
      const s = params.sessionId
      const a = (methode, p) => n.cdp.appel(methode, p, s)
      const suite =
        params.targetInfo?.type === 'iframe'
          ? a('Page.enable', {})
              .then(() => a('Page.addScriptToEvaluateOnNewDocument', { source: SANS_RTC, runImmediately: true }))
              .then(() => a('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }))
          : Promise.resolve()
      suite.catch(() => {}).then(() => a('Runtime.runIfWaitingForDebugger', {}).catch(() => {}))
      return
    }
    if (sessionId !== n.session) return
    if (method === 'Fetch.requestPaused') {
      const raison = raisonRequete(params.request.url, portPermis, (port) => ouvert(n.console, port))
      if (!raison) return void n.cdp.appel('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {})
      note(n.console, 'requête bloquée', `${borne(params.request.url, 2000)} — ${raison}`)
      n.cdp.appel('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {})
    } else if (method === 'Page.lifecycleEvent') {
      if (params.frameId !== n.cadre) return
      let s = n.cycles.get(params.loaderId)
      if (!s) {
        n.cycles.set(params.loaderId, (s = new Set()))
        if (n.cycles.size > 20) n.cycles.delete(n.cycles.keys().next().value)
      }
      s.add(params.name)
      for (const w of [...n.attentes]) if (w.loaderId === params.loaderId && w.nom === params.name) w.fin(true)
    } else if (method === 'Page.frameStartedNavigating') {
      if (params.frameId === n.cadre && !/samedocument/i.test(params.navigationType || '')) n.navigation = params.loaderId
    } else if (method === 'Page.frameNavigated') {
      if (!params.frame.parentId) {
        n.cadre = params.frame.id
        n.navigueLe = Date.now() // une image plus ancienne montre une autre page
        if (!n.diffuse) diffuse(n) // un départ refusé pendant la validation repart dès la page validée
        change(n.console, { url: propre(params.frame.url, 2000) })
      }
    } else if (method === 'Page.javascriptDialogOpening') {
      // alert/confirm/prompt bloqueraient la page (et toute commande) : refusés, notés. beforeunload : la page part.
      note(n.console, 'dialogue fermé', `${borne(params.type, 20)} « ${borne(params.message)} »`)
      n.cdp.appel('Page.handleJavaScriptDialog', { accept: params.type === 'beforeunload' }, sessionId).catch(() => {})
    } else if (method === 'Page.fileChooserOpened') note(n.console, 'choix de fichier refusé', 'la page a demandé un fichier : rien n’est envoyé')
    else if (method === 'Page.screencastFrame') image(n, params)
    else if (method === 'Runtime.consoleAPICalled') note(n.console, `console.${borne(params.type, 20)}`, borne((params.args || []).slice(0, 20).map(valeurConsole).join(' ')))
    else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {}
      note(n.console, 'exception', `${borne(d.exception?.description || d.text || 'erreur')}${d.url ? ` (${borne(d.url, 300)}:${(Number(d.lineNumber) || 0) + 1})` : ''}`)
    } else if (method === 'Log.entryAdded') note(n.console, `journal.${borne(params.entry?.level, 20)}`, `${borne(params.entry?.text)}${params.entry?.url ? ` (${borne(params.entry.url, 300)})` : ''}`)
    else if (method === 'Inspector.targetCrashed') termine(n, 'la page a planté')
  }
  // Le chargement `nom` (« load ») du document `loaderId` : vrai s'il arrive avant `ms`.
  function attendsCycle(n, loaderId, nom, ms) {
    if (n.cycles.get(loaderId)?.has(nom)) return Promise.resolve(true)
    return new Promise((r) => {
      const w = {
        loaderId,
        nom,
        fin: (ok) => {
          clearTimeout(t)
          n.attentes.delete(w)
          r(ok)
        },
      }
      const t = setTimeout(() => w.fin(false), ms)
      n.attentes.add(w)
    })
  }

  // ── Ce que voient les tuiles : screencast CDP, lancé seulement tant qu'au moins une tuile regarde ──
  // Chromium refuse Page.startScreencast (et la capture) pendant la validation d'une navigation : entre la réponse de
  // Page.navigate et frameNavigated (~3 ms), « Not attached to an active page ». Une tuile qui se branchait là ne recevait
  // plus aucune image (défaut intermittent du banc de la tuile, 13/11) : le départ refusé est dit au journal et relancé, à
  // la validation de la page (frameNavigated) ou dans un instant (100 ms, puis de plus en plus espacé).
  function diffuse(n) {
    if (n.diffuse || !n.pret || n.fini || !regards.get(n.console)?.size) return
    n.diffuse = true
    clearTimeout(n.reprise)
    console.log(`[nav] ${n.console} : diffusion lancée (${regards.get(n.console).size} tuile(s))`)
    n.cdp.appel('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: LARGEUR, maxHeight: HAUTEUR, everyNthFrame: 1 }, n.session).then(
      () => (n.departsRefuses = 0),
      (e) => {
        n.diffuse = false
        if (n.fini) return
        const k = (n.departsRefuses = (n.departsRefuses || 0) + 1)
        console.error(`[nav] ${n.console} : diffusion : départ refusé par Chromium (${propre(e.message, 120)}), essai ${k}`)
        if (k <= 8) n.reprise = setTimeout(() => diffuse(n), Math.min(2000, 100 * 2 ** (k - 1)))
      },
    )
  }
  function arreteDiffusion(n) {
    if (!n.diffuse) return
    n.diffuse = false
    console.log(`[nav] ${n.console} : diffusion arrêtée (plus aucune tuile ne regarde)`)
    n.cdp.appel('Page.stopScreencast', {}, n.session).catch(() => {})
  }
  // Une capture JPEG à la demande, une par seconde au plus (les demandes simultanées partagent la même).
  async function captureJpeg(n) {
    if (n.image && Date.now() - n.imageLe <= 1000 && n.imageLe >= (n.navigueLe || 0)) return n.image
    n.captureJpeg ||= n.cdp
      .appel('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, n.session, DELAI.capture, true)
      .then((r) => {
        n.image = Buffer.from(String(r.data || ''), 'base64')
        n.imageLe = Date.now()
      })
      .finally(() => (n.captureJpeg = null))
    await n.captureJpeg.catch(() => {})
    return n.image
  }
  function image(n, p) {
    const buf = Buffer.from(String(p.data || ''), 'base64')
    n.image = buf
    n.imageLe = Date.now()
    for (const ws of regards.get(n.console) || []) if (ws.readyState === 1 && ws.bufferedAmount < 4 << 20) ws.send(buf) // binaire : une image JPEG
    // Chaque image est acquittée ; l'acquittement retardé règle le débit (Chromium attend l'acquittement pour la suivante).
    const reste = Math.max(0, IMAGE_INTERVALLE_MS - (Date.now() - (n.acquitteLe || 0)))
    setTimeout(() => {
      n.acquitteLe = Date.now()
      if (!n.fini) n.cdp.appel('Page.screencastFrameAck', { sessionId: p.sessionId }, n.session).catch(() => {})
    }, reste)
  }

  // ── Commandes de l'agent ──
  const vivant = (id) => {
    const n = navs.get(id)
    if (!n || !n.pret || n.fini) throw refus(`aucun navigateur ouvert pour cette console${fins.has(id) ? ` (le dernier s’est fermé : ${fins.get(id)})` : ''} : meydan nav ouvre <url> d’abord`, 409)
    return n
  }
  const etatPublic = (id) => {
    const e = etatDe(id)
    return { console: id, ouvert: e.ouvert, url: e.url, titre: e.titre, depuis: e.depuis, maj: e.maj }
  }
  async function titreFrais(n) {
    const { targetInfo: t } = await n.cdp.appel('Target.getTargetInfo', { targetId: n.cible })
    change(n.console, { url: propre(t.url, 2000), titre: propre(t.title, 200) })
  }
  async function dansLaPage(n, fonction, args, ms = DELAI.commande) {
    const { executionContextId } = await n.cdp.appel('Page.createIsolatedWorld', { frameId: n.cadre, worldName: 'meydan-nav' }, n.session)
    const r = await n.cdp.appel('Runtime.callFunctionOn', { functionDeclaration: fonction.toString(), executionContextId, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true }, n.session, ms)
    if (r.exceptionDetails) throw refus(`erreur dans la page : ${propre(r.exceptionDetails.exception?.description || r.exceptionDetails.text, 300)}`, 422)
    return r.result?.value || {}
  }
  const texteAgent = (v, nom, max) => {
    if (typeof v !== 'string' || !v.trim()) throw refus(`${nom} manquant`)
    if (v.length > max) throw refus(`${nom} trop long (${max} caractères au plus)`)
    return v
  }
  // Tout ce qui vient de la page est nettoyé avant d'être rendu (nom de balise compris : il peut porter ESC et BEL).
  const decrit = (v) => `${propre(v.nom, 40) || '?'}${v.texte ? ` « ${propre(v.texte, 80)} »` : ''}`
  const encoreLa = (c) => {
    if (fermees.has(c.id) || !find(c.id)) throw refus('console fermée', 409)
  }
  // Après un clic ou une saisie : si une navigation de la page entière a commencé, attendre qu'elle charge.
  async function suite(n, avant) {
    await sleep(300)
    let navigation = false
    let charge = true
    if (n.navigation && n.navigation !== avant) {
      navigation = true
      charge = await attendsCycle(n, n.navigation, 'load', DELAI.navigation)
    }
    await titreFrais(n)
    return { navigation, charge }
  }

  const ACTIONS = {
    etat: ['GET', async (c) => ({ ...etatPublic(c.id), ports: [...(portsDe.get(c.id) || [])], ferme: navs.has(c.id) ? '' : fins.get(c.id) || '' })],
    // Un port de plus pour ce navigateur (une page sur 5173 qui appelle son API sur 3000) : même règle que `ouvre`.
    permet: [
      'POST',
      async (c, corps) => {
        const port = Number(corps.port)
        if (!Number.isInteger(port)) throw refus('port : un nombre entier')
        permetPort(c.id, port)
        return { ports: [...portsDe.get(c.id)] }
      },
    ],
    ouvre: [
      'POST',
      async (c, corps) => {
        const adresse = adresseAgent(corps.url, portPermis)
        permetPort(c.id, Number(new URL(adresse).port)) // le port ouvert entre dans la liste blanche de ce navigateur
        const n = navs.get(c.id) || (await lance(c))
        encoreLa(c) // la console a pu partir pendant le lancement
        cartes.creeNav(c) // la carte « Navigateur · <console> », une fois
        journaux.set(c.id, []) // le journal suit la page ouverte
        n.dejaNotes.clear()
        let finFenetre
        n.fenetre = new Promise((r) => (finFenetre = r))
        let r
        try {
          r = await n.cdp.appel('Page.navigate', { url: adresse }, n.session, DELAI.navigation)
        } finally {
          n.fenetre = null
          finFenetre()
        }
        encoreLa(c)
        if (r.errorText) {
          const indice = INDICES.find(([motif]) => motif.test(r.errorText))?.[1]
          await titreFrais(n).catch(() => {})
          throw refus(`page non ouverte : ${propre(r.errorText, 120)}${indice ? ` — ${indice}` : ''}`, 502)
        }
        const charge = r.loaderId ? await attendsCycle(n, r.loaderId, 'load', DELAI.navigation) : true
        await titreFrais(n)
        return { ...etatPublic(c.id), charge }
      },
      DELAI.lancement + DELAI.navigation + 10000,
    ],
    capture: [
      'POST',
      async (c) => {
        const n = vivant(c.id)
        const { data } = await n.cdp.appel('Page.captureScreenshot', { format: 'png' }, n.session, DELAI.capture, true)
        const buf = Buffer.from(String(data || ''), 'base64')
        if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw refus('capture illisible', 502)
        return { chemin: ecritCapture(c.id, buf), octets: buf.length, largeur: buf.readUInt32BE(16), hauteur: buf.readUInt32BE(20) }
      },
      DELAI.capture + 5000,
    ],
    clique: [
      'POST',
      async (c, corps) => {
        const n = vivant(c.id)
        const selecteur = texteAgent(corps.selecteur, 'sélecteur', 1000)
        const avant = n.navigation
        const v = await dansLaPage(n, pageVise, [selecteur, false])
        if (v.erreur) throw refus(`${propre(v.erreur, 120)} : ${propre(selecteur, 200)}`, 422)
        const souris = (type, plus) => n.cdp.appel('Input.dispatchMouseEvent', { type, x: v.x, y: v.y, ...plus }, n.session)
        await souris('mouseMoved', {})
        await souris('mousePressed', { button: 'left', buttons: 1, clickCount: 1 })
        await souris('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 })
        return { element: decrit(v), couvert: v.couvert, ...(await suite(n, avant)), ...etatPublic(c.id) }
      },
      DELAI.commande * 2 + DELAI.navigation,
    ],
    tape: [
      'POST',
      async (c, corps) => {
        const n = vivant(c.id)
        const selecteur = texteAgent(corps.selecteur, 'sélecteur', 1000)
        if (typeof corps.texte !== 'string') throw refus('texte manquant')
        if (corps.texte.length > SAISIE_MAX) throw refus(`texte trop long (${SAISIE_MAX} caractères au plus)`)
        const texte = corps.texte.replace(/\r\n?/g, '\n').replace(INVISIBLES, (x) => (x === '\n' || x === '\t' ? x : ''))
        const avant = n.navigation
        const v = await dansLaPage(n, pageVise, [selecteur, true])
        if (v.erreur) throw refus(`${propre(v.erreur, 120)} : ${propre(selecteur, 200)}`, 422)
        await n.cdp.appel('Input.insertText', { text: texte }, n.session) // remplace la sélection : le contenu du champ
        return { element: decrit(v), caracteres: texte.length, ...(await suite(n, avant)), ...etatPublic(c.id) }
      },
      DELAI.commande * 2 + DELAI.navigation,
    ],
    texte: [
      'GET',
      async (c) => {
        const n = vivant(c.id)
        const v = await dansLaPage(n, pageTexte, [TEXTE_MAX * 4])
        return { url: propre(v.url, 2000), titre: propre(v.titre, 200), texte: propre(v.texte, TEXTE_MAX, true) }
      },
    ],
    console: [
      'GET',
      async (c, corps, url) => {
        // `meydan nav console <mot>` : seulement les entrées qui le contiennent (« refus », « bloquée », « exception »…).
        const filtre = propre(url.searchParams.get('filtre') || '', 100).toLowerCase()
        const lignes = (journaux.get(c.id) || []).filter((l) => !filtre || l.toLowerCase().includes(filtre))
        let total = 0
        let i = lignes.length
        while (i > 0 && total + lignes[i - 1].length + 1 <= SORTIE_MAX) total += lignes[--i].length + 1
        return { ouvert: navs.has(c.id), lignes: lignes.slice(i), omises: i }
      },
    ],
    ferme: [
      'POST',
      async (c) => {
        const n = navs.get(c.id)
        if (!n) return { ferme: false, deja: true }
        await termine(n, 'demandé par l’agent')
        return { ferme: true }
      },
    ],
  }
  // Une capture PNG dans le dossier des pièces de la console (que l'agent lit déjà), jamais par-dessus un fichier ou un lien.
  function ecritCapture(id, buf) {
    const dir = dossierCaptures(id)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = fs.lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) throw refus('dossier des captures inutilisable', 500)
    const nom = `nav-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}.png`
    const f = path.join(dir, nom)
    const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try {
      fs.writeSync(fd, buf)
    } finally {
      fs.closeSync(fd)
    }
    const anciennes = fs
      .readdirSync(dir)
      .filter((x) => /^nav-\d{8}-\d{6}-[0-9a-f]{6}\.png$/.test(x))
      .sort()
    for (const x of anciennes.slice(0, Math.max(0, anciennes.length - CAPTURES_GARDEES))) fs.rmSync(path.join(dir, x), { force: true })
    return f
  }

  // Une commande à la fois par console, dans l'ordre d'arrivée.
  function enFile(id, fn) {
    const p = (files.get(id) || Promise.resolve()).then(() => {
      if (fermees.has(id)) throw refus('console fermée', 409) // une commande en file quand la console est partie
      return fn()
    })
    files.set(
      id,
      p.catch(() => {}),
    )
    return p
  }
  const avecDelai = (p, ms) =>
    new Promise((resout, rejette) => {
      const t = setTimeout(() => rejette(refus(`commande trop longue (${Math.round(ms / 1000)} s)`, 504)), ms)
      p.then(
        (v) => (clearTimeout(t), resout(v)),
        (e) => (clearTimeout(t), rejette(e)),
      )
    })
  // Fermeture après INACTIF_MS sans commande de l'agent (regarder la tuile ne compte pas), par la file.
  function rearme(id) {
    const n = navs.get(id)
    if (!n) return
    clearTimeout(n.minuteur)
    n.minuteur = setTimeout(() => navs.get(id) === n && enFile(id, () => (navs.get(id) === n ? termine(n, `aucune commande depuis ${Math.round(INACTIF_MS / 1000)} s`) : null)), INACTIF_MS)
  }

  function liste() {
    const ids = new Set([...etats.keys(), ...cartes.liste().filter((k) => k.type === 'nav').map((k) => k.console)])
    return [...ids].filter((id) => find(id)).map(etatPublic)
  }

  return {
    async agent(req, res, url, me) {
      const parts = url.pathname.split('/').filter(Boolean) // ['agent', 'nav', action]
      const nom = parts.length === 2 ? 'etat' : parts.length === 3 ? parts[2] : ''
      const action = Object.hasOwn(ACTIONS, nom) ? ACTIONS[nom] : null
      if (!action) return send(res, 404, { error: 'commande inconnue (meydan nav aide)' })
      if (req.method !== action[0]) return send(res, 405, { error: 'méthode refusée' })
      const corps = req.method === 'POST' ? await readJson(req) : {}
      if (!corps || typeof corps !== 'object' || Array.isArray(corps)) return send(res, 400, { error: 'corps JSON attendu' })
      const c = find(me.id)
      if (!c || c.status === 'closed' || fermees.has(c.id)) return send(res, 409, { error: 'console fermée' })
      rearme(c.id)
      try {
        return send(res, 200, await enFile(c.id, () => avecDelai(action[1](c, corps, url), action[2] || DELAI.commande * 2)))
      } finally {
        rearme(c.id)
      }
    },

    async api(req, res, url, parts) {
      // Lecture seule, même en GET : jamais pour une autre origine, ni chargée par un autre site (<img> compris).
      if ((req.headers.origin && !originOk(req)) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: 'origine refusée' })
      if (req.method !== 'GET') return send(res, 405, { error: 'méthode refusée' })
      if (parts.length === 2) return send(res, 200, { navs: liste() })
      if (parts.length === 4 && parts[3] === 'image' && CONSOLE.test(parts[2])) {
        const n = navs.get(parts[2])
        if (!n || !n.pret || n.fini) return send(res, 404, { error: 'aucun navigateur ouvert pour cette console' })
        // La dernière image du screencast si une tuile regarde ; sinon une capture (une par seconde au plus).
        const img = n.diffuse && n.image && n.imageLe >= (n.navigueLe || 0) ? n.image : await captureJpeg(n)
        if (!img) return send(res, 503, { error: 'capture impossible pour l’instant' })
        return send(res, 200, img, { 'content-type': 'image/jpeg' })
      }
      return send(res, 404, { error: 'route inconnue' })
    },

    ws(ws, id) {
      ws.on('error', () => {})
      if (!CONSOLE.test(id) || !find(id)) return ws.close(4404, 'console inconnue')
      ws.on('message', () => {}) // lecture seule : tout message reçu est ignoré
      const e = etatDe(id)
      ws.send(JSON.stringify({ type: 'etat', ouvert: e.ouvert, url: e.url, titre: e.titre }))
      // L'image du moment tout de suite : le screencast n'envoie une image qu'à un changement de la page (une page immobile
      // n'en enverrait aucune). La dernière, si elle montre la page actuelle ; sinon une capture.
      const n = navs.get(id)
      let s = regards.get(id)
      if (!s) regards.set(id, (s = new Set()))
      s.add(ws)
      // L'image initiale : refusée elle aussi pendant la validation d'une navigation, elle est redemandée (quatre fois au plus).
      const envoieImage = (essai) => {
        if (n.fini || ws.readyState !== 1) return
        const frais = n.image && n.imageLe >= (n.navigueLe || 0)
        Promise.resolve(frais ? n.image : captureJpeg(n)).then(
          (img) => {
            if (n.fini || ws.readyState !== 1) return
            if (img) ws.send(img)
            else if (essai < 4) setTimeout(() => envoieImage(essai + 1), 250)
          },
          () => {},
        )
      }
      const demarre = () => {
        if (!n?.pret || n.fini || ws.readyState !== 1) return // pas encore prêt : la fin du lancement lancera la diffusion
        envoieImage(0)
        diffuse(n)
      }
      if (ESSAI_FENETRE && n?.fenetre) n.fenetre.then(demarre)
      else demarre()
      ws.on('close', () => {
        s.delete(ws)
        if (s.size) return
        if (regards.get(id) === s) regards.delete(id)
        const m = navs.get(id)
        if (m && !regards.get(id)?.size) arreteDiffusion(m)
      })
    },

    // La console part : son navigateur, sa carte, son état, ses tuiles.
    ferme(id) {
      fermees.add(id) // plus rien ne relance de navigateur pour elle, même une commande déjà en file
      portsDe.delete(id)
      fins.delete(id)
      const n = navs.get(id)
      if (n) termine(n, 'console fermée').catch((e) => console.error(`[nav] ${id} : fermeture : ${e.message}`))
      cartes.retireNav(id)
      etats.delete(id)
      journaux.delete(id)
      files.delete(id)
      for (const ws of regards.get(id) || []) ws.close(4404, 'console fermée')
      regards.delete(id)
    },
  }
}
