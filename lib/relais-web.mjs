// Relais de l'aperçu web d'une carte (plateau étendu, volet du 11/11) : Orkun voit dans une carte du plateau un serveur
// local du VPS (http://127.0.0.1:<port>), servi par Meydan sous /relais/<carte>/<jeton>/<reste>.
//
// Ce que ce relais garantit (revue : docs/volets/plateau-etendu-relais.md, essais : test/volets/plateau-etendu/relais-*.mjs) :
//   - aucune ouverture sans session : le jeton de l'adresse n'est remis qu'à une session ouverte (POST /api/cartes/:id/apercu,
//     derrière la porte de session) ; il ne vaut que pour la porte qui l'a émis (clé publique sous le nom public, remplacée
//     à chaque déconnexion ; clé d'accès en local), pour CETTE carte et SON port actuel, 12 h au plus et jamais au-delà de
//     la session ;
//   - aucun autre hôte : l'amont est 127.0.0.1, fixe, jamais tiré de la demande ; le port est celui de la carte, jamais
//     celui de Meydan ni un port refusé ;
//   - le document relayé ne tourne JAMAIS dans l'origine de Meydan : « Content-Security-Policy: sandbox » sur toute réponse
//     (origine opaque : ni cookie de Meydan, ni stockage, ni accès à la page parente), et l'iframe est elle-même isolée
//     (web/src/WebNode.jsx) ;
//   - rien ne passe d'un côté à l'autre hors des listes blanches : ni cookie, ni authorization, ni x-forwarded-*, ni
//     origin/referer vers l'amont ; ni set-cookie, ni CSP, ni en-têtes de sécurité ou de redirection de l'amont vers le
//     navigateur.
//
// Contrat (server.mjs) :
//   ouvreRelais({ cle, finSession, trouve, proprePort, send }) → { portPermis, portNavigateur, adresse, sert }
//   portPermis(port)     : '' ou la raison du refus, pour l'aperçu web (liste PERMISE, PORTS_APERCU) ;
//   portNavigateur(port) : '' ou la raison du refus, pour le navigateur de l'agent (ancienne liste de refus, inchangée).
//   cle(req)        : la clé de base de la porte de cette demande (lue à chaque appel : la clé publique change à la déconnexion).
//   finSession(req) : fin de validité (ms) de la session de cette demande (Infinity en boucle locale).
//   trouve(id)      : la carte de ce nom, ou undefined.
//   proprePort      : le port de ce Meydan (jamais relayé).
//   send            : la réponse commune de server.mjs (elle sait répondre pendant qu'un corps arrive encore).
import http from 'node:http'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream'

const HOTE = '127.0.0.1' // fixe : l'hôte de l'amont ne vient jamais de la demande
const DUREE_S = 12 * 3600 // vie maximale d'un jeton
const CORPS_MAX = 10 * 1024 * 1024 // corps d'une demande relayée (nginx, lui, borne à 64 Ko hors /api/envois/ : voir la revue)
const INACTIVITE_MS = 30 * 1000 // connexion ou réponse de l'amont muette plus longtemps : coupée
const METHODES = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

// Ports jamais relayés, en plus de celui de Meydan. LISTE PROPOSÉE, décision d'Orkun (relevé `ss -ltn` du VPS, 11/11) :
// bases et caches (PostgreSQL, Redis, MySQL, MongoDB, memcached), outils d'administration et de débogage (Chromium et
// Node en débogage, pont chrome-bridge, PM2, n8n, tableau de lean-ctx), API interne d'un autre service, mandataire SOCKS,
// collecteurs OpenTelemetry. Et toute la plage des ports ÉPHÉMÈRES que le système attribue au hasard (32768–60999 :
// débogueurs de Chromium, outils de Claude et de Codex…) : un serveur de développement n'y écoute pas.
// Aucun n'est un site à regarder ; un jeton qui fuirait n'y donnerait pas accès.
export const PORTS_REFUSES = new Set([1080, 3306, 3333, 4317, 4318, 5432, 5678, 6379, 8090, 8765, 9222, 9229, 9233, 11211, 27017])
export const EPHEMERES = [32768, 60999]
// Aperçu web : seulement ces ports (plages incluses). Décision d'Orkun du 17/11, plateau-etendu-1 : « La relecture
// recommande la liste de ports permis ; la liste de refus est la proposition du volet » (sa reco : la liste PERMISE,
// docs/volets/plateau-etendu.md:178-180). À l'intérieur, tout ce que l'ancienne règle refuse le reste (défense en
// profondeur) : < 1024, le port de Meydan, PORTS_REFUSES (3306, 3333, 8090…), la plage éphémère.
// Le navigateur de l'agent garde l'ANCIENNE règle (`portNavigateur`, plus bas) : décision d'Orkun du 17/11, copies-7 :
// « Garder la liste blanche par navigateur ».
export const PORTS_APERCU = [[3000, 3999], [5173, 5173], [8000, 8099]]
export const PORTS_APERCU_TEXTE = '3000–3999, 5173 et 8000–8099'
// Demandes relayées en même temps (deux descripteurs chacune) ; au-delà elles attendent leur tour, et au-delà de la file
// elles reçoivent 503. Une page de développement charge des centaines de modules d'un coup derrière nginx (HTTP/2).
export const EN_VOL_MAX = 48
export const FILE_MAX = 200

