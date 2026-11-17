import { useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { MenuDoigt } from './appui.jsx'
import { api, cls } from './lib.js'

// Espaces de travail, sur l'ordinateur. Orkun, 11/11 : « Espaces de travail : enregistrer la disposition actuelle sous un
// nom, en onglets, et y revenir en un clic. »
// Un espace = la place et la taille de chaque console au moment où on l'enregistre, et la vue du plateau. Y revenir remet
// les consoles qui existent encore (celles fermées depuis sont sautées ; celles ouvertes après restent où elles sont) et
// la vue ; c'est un pas de l'historique (Board.jsx : « Espace « nom » », Ctrl+Z l'annule).
// Décision d'Orkun du 17/11, plateau-pc-2 (« Espaces de travail : appareil ou serveur ») : « Sur le serveur (partagés) ».
// Gardés par le serveur (GET / POST / PATCH / PUT / DELETE /api/espaces, un espace par demande : lib/espaces.mjs) : les
// mêmes sur le Mac et le PC. Relus quand la page revient à l'écran (focus, visibilitychange) et après chaque écriture.
// Avant, ils étaient gardés sur l'appareil (localStorage['meydan.espaces']) : au premier chargement de cette version,
// chaque appareil VERSE au serveur ce qu'il y gardait (fusion par id : ce que le serveur a déjà ne change pas, ce qui a
// été supprimé sur un autre écran ne revient pas). La liste de l'appareil n'est jamais effacée ni réécrite ; les ids
// acquittés par le serveur sont notés à part (VERSES), un par un et seulement APRÈS sa réponse : un versement coupé
// reprend au chargement suivant, et un ancien onglet resté ouvert qui ajoute un espace sur l'appareil le verra versé.
// Navigation privée ou stockage interdit : rien à verser, le serveur suffit.
// [{ id, nom, places: { idConsole: { x, y, w, h } }, vue: { x, y, zoom }, t }]
const CLE = 'meydan.espaces' // l'ancien stockage de l'appareil : lu, jamais écrit
const VERSES = 'meydan.espaces.verses' // les ids de l'appareil déjà acquittés par le serveur
const NOM_MAX = 40 // en points de code, comme le serveur (un émoji = 1)
// Couper sans casser un émoji (jamais `slice` ni `maxLength`, qui comptent l'UTF-16) ; un nom sans caractère visible
// (blancs, accents seuls, blanc braille) vaut un nom vide (lib/nom-libre.mjs, relecture du 17/11).
const coupe = (t) => [...t].slice(0, NOM_MAX).join('')
const visible = (t) => /[^\s\p{M}\u2800]/u.test(t)
const nombre = (v) => typeof v === 'number' && Number.isFinite(v)
const lisible = (e) =>
  e && typeof e.id === 'string' && typeof e.nom === 'string' && e.places && typeof e.places === 'object' && Object.values(e.places).every((p) => p && ['x', 'y', 'w', 'h'].every((k) => nombre(p[k])))
function lireJson(cle) {
  try {
    return JSON.parse(localStorage.getItem(cle))
  } catch {
    return null // stockage illisible ou interdit
  }
}
// Verse au serveur les espaces de l'appareil qu'il n'a pas encore acquittés. Rend le nombre de ceux qui restent sur
// l'appareil sans être au serveur (refusés ou pas encore passés), avec la raison du premier.
async function verse() {
  const locaux = lireJson(CLE)
  if (!Array.isArray(locaux) || !locaux.length) return { reste: 0 }
  const vus = lireJson(VERSES)
  const acquis = new Set(Array.isArray(vus) ? vus : [])
  let reste = 0
  let raison = ''
  for (const e of locaux) {
    if (!e || typeof e.id !== 'string' || acquis.has(e.id)) continue
    try {
      await api('POST', '/api/espaces', { id: e.id, nom: e.nom, places: e.places, vue: e.vue, t: e.t })
      acquis.add(e.id) // 201 (versé) ou 200 (déjà là : rien ne change)
    } catch (err) {
      // 410 : supprimé sur un autre écran, il ne revient pas (acquitté). Liaison coupée, 409 (trop d'espaces), 5xx :
      // réessayé au prochain chargement. 400 (forme refusée) : il reste sur l'appareil, et c'est dit.
      if (err.status === 410) acquis.add(e.id)
      else {
        reste++
        raison ||= err.message
      }
    }
    try {
      localStorage.setItem(VERSES, JSON.stringify([...acquis]))
    } catch {} // stockage interdit : rien ne se perd, le prochain chargement reverse (sans rien doubler)
  }
  return { reste, raison }
}
const meme = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
const quand = (t) => (nombre(t) ? new Date(t).toLocaleString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

// `onRevenir(espace)` : Board remet les places et la vue, et l'inscrit à l'historique.
export function Espaces({ consoles, onRevenir }) {
  const rf = useReactFlow()
  const [espaces, setEspaces] = useState([])
  const [nommer, setNommer] = useState(null) // { id: null (nouvel espace) | id (renommer), nom }
  const [menu, setMenu] = useState(null) // { id, x, y, supprimer }
  const [dernier, setDernier] = useState(null) // l'espace où l'on vient d'aller, ou qu'on vient d'enregistrer
  const [avis, setAvis] = useState('') // ce qui n'a pas pu être gardé par le serveur, dit à l'écran
  // Chaque écriture et chaque relecture prend un numéro : une relecture partie avant une écriture ne l'efface pas à
  // son retour (seule la dernière demande partie pose la liste).
  const tour = useRef(0)
  const relis = async () => {
    const n = ++tour.current
    try {
      const r = await api('GET', '/api/espaces')
      if (n === tour.current && Array.isArray(r?.espaces)) setEspaces(r.espaces.filter(lisible))
    } catch {} // liaison coupée : la liste affichée reste
  }
  useEffect(() => {
    let mort = false
    ;(async () => {
      await relis()
      const { reste, raison } = await verse()
      if (mort) return
      if (reste) setAvis(`${reste} espace${reste > 1 ? 's' : ''} de cet appareil pas encore sur le serveur (${raison}) : ${reste > 1 ? 'ils restent' : 'il reste'} sur l’appareil, nouvel essai au prochain chargement.`)
      await relis()
    })()
    const auRetour = () => document.visibilityState === 'visible' && relis()
    document.addEventListener('visibilitychange', auRetour)
    window.addEventListener('focus', auRetour)
    return () => {
      mort = true
      document.removeEventListener('visibilitychange', auRetour)
      window.removeEventListener('focus', auRetour)
    }
  }, [])
  // Une écriture : l'écran change tout de suite, le serveur suit ; refusée (ou supprimé sur un autre écran), l'écran
  // reprend ce que le serveur garde et le dit.
  const ecrit = (local, methode, chemin, corps) => {
    ++tour.current
    setEspaces(local)
    setAvis('')
    api(methode, chemin, corps).then(
      () => relis(),
      (e) => {
        setAvis(`Espace non enregistré : ${e.message}`)
        relis()
      },
    )
  }
  const parId = new Map(consoles.map((c) => [c.id, c]))
  const ici = () => Object.fromEntries(consoles.map((c) => [c.id, { x: c.x, y: c.y, w: c.w, h: c.h }]))
  // L'onglet marqué : celui où l'on vient d'aller (ou qu'on vient d'enregistrer), tant que chaque console enregistrée qui
  // existe encore est à sa place enregistrée (la vue ne compte pas : regarder ailleurs ne change pas la disposition).
  // Page rechargée : le premier espace dont la disposition est à l'écran. Un seul onglet marqué, même si deux espaces
  // ont la même disposition.
  const correspond = (e) => {
    const ids = Object.keys(e.places).filter((id) => parId.has(id))
    return ids.length > 0 && ids.every((id) => meme(e.places[id], parId.get(id)))
  }
  const marque = dernier ? espaces.find((e) => e.id === dernier && correspond(e)) : espaces.find(correspond)
  const actif = (e) => e === marque
  const valide = (ev) => {
    ev.preventDefault()
    const net = coupe(nommer.nom.trim())
    const nom = visible(net) ? net : `Espace ${espaces.length + 1}`
    if (nommer.id) ecrit((l) => l.map((e) => (e.id === nommer.id ? { ...e, nom } : e)), 'PATCH', `/api/espaces/${nommer.id}`, { nom })
    else {
      const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const e = { id, nom, places: ici(), vue: rf.getViewport(), t: Date.now() }
      ecrit((l) => [...l, e], 'POST', '/api/espaces', e)
      setDernier(id)
    }
    setNommer(null)
  }
  const champ = nommer && (
    <form
      className="pc-espace-champ"
      onSubmit={valide}
      onBlur={(ev) => !ev.currentTarget.contains(ev.relatedTarget) && setNommer(null)} // cliquer ailleurs : rien n'est enregistré
    >
      <input
        autoFocus
        value={nommer.nom}
        placeholder="Nom de l’espace"
        aria-label={nommer.id ? 'Nouveau nom de l’espace' : 'Nom du nouvel espace (Entrée enregistre la disposition actuelle)'}
        onChange={(ev) => setNommer({ ...nommer, nom: coupe(ev.target.value) })}
        onKeyDown={(ev) => ev.key === 'Escape' && setNommer(null)}
      />
      <button type="submit">{nommer.id ? 'OK' : 'Enregistrer'}</button>
    </form>
  )
  const ouvreMenu = (id, x, y) => setMenu({ id, x, y, supprimer: false })
  const enMenu = menu && espaces.find((e) => e.id === menu.id)
  return (
    <nav className="pc-espaces" aria-label="Espaces de travail">
      {espaces.map((e) => {
        if (nommer?.id === e.id) return <span key={e.id}>{champ}</span>
        const n = Object.keys(e.places).filter((id) => parId.has(id)).length
        const parties = Object.keys(e.places).length - n
        const estMarque = actif(e)
        return (
          <span
            key={e.id}
            className={cls('pc-onglet', estMarque && 'est-actif')}
            onContextMenu={(ev) => {
              ev.preventDefault()
              ouvreMenu(e.id, ev.clientX, ev.clientY)
            }}
          >
            <button
              type="button"
              className="pc-onglet-nom"
              aria-current={estMarque ? 'true' : undefined}
              title={`Revenir à « ${e.nom} » (enregistré le ${quand(e.t)}) : ${n} console${n > 1 ? 's' : ''} reprennent leur place${parties ? `, ${parties} fermée${parties > 1 ? 's' : ''} depuis` : ''}, et la vue revient. Les consoles ouvertes après l’enregistrement restent où elles sont. Ctrl+Z annule.${estMarque ? '\nLa disposition actuelle est celle de cet espace.' : ''}`}
              onClick={() => {
                setDernier(e.id)
                onRevenir(e)
              }}
            >
              {e.nom}
            </button>
            <button
              type="button"
              className="pc-onglet-plus"
              aria-label={`Espace « ${e.nom} » : renommer, remplacer, supprimer`}
              title="Renommer, remplacer par la disposition actuelle, supprimer (ou clic droit sur l’onglet)"
              onClick={(ev) => {
                const r = ev.currentTarget.getBoundingClientRect()
                ouvreMenu(e.id, r.left + r.width / 2, r.bottom)
              }}
            >
              ⋯
            </button>
          </span>
        )
      })}
      {nommer && !nommer.id ? (
        champ
      ) : (
        <button type="button" className="pc-espace-ajoute" aria-label="Nouvel espace de travail" title="Enregistrer la disposition actuelle (places, tailles et vue) comme espace de travail, gardé sur le serveur (le même sur tous tes écrans)" onClick={() => setNommer({ id: null, nom: '' })}>
          +{espaces.length ? '' : ' Espace'}
        </button>
      )}
      {avis && (
        <span className="pc-espace-avis" role="status" title={avis}>
          {avis}
        </span>
      )}
      {enMenu && (
        <MenuDoigt x={menu.x} y={menu.y} onClose={() => setMenu(null)} colonne>
          {menu.supprimer ? (
            <button
              type="button"
              onClick={() => {
                ecrit((l) => l.filter((e) => e.id !== enMenu.id), 'DELETE', `/api/espaces/${enMenu.id}`)
                setMenu(null)
              }}
            >
              Confirmer : supprimer « {enMenu.nom} »
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setMenu(null)
                  setNommer({ id: enMenu.id, nom: enMenu.nom })
                }}
              >
                Renommer
              </button>
              <button
                type="button"
                onClick={() => {
                  const disposition = { places: ici(), vue: rf.getViewport() }
                  ecrit((l) => l.map((e) => (e.id === enMenu.id ? { ...e, ...disposition, t: Date.now() } : e)), 'PUT', `/api/espaces/${enMenu.id}`, disposition)
                  setDernier(enMenu.id)
                  setMenu(null)
                }}
              >
                Remplacer par la disposition actuelle
              </button>
              <button type="button" onClick={() => setMenu({ ...menu, supprimer: true })}>
                Supprimer…
              </button>
            </>
          )}
        </MenuDoigt>
      )}
    </nav>
  )
}
