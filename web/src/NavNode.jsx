// Carte « Navigateur · <console> » (volet copies, 13/11 ; rattrapage de Symvibe 1.1.0 : « les pages localhost s'ouvrent
// dans un navigateur du plateau branché à un agent »). Orkun y voit, en direct et en LECTURE SEULE, ce que voit le
// navigateur que l'agent de la console pilote par `meydan nav …` (moteur : lib/navigateur.mjs). Le serveur pose la carte
// au premier `meydan nav ouvre` de la console et la retire avec elle ; elle ne s'ajoute jamais par la barre « Ajouter ».
//   - État (ouvert, adresse, titre) : GET /api/nav au montage et à chaque liaison refaite du flux d'état, puis les
//     événements `nav` du flux (`meydan:flux`). La carte arrive ~50 ms avant le premier événement `nav` : le montage peut
//     tomber avant ou après lui (une lecture dépassée par un événement est écartée, voir useEtatNav).
//   - Ordinateur, vue de près, page visible, navigateur ouvert : une liaison /ws/nav/<console> (état JSON, puis images
//     JPEG binaires). Chaque image → Blob → adresse d'objet posée sur l'<img> de derrière (deux <img> superposés, aucun
//     rendu React par image) ; décodée, elle passe devant et l'adresse de l'ancienne est révoquée (deux au plus vivantes :
//     pas de fuite, pas de blanc entre deux images). Rien n'est envoyé sur cette liaison, aucun clic ni aucune frappe ne
//     passe au navigateur de l'agent.
//   - Vue de loin, page cachée, navigateur fermé, carte démontée : liaison fermée (le serveur arrête son screencast quand
//     plus aucune tuile ne regarde). Liaison tombée, navigateur ouvert : nouvel essai, de plus en plus espacé (1 → 15 s) ;
//     console inconnue (4404) : plus d'essai. Navigateur fermé : la dernière image reste, grisée, avec un message ; la tuile
//     se rallume seule au prochain `ouvre` (événement `nav`).
//   - Téléphone (`tel`) : tuile FIXE — titre, adresse, état et au plus UNE image fixe (GET /api/nav/<console>/image),
//     dont l'adresse ne change qu'avec l'état (`maj`) : aucune liaison, aucun minuteur, aucune animation, aucun défilement.
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Carte } from './Carte.jsx'
import { CartesCtx } from './cartes.js'
import { api, cls, wsUrl } from './lib.js'
import './carte-nav.css'