// En-têtes transmis à l'amont (liste blanche). Jamais : cookie, authorization, origin, referer, x-forwarded-*, x-real-ip,
// sec-fetch-*, ni rien d'autre de ce que le navigateur ou nginx ajoutent.
const VERS_AMONT = ['accept', 'accept-language', 'accept-encoding', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since', 'cache-control', 'user-agent']
// En-têtes de l'amont rendus au navigateur (liste blanche). Jamais : set-cookie, content-security-policy, x-frame-options,
// strict-transport-security, clear-site-data, service-worker-allowed, refresh, link, alt-svc, access-control-*, www-authenticate…
const DE_AMONT = ['content-type', 'content-length', 'content-encoding', 'content-language', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'vary']
// Posés sur TOUTE réponse du relais (y compris 404, 502…). `sandbox` sans allow-same-origin : le document a une origine
// opaque, quelle que soit l'iframe qui le porte (et même ouvert seul dans un onglet). Pas d'allow-popups ni
// d'allow-top-navigation : la page relayée n'ouvre pas de fenêtre et ne quitte pas sa carte.
// x-frame-options remplace le DENY de send() (CSP frame-ancestors l'emporte de toute façon).
const ENTETES = {
  'content-security-policy': "sandbox allow-scripts allow-forms; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'SAMEORIGIN',
}
// Le document relayé a une origine opaque : ses scripts de module, ses polices et ses fetch() vers le relais sont des
// demandes « d'une autre origine » (Origin: null). Sans cette autorisation, aucun site moderne ne s'afficherait. Sans
// identifiants (pas d'allow-credentials) : rien de la session de Meydan n'y est lisible.
const CORS = { 'access-control-allow-origin': 'null' }
const PREVOL = {
  ...CORS,
  'access-control-allow-methods': [...METHODES].join(', '),
  'access-control-allow-headers': 'content-type, range, if-none-match, if-modified-since, cache-control',
  'access-control-max-age': '600',
}

// /relais/<carte>/<exp>.<mac><reste> ; le serveur a déjà refusé tout chemin brut différent de sa forme normale (400).
const ADRESSE = /^\/relais\/(k[0-9a-f]{8})\/(\d{1,12})\.([A-Za-z0-9_-]{43})(\/[^?]*)?(\?.*)?$/

const refus = (message, code) => Object.assign(new Error(message), { code })
const meme = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
// mac = base64url(HMAC-SHA256(HMAC-SHA256(cle, 'meydan-relais-v1'), `${id}.${port}.${exp}`))
const macDe = (cle, id, port, exp) =>
  crypto.createHmac('sha256', crypto.createHmac('sha256', cle).update('meydan-relais-v1').digest()).update(`${id}.${port}.${exp}`).digest('base64url')

export function ouvreRelais({ cle, finSession, trouve, proprePort, send }) {
  // L'ancienne règle (liste de refus), inchangée : celle du navigateur de l'agent (server.mjs → lib/navigateur.mjs).
  const portNavigateur = (port) => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return 'port : un nombre entre 1024 et 65535'
    if (port === proprePort) return 'port refusé : c’est celui de Meydan'
    if (PORTS_REFUSES.has(port)) return `port ${port} refusé : service du VPS qui n’est pas un site à afficher`
    if (port >= EPHEMERES[0] && port <= EPHEMERES[1]) return `port ${port} refusé : plage des ports attribués au hasard par le système (${EPHEMERES.join('–')})`
    return ''
  }
  // L'aperçu web (cartes, adresse, relais) : la liste PERMISE, moins tout ce que l'ancienne règle refuse.
  const portPermis = (port) => {
    if (!PORTS_APERCU.some(([a, b]) => Number.isInteger(port) && port >= a && port <= b))
      return `port${Number.isInteger(port) ? ` ${port}` : ''} refusé : l’aperçu web n’affiche que les ports ${PORTS_APERCU_TEXTE}`
    return portNavigateur(port)
  }

  // L'adresse de l'aperçu d'une carte web, pour la session de CETTE demande.
  function adresse(req, k) {
    if (!Number.isInteger(k.port)) throw refus('carte sans port : saisis le port du serveur à afficher', 409)
    const raison = portPermis(k.port)
    if (raison) throw refus(raison, 409)
    const base = cle(req)
    const maintenant = Math.floor(Date.now() / 1000)
    const exp = Math.min(maintenant + DUREE_S, Math.floor(finSession(req) / 1000))
    if (!base || !(exp > maintenant)) throw refus('session finie', 401)
    // Chemin de la carte remis à sa forme normale (« .. », « \ », caractères à coder) : l'adresse rendue reste sous le
    // préfixe du relais, le navigateur ne la réécrit pas.
    const u = new URL(`http://x${k.chemin || '/'}`)
    return { adresse: `/relais/${k.id}/${exp}.${macDe(base, k.id, k.port, exp)}${u.pathname}${u.search}${u.hash}`, fin: exp * 1000 }
  }

  // Toute réponse du relais porte ses en-têtes, même une erreur imprévue (la réponse d'erreur de server.mjs ne les a pas).
  async function sert(req, res) {
    try {
      await relaie(req, res)
    } catch {
      if (!res.headersSent) send(res, 400, 'demande refusée', ENTETES)
      else res.destroy()
    }
  }

  async function relaie(req, res) {
    const m = ADRESSE.exec(req.url)
    const k = m ? trouve(m[1]) : undefined
    const port = k?.type === 'web' && Number.isInteger(k.port) && !portPermis(k.port) ? k.port : 0
    const exp = m ? Number(m[2]) : 0
    const maintenant = Date.now() / 1000
    // Le calcul est fait même pour une carte inconnue : carte inconnue, jeton faux ou expiré rendent le même 404. Pas de clé
    // (accès public fermé : identifiants absents) = aucun jeton ne vaut.
    const base = cle(req)
    const attendu = macDe(base || '-', m ? m[1] : '', port, exp)
    if (!base || !m || !port || !meme(m[3], attendu) || exp <= maintenant || exp > maintenant + DUREE_S) return send(res, 404, 'introuvable', ENTETES)

    const prefixe = `/relais/${m[1]}/${m[2]}.${m[3]}`
    // Sans « / » après le jeton, les adresses relatives de la page sortiraient du préfixe.
    if (!m[4]) return send(res, 308, '', { ...ENTETES, location: `${prefixe}/${m[5] || ''}` })
    if (!METHODES.has(req.method)) return send(res, 405, 'méthode refusée', { ...ENTETES, allow: [...METHODES].join(', ') })
    const reste = m[4] + (m[5] || '')
    if (!/^[\x21-\x7e]+$/.test(reste)) return send(res, 400, 'adresse refusée', ENTETES)
    // Métadonnées de la demande (Fetch Metadata) : une page de l'origine de Meydan elle-même ne charge du relais que des
    // documents (cadre ou onglet, isolés par la CSP sandbox). Un <script>, une feuille de style ou un fetch() venus de
    // Meydan sont refusés : le contenu relayé ne doit jamais devenir du « 'self' » pour la CSP de Meydan.
    if (req.headers['sec-fetch-site'] === 'same-origin' && req.headers['sec-fetch-mode'] !== 'navigate') return send(res, 403, 'réservé au cadre isolé', ENTETES)
    // Prévol CORS d'une demande de la page relayée : répondu ici (l'amont ne se sait pas appelé d'une autre origine).
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) return send(res, 204, '', { ...ENTETES, ...PREVOL })
    if (Number(req.headers['content-length'] || 0) > CORPS_MAX) return send(res, 413, 'corps trop gros : 10 Mo au plus', ENTETES)

    const entetes = { host: `${HOTE}:${port}` }
    for (const n of VERS_AMONT) if (req.headers[n] !== undefined) entetes[n] = req.headers[n]
    // Corps sans longueur annoncée : il repart découpé (chunked) quelle que soit la méthode. Sinon Node l'écrirait brut
    // derrière un GET, et l'amont le lirait comme une seconde demande (en-têtes hors liste blanche compris).
    if (req.headers['transfer-encoding'] !== undefined) entetes['transfer-encoding'] = 'chunked'
    // Location de l'amont : vers lui-même (relative, http://127.0.0.1:<port>, http://localhost:<port>, « ../.. ») → réécrite
    // sous le préfixe ; toute autre → RETIRÉE (une redirection suivie au chargement du cadre, lancé par Meydan, porterait ses
    // cookies ; les formes d'une adresse locale ou de Meydan sont trop nombreuses pour être listées : « localhost. »,
    // « [::ffff:127.0.0.1] », nom public suivi d'un point…). La réponse reste une redirection sans destination.
    const relocalise = (v) => {
      try {
        const u = new URL(v, `http://${HOTE}:${port}${m[4]}`)
        if (u.protocol === 'http:' && (u.hostname === HOTE || u.hostname === 'localhost') && Number(u.port || 80) === port) return `${prefixe}${u.pathname}${u.search}${u.hash}`
      } catch {} // adresse illisible : retirée
      return undefined
    }

    if (!(await place())) return send(res, 503, 'trop de demandes en cours vers les aperçus : réessaie dans un instant', ENTETES)
    try {
      if (!req.destroyed && !res.destroyed) await transmet(req, res, port, reste, entetes, relocalise) // sinon : parti pendant l'attente
    } finally {
      rend()
    }
  }

  // La demande vers l'amont et sa réponse, en flux. Se résout quand tout est fini (réponse rendue, refus ou coupure).
  function transmet(req, res, port, reste, entetes, relocalise) {
    return new Promise((fini) => {
      let fin = false
      let recu = 0
      const amont = http.request({ host: HOTE, port, method: req.method, path: reste, headers: entetes, agent: false, timeout: INACTIVITE_MS })
      const echec = (code, texte) => {
        if (fin) return
        fin = true
        amont.destroy()
        if (!res.headersSent) send(res, code, texte, ENTETES)
        else res.destroy()
        fini()
      }
      amont.on('timeout', () => echec(504, `127.0.0.1:${port} ne répond plus (30 s sans rien)`))
      amont.on('error', () => echec(502, `Rien ne répond sur 127.0.0.1:${port}.\nLance le serveur de ce port, puis recharge l’aperçu.`))
      // Un amont qui « accepte » de changer de protocole (101) détache sa liaison : sans ceci la demande resterait pendante.
      amont.on('upgrade', (r, liaison) => {
        liaison.destroy()
        echec(502, `127.0.0.1:${port} a répondu par un changement de protocole : non relayé`)
      })
      amont.on('response', (r) => {
        if (fin) return r.resume()
        const h = { ...ENTETES, ...CORS }
        for (const n of DE_AMONT) if (r.headers[n] !== undefined) h[n] = r.headers[n]
        const loc = r.headers.location === undefined ? undefined : relocalise(r.headers.location)
        if (loc) h.location = loc
        // Code d'état hors de 200–599 (« 099 », « 000 » : Node les lit, mais writeHead lèverait HORS de tout try, et
        // l'exception arrêterait Meydan entier) → 502. Le try reste : writeHead ne doit jamais pouvoir lever ici.
        if (!(r.statusCode >= 200 && r.statusCode <= 599)) return r.resume(), echec(502, `127.0.0.1:${port} a répondu un code d’état invalide`)
        try {
          res.writeHead(r.statusCode, h)
        } catch {
          return r.resume(), echec(502, `127.0.0.1:${port} a répondu des en-têtes invalides`)
        }
        pipeline(r, res, (err) => {
          if (err) amont.destroy()
          fin = true
          fini()
        })
      })
      // Corps de la demande en flux, compté : au-delà de 10 Mo (corps sans longueur annoncée), l'amont est coupé.
      req.on('data', (c) => {
        recu += c.length
        if (recu > CORPS_MAX) {
          req.unpipe(amont)
          echec(413, 'corps trop gros : 10 Mo au plus')
        }
      })
      req.on('error', () => echec(400, 'demande interrompue'))
      res.on('close', () => {
        if (!res.writableFinished) {
          amont.destroy()
          fin = true
          fini()
        }
      })
      req.pipe(amont)
    })
  }

  // Places de demandes en vol (EN_VOL_MAX), avec une file d'attente bornée (FILE_MAX). `place()` rend vrai quand la
  // demande peut partir, faux si la file est pleine ; `rend()` libère la place (ou la passe au premier qui attend).
  let enVol = 0
  const file = []
  const place = () => (enVol < EN_VOL_MAX ? (enVol++, Promise.resolve(true)) : file.length >= FILE_MAX ? Promise.resolve(false) : new Promise((r) => file.push(r)))
  const rend = () => {
    const suivant = file.shift()
    if (suivant) suivant(true)
    else enVol--
  }

  return { portPermis, portNavigateur, adresse, sert }
}
