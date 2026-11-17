// Musique (Orkun, 11/11 : « rajouter un connecteur à soundcloud/spotify pour la musique et que je puisse gérer d'ici
// aussi » ; il a SoundCloud Go+, pas Spotify Premium). SoundCloud n'offre aucune API pour piloter son appli : la
// musique joue ICI, dans le lecteur officiel (« widget ») en cadre, que l'on commande par postMessage.
// La politique de sécurité n'autorise aucun script d'ailleurs (`script-src 'self'`) : le protocole du widget est donc
// réécrit ici (lu dans api.js, jamais exécuté) :
//   envoi    {"method":"play"|"pause"|"next"|"prev"|"getCurrentSound"|"addEventListener", "value":…}
//            vers l'origine https://w.soundcloud.com ;
//   réception {"method":"ready"|"play"|"pause"|"finish"|"playProgress"|"error"|"getCurrentSound", "value":…}
// Chaque message reçu est vérifié : origine du widget ET fenêtre de NOTRE cadre.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cls, useEchap, useMedia } from './lib.js'
import './musique.css'

const ORIGINE = 'https://w.soundcloud.com'
const CLE = 'meydan.musique.v1'
const PARAMS = 'auto_play=false&hide_related=true&show_comments=false&show_reposts=false&show_teaser=false&visual=false'

/* ───────────── magasin d'état (niveau module, partagé par Musique et MiniMusique) ───────────── */

function lis() {
  try {
    const j = JSON.parse(localStorage.getItem(CLE) || '{}')
    const liens = Array.isArray(j.liens) ? j.liens.filter((l) => l && typeof l.url === 'string') : []
    // Le dernier choisi revient, mais seulement s'il est encore dans la liste ; jamais de lecture automatique.
    return { liens, actif: liens.some((l) => l.url === j.actif) ? j.actif : null }
  } catch {
    return { liens: [], actif: null }
  }
}
const depart = lis()
let S = {
  liens: depart.liens,
  actif: depart.actif,
  ouvert: false,
  pret: false, // le widget a annoncé « ready »
  lecture: false,
  son: null, // { titre, artiste }
  pos: 0, // avancement 0..1 du morceau
  erreur: '',
  refus: false, // « play » envoyé sans qu'aucun événement play ne revienne (règles du son sur iOS)
}
const abonnes = new Set()
function maj(patch) {
  S = { ...S, ...patch }
  if ('liens' in patch || 'actif' in patch) {
    // Mémoire facultative (navigation privée, stockage bloqué) : l'écran marche sans.
    try {
      localStorage.setItem(CLE, JSON.stringify({ liens: S.liens, actif: S.actif }))
    } catch {}
  }
  abonnes.forEach((f) => f())
}
const useMusique = () =>
  useSyncExternalStore(
    (f) => {
      abonnes.add(f)
      return () => abonnes.delete(f)
    },
    () => S,
  )

/* ───────────── liens ───────────── */