// L'adresse telle qu'on la lit dans une barre étroite : sans « http:// », « page vide » pour about:blank.
const lisible = (url) => (!url ? '' : url === 'about:blank' ? 'page vide' : url.replace(/^http:\/\//, ''))

// L'état du navigateur d'une console, tenu à jour par le flux d'état (et relu à chaque liaison refaite).
// Un événement s'applique toujours ; une lecture (GET) aussi, sauf si un événement est arrivé pendant qu'elle était en
// route (elle serait plus vieille que lui). Pas de comparaison de `maj` : après un redémarrage de Meydan, le serveur rend
// `{ ouvert: false, maj: 0 }` pour un navigateur parti avec lui, et cet état doit l'emporter sur celui d'avant (le
// téléphone, sans liaison, resterait sinon « ouvert » avec une vieille image). `maj` ne sert qu'à nommer l'image fixe.
const forme = (e, maj) => ({ ouvert: !!e.ouvert, url: e.url || '', titre: e.titre || '', maj: maj ?? (e.maj || 0) })
function useEtatNav(consoleId) {
  const [etat, setEtat] = useState(null) // { ouvert, url, titre, maj } ; null tant qu'on ne sait pas
  const recus = useRef(0) // événements reçus (flux ou liaison de la tuile) : une lecture partie avant eux est dépassée
  // L'état envoyé par la liaison de la tuile (sans `maj`) : il est du moment même.
  const prendDirect = useCallback((e) => {
    recus.current++
    setEtat((a) => forme(e, a?.maj || 0))
  }, [])
  useEffect(() => {
    let vivant = true
    const relis = () => {
      const avant = recus.current
      api('GET', '/api/nav').then(
        (j) => {
          if (!vivant || recus.current !== avant) return
          const n = (j.navs || []).find((x) => x.console === consoleId)
          setEtat(forme(n || { ouvert: false }))
        },
        () => {},
      )
    }
    const recu = (ev) => {
      const m = ev.detail
      if (m?.type === 'nav' && m.nav?.console === consoleId) {
        recus.current++
        setEtat(forme(m.nav))
      } else if (m?.type === 'snapshot') relis() // liaison du flux refaite (Meydan relancé, réseau revenu) : on relit
    }
    window.addEventListener('meydan:flux', recu) // d'abord l'écoute, puis la lecture : rien ne passe entre les deux
    relis()
    return () => {
      vivant = false
      window.removeEventListener('meydan:flux', recu)
    }
  }, [consoleId])
  return [etat, prendDirect]
}

export const NavNode = memo(function NavNode({ id, data: k, width, height, selected }) {
  const { far, tel } = useContext(CartesCtx)
  const [etat, prendDirect] = useEtatNav(k.console)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const [liaison, setLiaison] = useState('aucune') // aucune | attente | ouverte | coupee | perdue
  const [direct, setDirect] = useState(false) // une image reçue sur la liaison en cours
  const [aImage, setAImage] = useState(false) // une image à montrer (la dernière reçue, gardée navigateur fermé)
  const [imageKo, setImageKo] = useState(-1) // téléphone : le `maj` dont l'image n'a pas pu être lue
  // Deux <img> superposés (ordinateur) : l'image qui arrive se charge et se décode dans celui de derrière, puis passe
  // devant. Mesuré au banc le 13/11 : un seul <img> dont on change `src` n'a plus d'image (naturalWidth 0) le temps de
  // lire la suivante — un blanc possible entre deux images, jusqu'à 5 fois par seconde.
  const images = useRef([null, null])
  const adresses = useRef([null, null]) // l'adresse d'objet de chaque <img> (deux au plus : devant, et celle qui charge)
  const devant = useRef(0)

  // Page cachée (onglet en arrière-plan, téléphone en veille) : la tuile ne regarde plus. Ordinateur seulement.
  useEffect(() => {
    if (tel) return
    const vu = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', vu)
    return () => document.removeEventListener('visibilitychange', vu)
  }, [tel])

  // L'image reçue va dans l'<img> de derrière ; décodée, elle passe devant et l'adresse de l'ancienne est révoquée. Une
  // image encore en chargement quand la suivante arrive est abandonnée (révoquée) : rien ne s'accumule.
  const montre = useCallback((donnees) => {
    const u = URL.createObjectURL(new Blob([donnees], { type: 'image/jpeg' }))
    const i = 1 - devant.current
    if (adresses.current[i]) URL.revokeObjectURL(adresses.current[i])
    adresses.current[i] = u
    const el = images.current[i]
    if (!el) return
    el.src = u
    el.decode().then(
      () => {
        if (adresses.current[i] !== u || devant.current === i) return // dépassée entre-temps
        const j = devant.current
        el.classList.add('est-devant')
        images.current[j]?.classList.remove('est-devant')
        if (adresses.current[j]) URL.revokeObjectURL(adresses.current[j])
        adresses.current[j] = null
        devant.current = i
        setAImage(true)
        setDirect(true)
      },
      () => {}, // remplacée avant d'être décodée (ou illisible) : l'image de devant reste
    )
  }, [])
  // Les <img> remontent (retour de la vue de loin) : celui de devant reprend la dernière image tout de suite.
  const poseImage = useMemo(
    () =>
      [0, 1].map((i) => (el) => {
        images.current[i] = el
        if (!el) return
        el.classList.toggle('est-devant', i === devant.current)
        if (adresses.current[i]) el.src = adresses.current[i]
      }),
    [],
  )
  useEffect(
    () => () => {
      for (const u of adresses.current) if (u) URL.revokeObjectURL(u)
      adresses.current = [null, null]
    },
    [],
  )

  // La liaison des images : seulement quand la tuile sert vraiment.
  const actif = !tel && !far && visible && !!etat?.ouvert
  useEffect(() => {
    if (!actif) return
    let fini = false
    let ws = null
    let minuterie = 0
    let essais = 0
    const connecte = () => {
      const s = (ws = new WebSocket(wsUrl(`/ws/nav/${k.console}`)))
      s.binaryType = 'blob'
      setLiaison('attente')
      setDirect(false)
      s.onopen = () => s === ws && setLiaison('ouverte')
      s.onmessage = (e) => {
        if (s !== ws) return
        essais = 0
        if (typeof e.data !== 'string') return montre(e.data)
        let m = null
        try {
          m = JSON.parse(e.data)
        } catch {} // message illisible : ignoré
        if (m?.type === 'etat') prendDirect(m)
      }
      s.onclose = (e) => {
        if (fini || s !== ws) return
        ws = null
        setDirect(false)
        if (e.code === 4404) return setLiaison('perdue') // console inconnue ou fermée : sa carte s'en va avec elle
        setLiaison('coupee')
        minuterie = setTimeout(connecte, Math.min(15000, 1000 * 2 ** essais++))
      }
    }
    connecte()
    return () => {
      fini = true
      clearTimeout(minuterie)
      const s = ws
      ws = null
      // Une liaison encore en cours d'ouverture se ferme une fois ouverte (sinon Chrome écrit une erreur à la console).
      if (s) s.readyState === WebSocket.CONNECTING ? (s.onopen = () => s.close()) : s.close()
      setLiaison('aucune')
      setDirect(false)
    }
  }, [actif, k.console, montre, prendDirect])

  const adresse = lisible(etat?.url)
  const titre = `Navigateur · ${k.console}`

  // ── Téléphone : tuile fixe ──
  if (tel) {
    const ouvert = !!etat?.ouvert
    return (
      <Carte id={id} k={k} width={width} height={height} selected={selected} titre={titre}>
        <div className="et-nav-tel">
          <p className="et-nav-tel-adresse">{adresse || '—'}</p>
          <p className={cls('et-nav-tel-etat', ouvert && 'est-ouvert')}>{!etat ? '…' : ouvert ? 'ouvert' : 'fermé'}</p>
          {ouvert && imageKo !== etat.maj && (
            <img
              className="et-nav-tel-image"
              src={`/api/nav/${k.console}/image?v=${etat.maj}`}
              alt={`Ce que voit le navigateur de l’agent : ${etat.titre || adresse}`}
              decoding="async"
              draggable={false}
              onError={() => setImageKo(etat.maj)}
            />
          )}
        </div>
      </Carte>
    )
  }

  // ── Ordinateur ──
  const cle = !etat ? 'attente' : !etat.ouvert ? 'ferme' : liaison === 'perdue' || liaison === 'coupee' ? 'coupe' : direct ? 'direct' : 'attente'
  const libelle = { attente: 'en attente de l’agent', ferme: 'fermé', coupe: liaison === 'perdue' ? 'console fermée' : 'liaison coupée', direct: 'en direct' }[cle]
  const outils = (
    <span className="et-nav-infos">
      <span className="et-nav-adresse" title={etat?.url || undefined}>
        {adresse}
      </span>
      <span className={cls('et-nav-etat', `est-${cle}`)}>{libelle}</span>
    </span>
  )
  const message = !etat
    ? 'Lecture de l’état du navigateur…'
    : !etat.ouvert
      ? 'Navigateur fermé. Il se rallume au prochain « meydan nav ouvre » de l’agent.'
      : !aImage
        ? 'En attente de la première image du navigateur de l’agent…'
        : ''
  return (
    <Carte id={id} k={k} width={width} height={height} selected={selected} titre={titre} outils={outils}>
      {far ? null : (
        <div className={cls('et-nav-vue', !aImage && 'est-vide', etat && !etat.ouvert && 'est-ferme')}>
          {/* La classe « est-devant » est posée par montre() et poseImage, jamais par le rendu (aucun rendu par image). */}
          {poseImage.map((pose, i) => (
            <img key={i} ref={pose} className="et-nav-image" alt={`Ce que voit le navigateur de l’agent : ${etat?.titre || adresse}`} draggable={false} />
          ))}
          {message && <p className="et-nav-message">{message}</p>}
        </div>
      )}
    </Carte>
  )
})
