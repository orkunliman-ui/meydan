// Annuler / rétablir la disposition du plateau, sur l'ordinateur. Orkun, 11/11 : « Annuler / rétablir sur plusieurs pas
// la disposition (déplacements, tailles, Ranger) : Ctrl+Z / Ctrl+Maj+Z hors terminal, et boutons ; une fermeture n'est
// pas annulable (dis-le). »
// Calcul pur, sans React ni navigateur : Board.jsx note les gestes et applique les places rendues.
//
// Une entrée : { libelle, avant: { id: { x, y, w, h } }, apres: { … }, vue? }. `vue` (la vue du plateau avant le geste)
// n'existe que pour ce qui recadre le plateau (Ranger, retour à un espace de travail) ; Board y ajoute `vueApres` au
// moment d'annuler, pour la remettre en rétablissant.
// Ce qui n'entre jamais ici : la fermeture d'une console (la console et ce qui tournait dedans sont arrêtés pour de bon),
// le renommage, la taille du texte.

export const BORNE = 50 // pas gardés ; au-delà, le plus ancien est oublié

const CLES = ['x', 'y', 'w', 'h']
const meme = (a, b) => CLES.every((k) => a[k] === b[k])

// L'entrée d'un geste, réduite aux consoles qui ont vraiment bougé ; null quand rien n'a bougé (un clic sur une barre,
// « Ranger » sur un plateau déjà rangé) : une entrée vide ne s'enregistre pas.
export function entree(libelle, avant, apres, vue) {
  const ids = Object.keys(apres).filter((id) => avant[id] && apres[id] && !meme(avant[id], apres[id]))
  if (!ids.length) return null
  const copie = (p) => Object.fromEntries(ids.map((id) => [id, Object.fromEntries(CLES.map((k) => [k, p[id][k]]))]))
  return { libelle, avant: copie(avant), apres: copie(apres), ...(vue ? { vue } : {}) }
}

// La pile : `faits` (ce qu'on peut annuler, le plus récent à la fin) et `defaits` (ce qu'on peut rétablir).
// `ecoute(f)` + `version()` : de quoi brancher useSyncExternalStore (les boutons ↶ ↷ se redessinent à chaque changement).
export function historique(borne = BORNE) {
  let faits = []
  let defaits = []
  let version = 0
  const ecoutes = new Set()
  const change = () => {
    version++
    for (const f of ecoutes) f()
  }
  return {
    // Un nouveau geste vide la pile « rétablir » (on ne rétablit pas par-dessus une autre disposition).
    note(e) {
      if (!e) return null
      faits = [...faits, e].slice(-borne)
      defaits = []
      change()
      return e
    },
    annule() {
      const e = faits.at(-1)
      if (!e) return null
      faits = faits.slice(0, -1)
      defaits = [...defaits, e]
      change()
      return e
    },
    retablit() {
      const e = defaits.at(-1)
      if (!e) return null
      defaits = defaits.slice(0, -1)
      faits = [...faits, e]
      change()
      return e
    },
    // Une console fermée depuis sort de chaque entrée ; une entrée qui n'a plus aucune console est oubliée (annuler la
    // saute). `ids` : les consoles qui existent encore.
    elague(ids) {
      let touche = false
      const garde = (liste) =>
        liste.flatMap((e) => {
          const reste = Object.keys(e.avant).filter((id) => ids.has(id))
          if (reste.length === Object.keys(e.avant).length) return [e]
          touche = true
          if (!reste.length) return []
          // Sur place : le bouton « Annuler » de la colonne reconnaît l'entrée « Ranger » à son objet `avant`.
          for (const id of Object.keys(e.avant)) {
            if (ids.has(id)) continue
            delete e.avant[id]
            delete e.apres[id]
          }
          return [e]
        })
      faits = garde(faits)
      defaits = garde(defaits)
      if (touche) change()
    },
    // L'entrée encore annulable qui répond à `quoi(e)`, ou null (déjà annulée, ou oubliée).
    trouve: (quoi) => faits.find(quoi) ?? null,
    etat: () => ({ annuler: faits.at(-1)?.libelle ?? null, retablir: defaits.at(-1)?.libelle ?? null, faits: faits.length, defaits: defaits.length }),
    ecoute(f) {
      ecoutes.add(f)
      return () => ecoutes.delete(f)
    },
    version: () => version,
  }
}
