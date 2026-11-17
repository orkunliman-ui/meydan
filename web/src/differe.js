import { createElement, useEffect, useState } from 'react'
import { journal } from './journal.jsx'

// Ce qui ne se charge qu'à son premier affichage. Audit du 11/11 : l'iPhone en portrait chargeait tout le JavaScript
// (React Flow, xterm, le plateau : 855 Ko) pour n'afficher que la liste. Le plateau (Plateau.jsx : React Flow, la console
// agrandie, les liens) arrive quand il s'affiche, sur l'ordinateur ou le téléphone couché en mode Plateau ; le terminal
// (xterm) quand un terminal s'affiche, jamais pour le plateau du téléphone (aucun terminal monté) ; sur l'ordinateur, il
// part en même temps que le plateau (App.jsx) et une console ouverte sur le téléphone le précharge (MobileConsole.jsx).
//
// Un morceau introuvable veut dire, le plus souvent, que l'interface a été remise en ligne depuis l'ouverture de la page :
// chaque construction efface les anciens fichiers de `dist/assets`, et l'iPhone garde Meydan ouvert des heures. Quand la
// page d'accueil du serveur ne charge plus le même point d'entrée que cette page, une nouvelle interface est en ligne : on
// la prend en rechargeant, sur la console ouverte (`?ouvre=`). Sinon (liaison coupée, fichier perdu) on ne recharge pas :
// l'erreur va à l'écran d'erreur, qui propose de recharger. Après un rechargement, le point d'entrée est le bon : jamais
// de rechargement en boucle.
export const charge = (importe) =>
  importe().catch(async (err) => {
    const entree = document.querySelector('script[type="module"][src]')?.getAttribute('src')
    const accueil = await fetch('/', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : '')) // serveur en redémarrage (502…) : rien de neuf à prendre
      .catch(() => '')
    if (!entree || !accueil || accueil.includes(entree)) throw err
    journal('morceau', err?.message, 'nouvelle interface en ligne : page rechargée')
    const u = new URL(location.href)
    if (history.state?.console) u.searchParams.set('ouvre', history.state.console)
    location.replace(u)
    return new Promise(() => {}) // la page s'en va : rien à montrer d'ici là
  })

// Un composant chargé à la demande : rien à sa place tant que son code n'est pas arrivé (le parent garde la sienne : le
// fond du plateau, la zone du terminal), puis il s'affiche aussitôt ; arrivé une fois, il s'affiche d'emblée. Pas de
// React.lazy ni de Suspense : React retient un contenu suspendu au moins 300 ms après l'affichage de son repli (mesuré au
// banc : +0,3 s au plateau de l'ordinateur et au terminal, même déjà préchargé). Rend [le composant, son préchargement].
function aLaDemande(importe) {
  let pret = null // le composant, une fois son code arrivé
  let vient = null // la demande en cours ou réussie ; oubliée si elle échoue (la suivante redemande)
  const essaie = () =>
    (vient ??= importe().then(
      (C) => (pret = C),
      (e) => {
        vient = null
        throw e
      },
    ))
  function Differe(props) {
    const [, setArrive] = useState(false)
    const [erreur, setErreur] = useState(null)
    useEffect(() => {
      if (pret) return
      let vivant = true
      charge(essaie).then(
        () => vivant && setArrive(true),
        (e) => vivant && setErreur(e),
      )
      return () => {
        vivant = false
      }
    }, [])
    if (erreur) throw erreur // à l'écran d'erreur (journal.jsx)
    return pret ? createElement(pret, props) : null
  }
  // Le préchargement ne recharge jamais la page : son échec est sans suite, l'affichage refera la demande.
  return [Differe, () => essaie().catch(() => {})]
}

export const [Plateau] = aLaDemande(() => import('./Plateau.jsx').then((m) => m.default))
// Ateliers (volet du 13/11) : le corps de la lecture en grand (rendu Markdown, coloration, diagrammes), appelé depuis la
// liste du téléphone et le Chat, qui sont dans le morceau principal.
export const [CorpsLecture] = aLaDemande(() => import('./ateliers/lecture.jsx').then((m) => m.CorpsLecture))
// Carte de mission (touche X, ordinateur ; décision d'Orkun du 17/11, raccourcis-4) : les cartes, à la première ouverture.
export const [CorpsMission, prechargeMission] = aLaDemande(() => import('./MissionCorps.jsx').then((m) => m.CorpsMission))
// Le terminal est à un toucher de la discussion : MobileConsole précharge son code à l'ouverture d'une console, puis les
// deux graisses de l'Iosevka complète que ce code déclare (≈ 2 Mo, une fois par appareil, ensuite en cache). Sans elles,
// le premier terminal attendait la police (Term.jsx, `document.fonts.load`) : jusqu'à 2 s de plus en 4G. Orkun le 13/11 :
// « V3 oui ». Même appel que Term.jsx, donc mêmes fichiers ; un échec reste sans suite (le terminal refera la demande).
const [Term, chargeTerm] = aLaDemande(() => import('./Term.jsx').then((m) => m.Term))
export { Term }
export const prechargeTerm = () => chargeTerm().then((C) => C && Promise.all(['400', '700'].map((g) => document.fonts?.load(`${g} 16px Iosevka`))).catch(() => {}))
