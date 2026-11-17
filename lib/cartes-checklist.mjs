// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — Checklist :
// « carte de tâches (ajouter, cocher, réordonner, supprimer), compteur « 3/7 » ».
// Données de la carte : { taches: [{ id, t, fait }] } — l'ordre de la liste est l'ordre affiché. L'interface
// (web/src/ChecklistNode.jsx) envoie la liste entière à chaque changement (PATCH /api/cartes/<id> { taches }) ; ce module
// la valide en entier : une demande refusée lève `refus` et lib/cartes.mjs, qui applique sur une copie, ne change rien.
// Bornes : la carte ENTIÈRE tient en 60 Ko dans le pire cas UTF-8 (3 octets par unité de chaîne JS, identifiants de 16,
// titre de 80, coordonnées extrêmes) : 150 tâches de 110 caractères = 56 788 octets (mesuré par checklist-api.mjs), sous
// les 64 Ko du corps d'une demande (readJson de server.mjs, nginx `client_max_body_size 64k`).
// Contrat (lib/cartes.mjs, registre CREATIFS) : `typesChecklist(ctx)` rend { checklist: { taille, defaut, applique } }.

export const TACHES_MAX = 150 // = web/src/ChecklistNode.jsx
export const TACHE_MAX = 110 // caractères par tâche, après nettoyage ; = web/src/ChecklistNode.jsx
// Identifiant d'une tâche : forme fermée, créé par l'interface (12 caractères hexadécimaux).
const ID = /^[a-z0-9]{1,16}$/

// Une ligne de texte : caractères de contrôle remplacés par une espace (comme `titreDe` de lib/cartes.mjs), moitiés de
// paire UTF-16 orphelines retirées (JSON.stringify les écrirait en « \udXXX », 6 octets pour une unité), blancs resserrés.
export const ligneDe = (v) =>
  String(v)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cs}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

export function typesChecklist(ctx) {
  const { refus } = ctx
  return {
    checklist: {
      taille: { w: 360, h: 420, min: { w: 240, h: 180 } },
      defaut: () => ({ taches: [] }),
      applique(k, corps) {
        if (corps.taches === undefined) return
        if (!Array.isArray(corps.taches)) throw refus('taches : une liste attendue')
        if (corps.taches.length > TACHES_MAX) throw refus(`${TACHES_MAX} tâches au plus`, 413)
        const vus = new Set()
        // Seuls id, t et fait sont gardés : les autres champs d'une tâche sont ignorés.
        k.taches = corps.taches.map((x, i) => {
          const n = `tâche ${i + 1}`
          if (!x || typeof x !== 'object' || Array.isArray(x)) throw refus(`${n} : un objet { id, t, fait } attendu`)
          if (typeof x.id !== 'string' || !ID.test(x.id)) throw refus(`${n} : identifiant mal formé (1 à 16 caractères a-z 0-9)`)
          if (vus.has(x.id)) throw refus(`${n} : identifiant en double`)
          vus.add(x.id)
          if (typeof x.t !== 'string') throw refus(`${n} : texte attendu`)
          const t = ligneDe(x.t)
          if (!t) throw refus(`${n} : texte vide`)
          if (t.length > TACHE_MAX) throw refus(`${n} trop longue : ${TACHE_MAX} caractères au plus`, 413)
          if (x.fait !== undefined && typeof x.fait !== 'boolean') throw refus(`${n} : « fait » vaut true ou false`)
          return { id: x.id, t, fait: x.fait === true }
        })
      },
    },
  }
}
