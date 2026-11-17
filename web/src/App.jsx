import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plateau, prechargeTerm } from './differe.js'
import { Veille } from './Veille.jsx'
import { MiniMusique, Musique } from './Musique.jsx'
import { Rail } from './Rail.jsx'
import { MobileConsole } from './MobileConsole.jsx'
import { PanneauBoucle } from './Boucle.jsx'
import { Ordre } from './Ordre.jsx'
import { Parler } from './parler.jsx'
import { Memoire, projetMemoire } from './Memoire.jsx'
import { Ensemble } from './Ensemble.jsx'
import { Voix } from './Voix.jsx'
import { AideRaccourcis } from './Raccourcis.jsx'
// Vue carte de mission, touche X (décision d'Orkun du 17/11, raccourcis-4) : ordinateur seulement.
import { Mission } from './Mission.jsx'
import { toucheEnSaisie, useBranche, useRaccourcis } from './raccourcis.js'
import { optionEcrit } from './option-mac.js'
import { api, equipeAttend, useEvents, useLook, useMedia } from './lib.js'
import { etapeConsole } from './retour.js'
import { useDemandes } from './budget.js' // volet quota : les demandes (budget atteint, lancement à valider) attendent aussi

const VUES_KEY = 'meydan.vues'
function lireVues() {
  try {
    const v = JSON.parse(localStorage.getItem(VUES_KEY))
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x === 'fil' || x === 'terminal'))
  } catch {} // stockage illisible ou interdit : chaque console part en terminal
  return {}
}

