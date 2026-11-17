import { useCallback, useEffect, useRef, useState } from 'react'

// Ordre = ordre d'urgence dans la liste.
export const STATUS = {
  needs: { label: "T'ATTEND", rank: 0, color: '#FF5A36' },
  error: { label: 'ERREUR', rank: 1, color: '#F0457F' },
  working: { label: 'TRAVAILLE', rank: 2, color: '#86E1DC' },
  starting: { label: 'DÉMARRE', rank: 3, color: '#E9D989' },
  running: { label: 'EN COURS', rank: 4, color: '#9DB7D8' },
  ready: { label: 'PRÊT', rank: 5, color: '#C3DB6B' },
  // Une console dont l'agent vient de finir sa tâche, pas encore vue par Orkun (le serveur garde « ready » + `fini`).
  fini: { label: 'FINI', rank: 1.5, color: '#5CE89A' },
  shell: { label: 'SHELL', rank: 6, color: '#8B9A93' },
  closed: { label: 'FERMÉE', rank: 7, color: '#55615C' },
}
export const KIND_TAG = { claude: 'CLAUDE', codex: 'CODEX', grok: 'GROK', shell: 'SH' }
export const statusOf = (s) => STATUS[s] || STATUS.closed
// Une équipe prête t'attend tant que tu n'as pas répondu à son capitaine (le serveur pose alors `pret.vu`).
export const pretAVoir = (t) => !!t.pret && !t.pret.vu
// Une équipe qui t'appelle sans être prête à livrer (17/11) : question, blocage ou échec déclarés par son capitaine, ou
// verdict d'une vérification dont la console a été fermée (`team.appel`, posé par le serveur). Même règle que `pret` :
// elle t'attend tant que tu n'as pas répondu à son capitaine (`appel.vu`).
export const appelAVoir = (t) => !!t.appel && !t.appel.vu
// Ce que « T'ATTEND » compte pour une équipe : prête à livrer, ou qui t'appelle.
export const equipeAttend = (t) => pretAVoir(t) || appelAVoir(t)
// Statut qu'un membre d'équipe déclare lui-même (bin/meydan statut …), dit en français.
export const VERBE = { working: 'avance', 'needs-decision': 'décision à prendre', blocked: 'bloqué', done: 'fini', failed: 'échec', resolved: 'repris' }

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const cls = (...a) => a.filter(Boolean).join(' ')
export const shortDir = (cwd = '') => cwd.replace(/^\/home\/[^/]+/, '~')
export const wsUrl = (p) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`

export function since(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

export async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new Error('Liaison coupée : réessaie dans un instant.') // au lieu du « Failed to fetch » du navigateur
  })
  // Session finie (page restée ouverte) : recharger mène à la connexion sous le nom public, au message du lien à clé en local.
  if (r.status === 401) location.reload()
  const j = await r.json().catch(() => ({}))
  // `status` et `corps` : l'appelant lit un refus détaillé (409 « texte risqué » de la barre d'envoi : passages, empreinte).
  if (!r.ok) throw Object.assign(new Error(j.error || `erreur ${r.status}`), { status: r.status, corps: j })
  return j
}

// Apparence : thème, couleur d'appel (Réverbère), police d'interface (Réverbère). Le premier de chaque liste est le défaut.
// `?theme=`, `?appel=`, `?police=` dans l'adresse l'emportent sur le choix mémorisé.
export const LOOKS = { theme: ['reverbere', 'tapis'], appel: ['jaune', 'ivoire'], police: ['host', 'recursive', 'martian'], repere: ['ligne', 'aucun', 'barre', 'fondu'], tel: ['1', '2'], paysage: ['mosaique', 'colonnes'], reel: ['oui', 'non'], reel3: ['oui', 'non'], grand: ['colonne', 'plateau'], agencement: ['b', 'a'], rendu: ['dom', 'auto', 'webgl'] }
// `?paysage=` : la vue d'ensemble d'un téléphone couché. « mosaique » (par équipes et par urgence) ou « colonnes » (t'attend /
// travaille / au repos). Les deux restent consultables par l'adresse.
// `?tel=2` : le téléphone à l'essai (10/11) — paysage en plein écran au lieu du plateau, deux volets sur un écran moyen au
// doigt (pliable, tablette). « 1 » = ce qui est en service. Le titre qui passe d'une console à l'autre, essayé ici d'abord,
// est en service pour tous depuis le 11/11 (volet a-iphone).
// `?reel3=` : les trois règles du reel (trois plans, jaune = à toi de toucher, une chose énorme) sur l'ordinateur et le
// téléphone couché (volet design-3-plans, 11/11). En service depuis le 13/11 (Orkun : « A1 oui […] A3 oui ») ; `?reel3=non`
// rend l'écran d'avant. Le téléphone debout suit `reel`, pas cette clé.
// `?grand=` (avec `reel3=oui`, ordinateur) : où va la seule chose énorme de l'écran, le nom du projet de la plus ancienne
// attente. « colonne » (au fond de la scène de la colonne, toujours visible ; Orkun le 13/11 : « A2 colonne ») ou
// « plateau » (peint sur le sol du plateau, au-dessus de son groupe de consoles). Jamais les deux : une seule chose énorme.
// `?rendu=` : le rendu des terminaux de l'ordinateur (volet vitesse-term, 17/11). « dom » = le rendu d'xterm (défaut, comme
// avant) ; « auto » = par la carte graphique quand il y en a une (WebGL, rendu.js) ; « webgl » = WebGL forcé, même en rendu
// logiciel (le banc). « auto » ne passe pas par défaut sans Orkun : sur Mac, la grille n'y a pas le même nombre de
// colonnes qu'en DOM (docs/volets/vitesse-term.md). La console du téléphone reste en DOM quoi qu'il arrive.
// `?repere=` : ce qui signale que la liste du rail continue plus bas. « ligne » (« + N plus bas ») choisi par Orkun le 10/11 ;
// les autres restent consultables par l'adresse.
const LOOK_KEY = 'meydan.apparence'

function readLook() {
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem(LOOK_KEY)) || {}
  } catch {}
  const url = new URLSearchParams(location.search)
  const look = {}
  for (const [k, list] of Object.entries(LOOKS)) {
    const v = url.get(k) ?? saved[k]
    look[k] = list.includes(v) ? v : list[0]
  }
  return look
}

function applyLook(look) {
  Object.assign(document.documentElement.dataset, look)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', look.theme === 'tapis' ? '#12241F' : '#080b18')
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look))
  } catch {}
}

// La version d'interface que cette page a chargée : son script principal (17/11 : Orkun gardait sa page d'avant une mise
// à jour, et « fermer » y effaçait encore les consoles au lieu de les ranger dans l'Historique). Le moteur dit la sienne
// à chaque connexion (« snapshot », et une mise en ligne relance le moteur) : différente, la page le sait (App.jsx).
const MA_VERSION = typeof document === 'undefined' ? '' : document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') || ''

export function useLook() {
  const [look, setLook] = useState(() => {
    const l = readLook()
    applyLook(l) // avant le premier rendu : pas d'éclair de l'autre thème
    return l
  })
  useEffect(() => applyLook(look), [look])
  const patch = useCallback((p) => setLook((l) => ({ ...l, ...p })), [])
  return [look, patch]
}

// Échap ferme un panneau posé par-dessus (Ordre, Boucle). Écouté en capture : le terminal du dessous ne le reçoit pas
// (un Échap qui partait à l'agent l'interrompait).
export function useEchap(fermer) {
  const f = useRef(fermer)
  f.current = fermer
  useEffect(() => {
    const touche = (e) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      f.current()
    }
    window.addEventListener('keydown', touche, true)
    return () => window.removeEventListener('keydown', touche, true)
  }, [])
}

export function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function useMedia(query) {
  const [hit, setHit] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const m = matchMedia(query)
    const on = () => setHit(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return hit
}

// La même mesure pour un élément qui apparaît et disparaît (terminal du téléphone, remplacé par la discussion puis
// revenu) : on le reçoit lui-même, par une référence posée par fonction, et la mesure reprend à chaque nouvel élément.
// Avec une référence fixe, la mesure n'était prise qu'au premier affichage : revenu de la discussion, le terminal
// n'avait plus de taille et restait vide.
export function useSizeOf(el) {
  const [size, setSize] = useState(null)
  useEffect(() => {
    if (!el) {
      setSize(null)
      return
    }
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return size
}

export function useSize(ref) {
  const [size, setSize] = useState(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

// FINI se lit comme un état à part entière dans toute l'interface : le serveur dit « ready » avec la marque `fini`.
const lue = (c) => (c.status === 'ready' && c.fini ? { ...c, status: 'fini' } : c)

// La conversation d'une console a changé (le serveur surveille son journal) : `{ id, cle }`, relayé aux discussions
// ouvertes (Fil.jsx), qui relisent aussitôt au lieu d'attendre leur sondage. À chaque instantané (connexion, ou
// reconnexion après une coupure : iPhone en arrière-plan, réseau perdu), `{ tout: true }` : des changements ont pu se
// perdre pendant la coupure, toutes les discussions relisent.
export const filBus = new EventTarget()
const filChange = (detail) => filBus.dispatchEvent(new CustomEvent('fil', { detail }))

// Flux d'état du serveur : instantané puis mises à jour, reconnexion automatique.
export function useEvents() {
  const [consoles, setConsoles] = useState([])
  const [teams, setTeams] = useState([]) // équipes : un capitaine et ses équipiers
  const [online, setOnline] = useState(false)
  // Mémoire de projet (Memoire.jsx) : [{ projet, valides, proposes, tic }] des projets qui ont un fichier. `tic` change à
  // chaque message du serveur pour ce projet (même si les nombres restent : un texte modifié ailleurs) : le panneau relit.
  const [memoire, setMemoire] = useState([])
  useEffect(() => {
    let dead = false, ws, timer, retry = 0, tic = 0
    const connect = () => {
      ws = new WebSocket(wsUrl('/ws/events'))
      ws.onopen = () => {
        retry = 0
        setOnline(true)
        vu()
      }
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        window.dispatchEvent(new CustomEvent('meydan:flux', { detail: m })) // plateau étendu (cartes.js) : les cartes suivent le même flux
        if (m.type === 'snapshot') {
          if (m.version && MA_VERSION && m.version !== MA_VERSION) window.dispatchEvent(new CustomEvent('meydan:version', { detail: m.version }))
          setConsoles(m.consoles.map(lue))
          setTeams(m.teams || [])
          setMemoire(Array.isArray(m.memoire) ? m.memoire.map((x) => ({ ...x, tic: ++tic })) : [])
          filChange({ tout: true })
        } else if (m.type === 'fil') filChange({ id: m.id, cle: m.cle })
        else if (m.type === 'memoire') {
          const x = { projet: m.projet, valides: m.valides, proposes: m.proposes, tic: ++tic }
          setMemoire((ms) => (ms.some((y) => y.projet === x.projet) ? ms.map((y) => (y.projet === x.projet ? x : y)) : [...ms, x]))
        } else if (m.type === 'team') setTeams((ts) => (ts.some((t) => t.id === m.team.id) ? ts.map((t) => (t.id === m.team.id ? m.team : t)) : [...ts, m.team]))
        else if (m.type === 'team-removed') setTeams((ts) => ts.filter((t) => t.id !== m.id))
        else if (m.type === 'removed') setConsoles((cs) => cs.filter((c) => c.id !== m.id))
        else if (m.type === 'console')
          setConsoles((cs) => (cs.some((c) => c.id === m.console.id) ? cs.map((c) => (c.id === m.console.id ? lue(m.console) : c)) : [...cs, lue(m.console)]))
      }
      ws.onclose = () => {
        setOnline(false)
        if (dead) return
        // Liaison refusée plusieurs fois de suite : la session est peut-être finie. Une demande à l'API le dit (401 → rechargement).
        if (retry === 3) api('GET', '/api/consoles').catch(() => {})
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++))
      }
    }
    // « vu » : cette page est à l'écran. Le serveur s'en sert pour ne pas faire sonner le téléphone pour ce qu'on regarde déjà.
    const vu = () => document.visibilityState === 'visible' && ws?.readyState === 1 && ws.send('vu')
    const battement = setInterval(vu, 15000)
    document.addEventListener('visibilitychange', vu)
    connect()
    return () => {
      dead = true
      clearTimeout(timer)
      clearInterval(battement)
      document.removeEventListener('visibilitychange', vu)
      ws?.close()
    }
  }, [])
  const patchLocal = useCallback((id, patch) => setConsoles((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c))), [])
  return { consoles, teams, online, patchLocal, memoire }
}