// Rend { url } ou { erreur }. Le widget lit un titre, une playlist (« sets »), les « j'aime » et un profil.
export function lienSoundcloud(brut) {
  let u
  try {
    u = new URL(String(brut).trim())
  } catch {
    return { erreur: 'Ce n’est pas un lien : colle l’adresse complète, commençant par https://soundcloud.com/…' }
  }
  const h = u.hostname.toLowerCase()
  const court = h === 'on.soundcloud.com'
  if (u.protocol !== 'https:' || !(court || h === 'soundcloud.com' || h === 'www.soundcloud.com' || h === 'm.soundcloud.com')) {
    return { erreur: 'Ce n’est pas un lien SoundCloud (https://soundcloud.com/…).' }
  }
  if (u.pathname.replace(/\//g, '') === '') return { erreur: 'Il manque le titre, la playlist ou le profil après soundcloud.com/.' }
  // On garde l'adresse sans ses suivis (?si=…) ; le jeton d'un titre privé est dans le chemin, donc conservé.
  return { url: `https://${court ? h : 'soundcloud.com'}${u.pathname.replace(/\/$/, '')}` }
}
const nomDe = (url) => url.replace(/^https:\/\/(on\.)?soundcloud\.com\/?/, (m, o) => (o ? 'court/' : '')) || url

function ajoute(brut) {
  const r = lienSoundcloud(brut)
  if (r.erreur) return r.erreur
  const liens = S.liens.some((l) => l.url === r.url) ? S.liens : [...S.liens, { url: r.url }]
  maj({ liens })
  choisit(r.url)
  return ''
}
function retire(url) {
  const liens = S.liens.filter((l) => l.url !== url)
  if (S.actif === url) {
    cadre = null
    maj({ liens, actif: null, pret: false, lecture: false, son: null, pos: 0, erreur: '', refus: false })
  } else maj({ liens })
}
function choisit(url) {
  if (url === S.actif) return
  maj({ actif: url, pret: false, lecture: false, son: null, pos: 0, erreur: '', refus: false })
}

/* ───────────── dialogue avec le widget ───────────── */

let cadre = null // l'iframe, posée par Musique
let miniEl = null // la rangée de commandes, pour placer le panneau juste au-dessus
let attenteLecture = 0
let dernierePause = 0

function envoie(method, value) {
  const w = cadre?.contentWindow
  if (!w) return false
  w.postMessage(JSON.stringify(value === undefined ? { method } : { method, value }), ORIGINE)
  return true
}
const lisSon = () => envoie('getCurrentSound')

function lecturePause() {
  if (!S.pret) return
  if (S.lecture) return void envoie('pause')
  envoie('play')
  // Sur iPhone, un « play » venu de la page peut être refusé sans bruit : sans événement play, on le dit.
  clearTimeout(attenteLecture)
  attenteLecture = setTimeout(() => {
    if (!S.lecture) maj({ refus: true, ouvert: true })
  }, 2500)
}
function saute(sens) {
  if (!S.pret) return
  envoie(sens)
  setTimeout(lisSon, 600)
}

function recoit(e) {
  if (e.origin !== ORIGINE || !cadre || e.source !== cadre.contentWindow) return
  let m
  try {
    m = JSON.parse(e.data)
  } catch {
    return
  }
  const v = m?.value
  switch (m?.method) {
    case 'ready':
      maj({ pret: true, erreur: '' })
      for (const ev of ['play', 'pause', 'finish', 'playProgress', 'error']) envoie('addEventListener', ev)
      lisSon()
      break
    case 'play':
      clearTimeout(attenteLecture)
      maj({ lecture: true, refus: false })
      lisSon()
      break
    case 'pause':
      dernierePause = Date.now()
      maj({ lecture: false })
      break
    case 'finish':
      maj({ lecture: false, pos: 0 })
      setTimeout(lisSon, 800)
      break
    case 'playProgress':
      // Le morceau a changé tout seul (suite de la playlist) : on relit le titre.
      if (v && S.son && S.son.id !== undefined && v.soundId !== undefined && v.soundId !== S.son.id) lisSon()
      // Des mesures d'avancement arrivent encore juste après une pause : elles ne remettent pas « lecture » en route.
      maj({ pos: Math.min(1, Math.max(0, Number(v?.relativePosition) || 0)), ...(Date.now() - dernierePause > 1500 && { lecture: true }) })
      break
    case 'error':
      maj({ erreur: 'SoundCloud refuse de lire ce lien (privé, supprimé ou réservé).' })
      break
    case 'getCurrentSound':
      if (v && typeof v === 'object') maj({ son: { id: v.id, titre: v.title || '', artiste: v.user?.username || '' }, erreur: '' })
      break
  }
}

/* ───────────── Musique : le cadre et le panneau (monté une seule fois, à la racine) ───────────── */

export function Musique() {
  const s = useMusique()
  const tel = useMedia('(max-width: 760px), (pointer: coarse) and (max-height: 500px)')
  const [saisie, setSaisie] = useState('')
  const [faute, setFaute] = useState('')
  const [bas, setBas] = useState(null) // ordinateur : décalage du panneau au-dessus de la rangée de commandes
  const cadreRef = useRef(null)

  useEffect(() => {
    window.addEventListener('message', recoit)
    return () => window.removeEventListener('message', recoit)
  }, [])

  // Le cadre est le MÊME élément tant qu'il existe : changer de lien ne fait que changer son src.
  useEffect(() => {
    cadre = cadreRef.current
    return () => {
      cadre = null
    }
  }, [s.actif])

  // Un widget qui ne dit jamais « ready » : lien illisible ou réseau coupé. On le dit plutôt que de rester muet.
  useEffect(() => {
    if (!s.actif) return
    const t = setTimeout(() => {
      if (!S.pret && !S.erreur) maj({ erreur: 'Le lecteur SoundCloud ne répond pas : lien privé, introuvable, ou pas de réseau.' })
    }, 15000)
    return () => clearTimeout(t)
  }, [s.actif])

  // Prêt mais sans rien à lire : le lien existe, pas son contenu. Le widget affiche sa propre erreur ; nous la nommons.
  useEffect(() => {
    if (!s.pret || s.son || s.erreur) return
    const t = setTimeout(() => {
      if (!S.son && !S.erreur) maj({ erreur: 'Rien à lire à cette adresse (privé, vide ou introuvable).' })
    }, 6000)
    return () => clearTimeout(t)
  }, [s.pret, s.son, s.erreur])

  useEffect(() => {
    if (!s.ouvert || tel) return
    const place = () => {
      // Colonne compacte (16/11) : le bouton « Musique » n'est plus qu'un tiers de sa rangée, et le panneau, à sa largeur,
      // s'ouvrait tout étroit (Orkun : « quand j'appuie sur musique ce n'est pas pratique ») : il prend la rangée entière
      // (`.rail-utiles` ; dans l'agencement d'avant elle n'a pas de boîte, le bouton fait toute la largeur).
      const zone = miniEl?.closest('.rail-utiles')?.getBoundingClientRect()
      const r = zone?.width ? zone : miniEl?.getBoundingClientRect()
      setBas(r ? { bas: window.innerHeight - r.top, gauche: r.left, large: r.width } : null)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [s.ouvert, tel])

  if (!s.ouvert && !s.actif) return null
  const fermer = () => maj({ ouvert: false })
  const src = s.actif && `${ORIGINE}/player/?url=${encodeURIComponent(s.actif)}&${PARAMS}`
  const style = !tel && bas ? { bottom: bas.bas + 6, left: bas.gauche, width: bas.large } : undefined
  return (
    <>
      {s.ouvert && tel && <div className="mus-fond" onClick={fermer} />}
      <section
        className={cls('mus-pan', tel ? 'mus-tel' : 'mus-pc', !s.ouvert && 'mus-ferme')}
        style={style}
        role="dialog"
        aria-label="Musique"
        aria-hidden={!s.ouvert}
        inert={!s.ouvert}
      >
        <PanneauTete fermer={fermer} actif={!!s.actif} ouvert={s.ouvert} />
        {src && (
          // Hors écran (jamais en display:none) quand le panneau est fermé : iOS suspend les cadres masqués.
          <iframe
            ref={cadreRef}
            className="mus-cadre"
            title="Lecteur SoundCloud"
            src={src}
            allow="autoplay; encrypted-media"
            referrerPolicy="strict-origin-when-cross-origin"
            height="300"
          />
        )}
        {s.erreur && <p className="mus-err" role="alert">{s.erreur}</p>}
        {s.refus && !s.erreur && (
          <p className="mus-note" role="status">
            Le son a été refusé par l’appareil (règle d’iOS) : lance la première lecture avec le bouton du lecteur ci-dessus ; nos
            boutons prendront ensuite le relais.
          </p>
        )}
        <form
          className="mus-ajout"
          onSubmit={(e) => {
            e.preventDefault()
            if (!saisie.trim()) return
            const f = ajoute(saisie)
            setFaute(f)
            if (!f) setSaisie('')
          }}
        >
          <input
            value={saisie}
            onChange={(e) => {
              setSaisie(e.target.value)
              setFaute('')
            }}
            placeholder="Lien SoundCloud"
            aria-label="Lien SoundCloud"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit">Ajouter</button>
        </form>
        {faute && <p className="mus-err" role="alert">{faute}</p>}
        <ul className="mus-liste">
          {s.liens.map((l) => (
            <li key={l.url} className={cls(l.url === s.actif && 'sur')}>
              <button className="mus-choix" onClick={() => choisit(l.url)} aria-pressed={l.url === s.actif}>
                {nomDe(l.url)}
              </button>
              <button className="mus-retire" onClick={() => retire(l.url)} aria-label={`Retirer ${nomDe(l.url)}`}>
                ×
              </button>
            </li>
          ))}
          {!s.liens.length && <li className="mus-vide">Un titre, une playlist, tes « j’aime » (…/likes) ou un profil.</li>}
        </ul>
      </section>
    </>
  )
}

function PanneauTete({ fermer, ouvert }) {
  // Échap n'est écouté que panneau ouvert (le terminal du dessous ne doit pas perdre le sien pour rien).
  return (
    <header className="mus-tete">
      <span>Musique</span>
      {ouvert && <Echap fermer={fermer} />}
      <button onClick={fermer} aria-label="Fermer la musique">
        Fermer
      </button>
    </header>
  )
}
function Echap({ fermer }) {
  useEchap(fermer)
  return null
}

/* ───────────── MiniMusique : les commandes, dans la colonne ───────────── */

const Ic = ({ d }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d={d} fill="currentColor" />
  </svg>
)
const D_PLAY = 'M8 5v14l11-7z'
const D_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z'
const D_PREV = 'M6 5h2v14H6zM20 5v14L9 12z'
const D_NEXT = 'M16 5h2v14h-2zM4 5l11 7L4 19z'

export function MiniMusique() {
  const s = useMusique()
  const ref = useRef(null)
  useEffect(() => {
    miniEl = ref.current
    return () => {
      miniEl = null
    }
  }, [])
  const bascule = () => maj({ ouvert: !S.ouvert })
  if (!s.actif) {
    return (
      <div className="mus-mini seul" ref={ref}>
        <button className="mus-nom" onClick={bascule} aria-expanded={s.ouvert}>
          Musique
        </button>
      </div>
    )
  }
  const prets = s.pret
  return (
    <div className="mus-mini" ref={ref}>
      <button className="mus-b" onClick={() => saute('prev')} disabled={!prets} aria-label="Morceau précédent">
        <Ic d={D_PREV} />
      </button>
      <button className="mus-b mus-jeu" onClick={lecturePause} disabled={!prets} aria-label={s.lecture ? 'Pause' : 'Lecture'}>
        <Ic d={s.lecture ? D_PAUSE : D_PLAY} />
      </button>
      <button className="mus-b" onClick={() => saute('next')} disabled={!prets} aria-label="Morceau suivant">
        <Ic d={D_NEXT} />
      </button>
      <button className="mus-titre" onClick={bascule} aria-expanded={s.ouvert} aria-label="Ouvrir le lecteur de musique">
        <b>{s.erreur ? 'Lien illisible' : s.son?.titre || (prets ? '—' : 'chargement…')}</b>
        <i>{s.erreur ? 'ouvre pour voir' : s.son?.artiste || ''}</i>
      </button>
      <span className="mus-pos" style={{ width: `${Math.round(s.pos * 100)}%` }} aria-hidden="true" />
    </div>
  )
}