export function App() {
  const { consoles: recues, teams, online, patchLocal, memoire } = useEvents()
  // Une console qu'Orkun ferme part de l'écran tout de suite (`partante`), sans attendre la réponse du serveur : le 16/11,
  // depuis son Mac, la dalle restait un instant et il recliquait (DELETE en double → 404). Un refus la fait revenir, dit.
  const consoles = useMemo(() => recues.filter((c) => !c.partante), [recues])
  const consolesRef = useRef(recues)
  consolesRef.current = recues
  // Une nouvelle version de Meydan est en ligne (lib.js, `meydan:version`) : la page se recharge seule si rien n'est en
  // cours d'écriture ; sinon un bandeau « Recharger » attend (un texte tapé ne se perd pas).
  const [nouvelle, setNouvelle] = useState(false)
  useEffect(() => {
    // « En cours d'écriture » : le champ où le clavier est (hors terminal), s'il porte du texte ; ou un message à un agent
    // ou un ordre déjà tapés. Pas tous les champs de la page : le formulaire « Nouvelle console » a un dossier pré-rempli,
    // et la page ne se serait jamais rechargée (essai-version).
    const saisie = () => {
      const a = document.activeElement
      const champ = a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && ['text', 'search', ''].includes(a.getAttribute('type') || ''))) && !a.closest('.xterm')
      if (champ && a.value.trim()) return true
      // Un terminal dont la liaison est coupée garde ce qui a été tapé (liaison.js) : un rechargement le jetterait.
      if (document.querySelector('.liaison-coupee[data-attente]')) return true
      return [...document.querySelectorAll('.envoi textarea, .ordre textarea')].some((e) => e.value.trim())
    }
    const voit = () => (saisie() ? setNouvelle(true) : location.reload())
    window.addEventListener('meydan:version', voit)
    return () => window.removeEventListener('meydan:version', voit)
  }, [])
  const [avis, setAvis] = useState(null) // { texte } : un refus du serveur, dit à l'écran 6 s
  useEffect(() => {
    if (!avis) return
    const t = setTimeout(() => setAvis(null), 6000)
    return () => clearTimeout(t)
  }, [avis])
  const [activeId, setActiveId] = useState(null)
  const [openId, setOpenId] = useState(null) // console ouverte en plein écran (téléphone)
  const [boucleDe, setBoucleDe] = useState(null) // console dont le panneau de boucle est ouvert
  const [ordre, setOrdre] = useState(null) // { texte, source, n } quand la barre d'ordres est ouverte
  // Mémoire de projet (Memoire.jsx) : { projet } quand le panneau est ouvert (`null` dedans : il choisit lui-même).
  const [memoireDe, setMemoireDe] = useState(null)
  const teamsRef = useRef(teams)
  teamsRef.current = teams
  // Ordinateur : la console agrandie (toute la place à droite de la colonne, qui sert alors à passer de l'une à l'autre).
  const [plein, setPlein] = useState(null)
  // Ordinateur : discussion ('fil') ou terminal, par console d'agent. Un choix fait par le bouton est retenu sur
  // l'appareil ; « Répondre dans le terminal » ne fait qu'un passage provisoire, oublié au rechargement.
  const [vues, setVues] = useState(lireVues)
  const retenues = useRef(vues)
  const rangerRef = useRef(null) // { ranger, defait }, posé par Board
  // Ordinateur : cadrer le plateau sur des consoles (`fitView` de React Flow). Plateau, chargé à part (differe.js), pose
  // sa fonction ici en arrivant ; un cadrage demandé avant (notification qui ouvre Meydan sur une console : les consoles
  // arrivent souvent avant le plateau) est gardé, et Plateau le fait en arrivant.
  const cadreRef = useRef(null)
  const cadrer = useCallback((o) => (typeof cadreRef.current === 'function' ? cadreRef.current(o) : (cadreRef.current = o)), [])
  const ordreRef = useRef([]) // les consoles dans l'ordre de la liste, posé par Rail (raccourcis Alt+1…9)
  const [look, setLook] = useLook()
  // Téléphone à l'essai (`?tel=2`) : un téléphone couché reste un téléphone (terminal en plein écran, pas le plateau), et
  // un écran moyen tenu au doigt (pliable ouvert, tablette) montre la liste et la console côte à côte.
  const essai = look.tel === '2'
  // Un téléphone couché reste un téléphone, pour tout le monde depuis le 10/11 (Orkun : « quand jss en paysage j'arrive
  // meme pas a lancer claude car je dois faire fleche du bas » : le plateau d'ordinateur n'a ni touches ni barre d'envoi).
  const mobile = useMedia('(max-width: 760px), (max-height: 520px) and (pointer: coarse)')
  // Téléphone couché : l'accueil est la vue d'ensemble (les agents vus de haut), la liste reste à un toucher. Le choix
  // est retenu sur l'appareil.
  const couche = useMedia('(orientation: landscape) and (max-height: 520px) and (pointer: coarse)')
  // Trois affichages : le plateau (celui de l'ordinateur, par défaut : « Je la trouve plus stylé », Orkun, 10/11), les
  // tuiles (vue d'ensemble en mosaïque) et la liste.
  const [accueil, setAccueil] = useState(() => {
    const v = localStorage.getItem('meydan.paysage')
    return v === 'liste' || v === 'ensemble' ? v : 'plateau'
  })
  const choisit = (v) => {
    setAccueil(v)
    try {
      localStorage.setItem('meydan.paysage', v)
    } catch {} // navigation privée : le choix vaut pour cette visite
  }
  const bascule = couche && (
    <nav className="ve-bascule" aria-label="Affichage de l’accueil">
      {[
        ['plateau', 'Plateau'],
        ['ensemble', 'Tuiles'],
        ['liste', 'Liste'],
      ].map(([v, nom]) => (
        <button key={v} type="button" aria-pressed={accueil === v} onClick={() => choisit(v)}>
          {nom}
        </button>
      ))}
    </nav>
  )
  const moyen = useMedia('(min-width: 761px) and (max-width: 1180px) and (pointer: coarse)')
  const deux = essai && moyen && !mobile
  // Ordinateur : les dalles portent des terminaux ; le code de xterm part en même temps que celui du plateau (differe.js),
  // pas après lui. Le plateau du téléphone couché, lui, n'en monte aucun et ne le charge pas.
  useEffect(() => {
    if (!mobile && !deux) prechargeTerm()
  }, [mobile, deux])

  // Orkun (16/11) : « la gestion des fenetres fermés qui restent visible ralenti l'app (tu devrais le mettre dans un onglet
  // historique et non dans tout) ». Les consoles fermées ne sont plus posées sur le plateau (ni l'ordinateur ni le
  // téléphone couché) ; la colonne les range dans son onglet « Historique » (Rail.jsx). Mesuré au banc « MacBook » (28
  // consoles dont 20 fermées, 1728 × 1000 à densité 2) : 1 687 → 836 nœuds, zoom 185 → 93 ms de fil principal par seconde.
  const vivantes = useMemo(() => consoles.filter((c) => c.status !== 'closed'), [consoles])
  // Celles qui t'attendent, la plus ancienne d'abord.
  const waiting = useMemo(() => consoles.filter((c) => c.status === 'needs').sort((a, b) => a.since - b.since), [consoles])
  // Une équipe dont le capitaine a déclaré le travail prêt attend aussi : sa livraison se fait sur le go d'Orkun. Et une
  // équipe qui t'appelle (question, blocage ou échec du capitaine, verdict à lire : 17/11).
  const demandes = useDemandes() // volet quota : budget atteint, lancement à valider
  const needs = waiting.length + teams.filter(equipeAttend).length + demandes.length
  useEffect(() => {
    document.title = needs ? `(${needs}) Meydan` : 'Meydan'
  }, [needs])

  // Hauteur réellement visible (clavier de l'iPhone compris).
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    // Clavier ouvert, l'iPhone fait aussi glisser la page vers le haut pour montrer le champ touché : `--vvt` suit ce
    // décalage, sinon la barre du haut (et son retour vers la liste) sortait de l'écran (Orkun, 10/11 : « en portrait
    // je sais pas sortir d'un terminal »).
    // Ces deux valeurs ne sont posées que CLAVIER OUVERT. Sans clavier, la hauteur est celle que le navigateur calcule
    // lui-même (100dvh) et le haut vaut 0 : une valeur relevée au mauvais moment (rotation, clavier qui se ferme, retour
    // de l'arrière-plan) ne peut plus rester en travers. Vu le 10/11 sur l'iPhone d'Orkun : tout l'écran décalé de 50
    // points vers le bas, touches coupées, parce qu'un ancien décalage était resté posé.
    const set = () => {
      const s = document.documentElement.style
      const mange = window.innerHeight - vv.height // ce que le clavier retire à l'écran
      if (vv.scale > 1.01 || mange < 60) {
        s.removeProperty('--vvh')
        s.removeProperty('--vvt')
        if (window.scrollY) window.scrollTo(0, 0) // la page a pu rester glissée après la fermeture du clavier
      } else {
        s.setProperty('--vvh', `${vv.height}px`)
        s.setProperty('--vvt', `${Math.max(0, Math.min(vv.offsetTop, mange))}px`) // jamais plus bas que la place prise par le clavier
      }
    }
    // L'iPhone annonce parfois l'ancienne taille au premier événement d'une rotation : on relit un instant plus tard.
    let plusTard = []
    const relit = () => {
      set()
      plusTard.forEach(clearTimeout)
      plusTard = [150, 500].map((ms) => setTimeout(set, ms))
    }
    relit()
    const cibles = [
      [vv, 'resize'],
      [vv, 'scroll'],
      [window, 'resize'],
      [window, 'orientationchange'],
      [window, 'pageshow'],
      [window, 'focusout'],
      [document, 'visibilitychange'],
    ]
    for (const [cible, nom] of cibles) cible.addEventListener(nom, relit)
    return () => {
      plusTard.forEach(clearTimeout)
      for (const [cible, nom] of cibles) cible.removeEventListener(nom, relit)
    }
  }, [])

  // Téléphone : ouvrir une console ajoute une étape à l'historique du navigateur. Le geste « retour » de l'iPhone
  // (glisser depuis le bord gauche) et le bouton retour ramènent alors à la liste au lieu de quitter Meydan.
  // Orkun voit une console FINIE (il l'ouvre, la choisit, la touche sur le plateau, l'agrandit) : elle passe au repos.
  const vuesRef = useRef(consoles)
  vuesRef.current = consoles
  const vu = useCallback((id) => {
    if (vuesRef.current.find((c) => c.id === id)?.status === 'fini') api('POST', `/api/consoles/${id}/vu`).catch(() => {})
  }, [])
  const activer = useCallback(
    (id) => {
      setActiveId(id)
      if (id) vu(id)
    },
    [vu],
  )
  const ouvrir = useCallback((id) => {
    vu(id)
    etapeConsole(id) // passer d'une console à l'autre, ou d'un panneau à une console, n'empile rien (retour.js)
    setOpenId(id)
  }, [vu])
  const fermer = useCallback(() => {
    if (history.state?.console) history.back() // l'événement « popstate » referme la console
    else setOpenId(null)
  }, [])
  // Notification touchée : ouvrir la console qu'elle désigne. Par un message du service worker quand Meydan était déjà
  // ouvert, par « ?ouvre=<console> » quand la notification l'a ouvert.
  const pickRef = useRef(null) // la fonction qui ouvre une console, définie plus bas
  // `etats` : le nombre d'états complets des consoles reçus (« snapshot » du flux, lib.js), à chaque connexion. Avant le
  // premier, la liste est vide sans rien dire ; une demande `{ id, apres }` se tranche au premier état reçu après elle.
  const etatsRef = useRef(0)
  const [etats, setEtats] = useState(0)
  const [aOuvrir, setAOuvrir] = useState(() => {
    const id = new URLSearchParams(location.search).get('ouvre')
    return id ? { id, apres: 0 } : null
  })
  useEffect(() => {
    const flux = (e) => e.detail?.type === 'snapshot' && setEtats(++etatsRef.current)
    const recu = (e) => typeof e.data?.ouvre === 'string' && setAOuvrir({ id: e.data.ouvre, apres: etatsRef.current })
    window.addEventListener('meydan:flux', flux)
    navigator.serviceWorker?.addEventListener('message', recu)
    return () => {
      window.removeEventListener('meydan:flux', flux)
      navigator.serviceWorker?.removeEventListener('message', recu)
    }
  }, [])
  // La console arrive avec l'état des consoles, un peu après le chargement (ou après le réveil du téléphone : le message
  // de la notification précède alors l'état de la reconnexion). Un état reçu après la demande, sans elle : la console
  // n'existe plus. Avant le 17/11, `?ouvre=<inconnue>` restait dans l'adresse et se rejouait à chaque rechargement.
  useEffect(() => {
    if (!aOuvrir) return
    const la = consoles.some((c) => c.id === aOuvrir.id)
    if (!la && etats <= aOuvrir.apres) return
    if (new URLSearchParams(location.search).has('ouvre')) history.replaceState(history.state, '', location.pathname)
    setAOuvrir(null)
    if (la) pickRef.current?.(aOuvrir.id)
    else setAvis({ texte: 'Cette console n’existe plus : elle a été retirée depuis la notification.' }) // une fermée s'ouvre encore
  }, [aOuvrir, consoles, etats])
  useEffect(() => {
    // Page rechargée sur une console ou un panneau (retour.js) : on repart de la liste.
    if (history.state?.console || history.state?.panneau) history.replaceState(null, '')
    const retour = () => setOpenId(history.state?.console || null)
    addEventListener('popstate', retour)
    return () => removeEventListener('popstate', retour)
  }, [])

  // 17/11 (chasse « équipes » n°9) : un équipier fermé, ou une équipe arrêtée, avec un travail non commité : son dossier
  // reste sur le disque (le serveur le rend dans `garde` / `gardes`), et l'écran ne le disait pas.
  const ditGardes = (r) => {
    const g = [...(r?.garde ? [r.garde] : []), ...(Array.isArray(r?.gardes) ? r.gardes : [])]
    if (g.length) setAvis({ texte: `Travail non commité gardé sur le disque : ${g.join(', ')}` })
    return r
  }
  const actions = useMemo(
    () => ({
      patch(id, patch) {
        patchLocal(id, patch) // tout de suite à l'écran, puis confirmé par le serveur
        api('PATCH', `/api/consoles/${id}`, patch).catch(() => {})
      },
      // Rendue (« Vider l'historique » les retire l'une après l'autre). Partie de l'écran tout de suite ; refusée par le
      // serveur (un capitaine : c'est l'équipe qu'on arrête), elle revient et le refus est dit — avant le 16/11 il était avalé,
      // et 18 clics sur deux capitaines n'avaient rien fait sans un mot.
      remove(id) {
        const c = consolesRef.current.find((x) => x.id === id)
        // Un capitaine ne se ferme pas seul (409) : son bouton dit « Arrêter l'équipe ? », et c'est l'équipe qui s'arrête
        // (comme « Arrêter » dans la liste ; le travail des équipiers est gardé par le serveur).
        if (c?.chief && c.team) return api('DELETE', `/api/equipes/${c.team}`).then(ditGardes, (e) => setAvis({ texte: `Équipe pas arrêtée : ${e.message}` }))
        // Fermer une console seule qui tourne la RANGE dans l'historique (16/11, Orkun : « je viens de fermer une console et
        // je ne la vois pas dans historique ») : elle quitte le plateau et « Tout » tout de suite, et arrive dans
        // « Historique » ; un refus la remet comme avant. Une console déjà fermée (historique) ou d'équipe est retirée.
        if (c && c.status !== 'closed' && !c.team) {
          const avant = { status: c.status, since: c.since }
          patchLocal(id, { status: 'closed', since: Date.now() })
          return api('POST', `/api/consoles/${id}/fermer`).catch((e) => {
            if (/console inconnue/.test(e.message)) return
            patchLocal(id, avant)
            setAvis({ texte: `Pas fermée : ${e.message}` })
          })
        }
        patchLocal(id, { partante: true })
        return api('DELETE', `/api/consoles/${id}`).then(ditGardes, (e) => {
          if (/console inconnue/.test(e.message)) return // déjà partie (second clic, autre appareil)
          patchLocal(id, { partante: false })
          setAvis({ texte: `Pas fermée : ${e.message}` })
        })
      },
      // Console terminée : la rouvrir dans son dossier, l'agent sur sa conversation.
      revive(id) {
        api('POST', `/api/consoles/${id}/relance`).catch(() => {})
      },
      // Arrêter ce qu'une console est en train de faire (Échap pour un agent, Ctrl C dans un shell). L'erreur revient à l'appelant.
      interrompre: (id) => api('POST', `/api/consoles/${id}/interrompre`),
      // Boucle : un message renvoyé à l'agent jusqu'à une fin. `ouvreBoucle` montre son panneau pour une console.
      boucle: (id, def) => api('POST', `/api/consoles/${id}/boucle`, def),
      arreteBoucle: (id) => api('DELETE', `/api/consoles/${id}/boucle`),
      ouvreBoucle: setBoucleDe,
      // Relais : la conversation de cette console passe à un nouvel agent (`vers` = 'claude', 'codex'…), ou sa dernière
      // réponse à une console qui existe (`vers` = son identifiant). Rend la console de destination.
      // `compte` (volet « comptes ») : la nouvelle console part sur ce compte ('1' | '2') ; absent = compte 1.
      relais: (id, vers, compte) => api('POST', `/api/consoles/${id}/relais`, { vers, ...(compte ? { compte } : {}) }),
      // Équipe : livrer dans le projet ce que le capitaine a déclaré prêt ; arrêter l'équipe. L'erreur revient à l'appelant.
      livrer: (id, head) => api('POST', `/api/equipes/${id}/livrer`, { head }),
      arreter: (id) => api('DELETE', `/api/equipes/${id}`).then(ditGardes),
      // Barre de commande : un ordre tapé ou dicté pour toutes les consoles (Ordre.jsx). `texte` (dictée maintenue,
      // parler.jsx) : la barre s'ouvre avec lui, plan montré, rien d'exécuté. Appelée aussi par un clic (l'événement).
      ouvreOrdre: (texte, source) => setOrdre((o) => (typeof texte === 'string' ? { texte, source: source === 'voix' ? 'voix' : 'tape', n: (o?.n ?? 0) + 1 } : o || { n: 0 })),
      // Mémoire de projet : ouvrir le panneau (sur `projet`, sinon sur le premier qui a des propositions) ; le projet dont
      // une console reçoit la mémoire (celui de son équipe, sinon de son dossier ; `null` : pas de mémoire possible).
      ouvreMemoire: (projet) => setMemoireDe({ projet: typeof projet === 'string' ? projet : null }),
      projetMemoire: (c) => projetMemoire(c, teamsRef.current),
      // Ordinateur : agrandir une console (`null` : la réduire). Elle prend aussi le clavier.
      agrandit(id) {
        setPlein(id)
        if (id) activer(id)
      },
      // Ordinateur : discussion ou terminal pour une console. `provisoire` : pas retenu (« Répondre dans le terminal »).
      vue(id, v, provisoire = false) {
        if (!provisoire) {
          retenues.current = { ...retenues.current, [id]: v }
          try {
            localStorage.setItem(VUES_KEY, JSON.stringify(retenues.current))
          } catch {} // navigation privée : le choix vaut pour cette visite
        }
        setVues((m) => ({ ...m, [id]: v }))
      },
      // Ordinateur : toutes les consoles en mosaïque à la taille de l'écran (la console agrandie revient au plateau).
      // Rend { avant, vue } pour annuler, { rien: true } quand tout était déjà en place, ou null.
      ranger() {
        setPlein(null)
        return rangerRef.current?.ranger() ?? null
      },
      annuleRange: (r) => r?.avant && rangerRef.current?.defait(r.avant, r.vue),
    }),
    [patchLocal, activer],
  )

  const fermeeRef = useRef(new Set()) // les consoles fermées du moment (lues par `pick`, sans le refaire à chaque état)
  fermeeRef.current = new Set(consoles.filter((c) => c.status === 'closed').map((c) => c.id))
  const pick = useCallback(
    (id) => {
      if (mobile) return ouvrir(id)
      vu(id)
      if (deux) return setOpenId(id)
      setActiveId(id)
      // Une console agrandie : la colonne sert de « switch », la console choisie prend la place. Une console fermée (onglet
      // « Historique ») n'est plus sur le plateau : elle s'ouvre agrandie, sur « Session terminée » et son « Relancer ».
      if (plein || fermeeRef.current.has(id)) return setPlein(id)
      cadrer({ nodes: [{ id }], padding: 0.12, maxZoom: 1.2, duration: 320 })
    },
    [mobile, deux, ouvrir, plein, vu, cadrer],
  )
  pickRef.current = pick

  // Ordinateur : raccourcis pour passer d'une console à l'autre sans la souris, pris AVANT le terminal (Alt seul : Ctrl+Alt
  // est AltGr sur le clavier belge, qui tape @ # { }). Alt+1…9 = la n-ième console de la liste ; Alt+↑ / Alt+↓ = la
  // précédente / la suivante ; Alt+0 = celle qui t'attend depuis le plus longtemps. Une console agrandie reste agrandie.
  const courante = plein ?? activeId
  useEffect(() => {
    if (mobile || deux) return
    const touche = (e) => {
      // L'écran de réglage des touches attend une touche (Raccourcis.jsx) : elle est pour lui, pas pour changer de console.
      // Sur Mac, Option compose les caractères (clavier belge : Option+( = {) : dans un champ ou le terminal, elle va à la
      // saisie (option-mac.js ; chasse du 17/11 : « { » ne s'écrivait plus nulle part).
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || toucheEnSaisie() || optionEcrit(e)) return
      const ids = ordreRef.current
      let cible = null
      if (/^Digit[1-9]$/.test(e.code)) cible = ids[Number(e.code.slice(5)) - 1]
      else if (e.code === 'Digit0') cible = waiting[0]?.id
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = ids.indexOf(courante)
        cible = i < 0 ? ids[0] : ids[(i + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length]
      } else return
      e.preventDefault()
      e.stopPropagation()
      if (cible) pickRef.current?.(cible)
    }
    window.addEventListener('keydown', touche, true)
    return () => window.removeEventListener('keydown', touche, true)
  }, [mobile, deux, waiting, courante])

  // Touches seules (volet « raccourcis », raccourcis.js) : ordinateur seulement, hors terminal et hors champ.
  // N : la console suivante qui t'attend (après la courante, la plus ancienne d'abord), cadrée et au clavier.
  // Pour presser N de nouveau, on sort du terminal en cliquant sur le fond du plateau, ce qui ne laisse aucune console
  // choisie : la suivante se compte alors depuis la dernière où N a mené (sinon N ramènerait toujours à la première).
  // M : la mémoire du projet de la console courante (refermée si elle est ouverte).
  useRaccourcis(!mobile && !deux)
  const dernierN = useRef(null)
  useBranche('attente', () => {
    if (!waiting.length) return false
    const depuis = waiting.some((c) => c.id === courante) ? courante : dernierN.current
    const i = waiting.findIndex((c) => c.id === depuis)
    dernierN.current = waiting[(i + 1) % waiting.length].id
    pick(dernierN.current)
  })
  useBranche('memoire', () => {
    if (memoireDe) return setMemoireDe(null)
    const c = consoles.find((x) => x.id === courante)
    actions.ouvreMemoire(c ? actions.projetMemoire(c) : null)
  })

  const onCreated = useCallback(
    (made) => {
      if (mobile || !made.length) return
      setActiveId(made[0].id)
      if (plein) return setPlein(made[0].id) // la nouvelle console prend la place de l'agrandie
      // Laisser le temps au nœud d'arriver par le flux d'état avant de cadrer dessus.
      setTimeout(() => cadrer({ nodes: made.map((c) => ({ id: c.id })), padding: 0.12, maxZoom: 1, duration: 320 }), 250)
    },
    [mobile, plein, cadrer],
  )
  // La console agrandie est partie (fermée ici, par un ordre ou ailleurs) : retour au plateau.
  const enGrand = plein && !mobile && !deux ? consoles.find((c) => c.id === plein) : null
  useEffect(() => {
    if (plein && consoles.length && !consoles.some((c) => c.id === plein)) setPlein(null)
  }, [plein, consoles])

  // Deux volets : la console choisie, sinon celle qui attend depuis le plus longtemps, sinon la première.
  const open = mobile ? consoles.find((c) => c.id === openId) : deux ? consoles.find((c) => c.id === openId) || waiting[0] || consoles[0] : null

  return (
    <div className={mobile ? 'app is-mobile' : deux ? 'app is-mobile is-deux' : 'app'}>
      {!open && mobile && couche && accueil !== 'liste' ? (
        <Ensemble consoles={consoles} teams={teams} waiting={waiting} online={online} onPick={pick} onCreated={onCreated} mode={accueil === 'plateau' ? 'plateau' : look.paysage} bascule={bascule} actions={actions} look={look} />
      ) : (
        (!open || deux) && (
          <Rail consoles={consoles} teams={teams} actions={actions} online={online} activeId={deux ? open?.id : activeId} onPick={pick} onCreated={onCreated} look={look} setLook={setLook} mobile={mobile || deux} waiting={waiting} bascule={mobile ? bascule : null} ordreRef={mobile || deux ? null : ordreRef} musique={<><Veille consoles={consoles} /><MiniMusique /></>} memoire={memoire} />
        )
      )}
      {!mobile && !deux && (
        <main className="mat">
          {/* Le plateau arrive à part (differe.js) : en l'attendant, le fond du plateau, vide. */}
          <Plateau consoles={vivantes} activeId={activeId} setActiveId={activer} actions={actions} look={look} plein={enGrand?.id ?? null} vues={vues} rangerRef={rangerRef} cadreRef={cadreRef} enGrand={enGrand} />
        </main>
      )}
      {avis && (
        <p className="avis-app" role="status">
          {avis.texte}
        </p>
      )}
      {nouvelle && (
        <p className="avis-app est-version" role="status">
          Meydan a été mis à jour.
          <button type="button" onClick={() => location.reload()}>
            Recharger
          </button>
        </p>
      )}
      {/* Le lecteur de musique : monté une seule fois, jamais démonté en changeant d'écran (la musique continue). */}
      <Musique />
      {/* Réponses parlées (Voix.jsx) : lecture quand une console passe FINI, et l'arrêt d'un toucher. */}
      <Voix consoles={consoles} />
      {ordre && <Ordre key={ordre.n} onClose={() => setOrdre(null)} onPick={pick} consoles={consoles} teams={teams} initial={ordre.texte} source={ordre.source} />}
      {/* Ordinateur : maintenir Espace pour dicter un ordre (parler.jsx). */}
      {!mobile && !deux && <Parler onTexte={(t) => actions.ouvreOrdre(t, 'voix')} />}
      {/* L'aide des touches (`?`) et leur réglage (volet « raccourcis ») : ordinateur seulement. */}
      {!mobile && !deux && <AideRaccourcis />}
      {!mobile && !deux && <Mission consoles={consoles} teams={teams} onPick={pick} actions={actions} />}
      {memoireDe && <Memoire key={memoireDe.projet ?? ''} projet={memoireDe.projet} resume={memoire} onClose={() => setMemoireDe(null)} />}
      {consoles.some((c) => c.id === boucleDe) && <PanneauBoucle console={consoles.find((c) => c.id === boucleDe)} consoles={consoles} actions={actions} onClose={() => setBoucleDe(null)} />}
      {/* Téléphone : le titre de la console ouverte déroule toutes les consoles (`autres`) ; deux volets : la liste est à côté. */}
      {/* `key` : chaque console repart d'un état neuf (chasse du 17/11 : en changeant de console par le titre, la carte jaune
          et la discussion de la précédente restaient sous le nom de la nouvelle, et un toucher répondait à la mauvaise). */}
      {open && <MobileConsole key={open.id} console={open} online={online} actions={actions} onBack={deux ? null : fermer} look={look} waiting={waiting} onOpen={deux ? setOpenId : ouvrir} onRevive={actions.revive} autres={deux ? null : vivantes} />}
    </div>
  )
}
