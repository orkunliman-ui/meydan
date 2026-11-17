// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — Kanban :
// « colonnes nommées (À faire / En cours / Fait par défaut, renommables, réordonnables), cartes glissées d'une colonne à
// l'autre (souris et doigt), « Déplacer au début / à la fin ». »
// Contrat (lib/cartes.mjs, registre CREATIFS) : `typesKanban(ctx)` rend { kanban: { taille, defaut, applique } }.
//
// Données : `colonnes: [{ id, nom, fiches: [{ id, t }] }]`. Chaque changement de l'interface envoie les colonnes ENTIÈRES
// (un PATCH) ; le serveur reconstruit la liste de zéro (champs inconnus écartés), la valide entière, ou refuse tout
// (lib/cartes.mjs applique sur une copie profonde : une demande refusée ne change rien).
//
// Bornes : la carte ENTIÈRE tient en 60 Ko dans le pire cas (3 octets par unité de chaîne JS : un caractère de contrôle ou
// une moitié de paire isolée s'écriraient en `\uXXXX`, 6 octets — `net` les retire). Le corps d'une demande est coupé
// à 64 Ko (readJson et nginx). 150 fiches de 200 caractères feraient 90 Ko de texte : d'où, EN PLUS des bornes par
// fiche, une borne sur le texte de toutes les fiches.
//   champs de la carte (titre 80 × 3 octets, x/y/w/h, dates…)        ≈    400 octets
//   12 colonnes  × ({"id":"<16>","nom":"<40 × 3>","fiches":[]} + « , ») = 12 × 167 =  2 004
//   150 fiches   × ({"id":"<16>","t":""} + « , »)                     = 150 × 33 =  4 950
//   16 000 caractères de fiches × 3 octets                                          = 48 000
//   total                                                                           ≈ 55 400 octets (< 60 000, essayé)
export const KANBAN = { colonnes: 12, fiches: 150, nom: 40, fiche: 200, texte: 16000 }
// Identifiant d'une colonne ou d'une fiche : forme fermée, unique dans la carte (colonnes et fiches ensemble).
const ID = /^[a-z0-9]{1,16}$/
const REMPLACE = String.fromCharCode(0xfffd)
// Un texte d'une ligne : moitiés de paire isolées → « � », caractères de contrôle → espace (comme `titreDe` de
// lib/cartes.mjs), blancs resserrés, bouts retirés. Jamais coupé ici : trop long = refus.
export const net = (v) =>
  String(v)
    .replace(/\p{Cs}/gu, REMPLACE)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// Une carte neuve : les trois colonnes d'Orkun, vides.
const PAR_DEFAUT = [
  ['afaire', 'À faire'],
  ['encours', 'En cours'],
  ['fait', 'Fait'],
]

export function typesKanban(ctx) {
  const { refus } = ctx
  const objet = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

  function valide(liste) {
    if (!Array.isArray(liste)) throw refus('colonnes : une liste attendue')
    if (liste.length > KANBAN.colonnes) throw refus(`${KANBAN.colonnes} colonnes au plus`, 413)
    const vus = new Set()
    const identifiant = (v, quoi) => {
      if (typeof v !== 'string' || !ID.test(v)) throw refus(`${quoi} : identifiant invalide (1 à 16 lettres minuscules ou chiffres)`)
      if (vus.has(v)) throw refus(`${quoi} : identifiant déjà pris dans la carte (${v})`)
      vus.add(v)
      return v
    }
    let nFiches = 0
    let nTexte = 0
    const colonnes = liste.map((c) => {
      if (!objet(c)) throw refus('colonne : un objet attendu')
      const id = identifiant(c.id, 'colonne')
      if (typeof c.nom !== 'string') throw refus('colonne : un nom attendu')
      const nom = net(c.nom)
      if (!nom) throw refus('colonne : nom vide')
      if (nom.length > KANBAN.nom) throw refus(`nom de colonne trop long : ${KANBAN.nom} caractères au plus`, 413)
      if (!Array.isArray(c.fiches)) throw refus('colonne : une liste de fiches attendue')
      nFiches += c.fiches.length
      if (nFiches > KANBAN.fiches) throw refus(`${KANBAN.fiches} fiches au plus dans un kanban`, 413)
      const fiches = c.fiches.map((f) => {
        if (!objet(f)) throw refus('fiche : un objet attendu')
        const fid = identifiant(f.id, 'fiche')
        if (typeof f.t !== 'string') throw refus('fiche : un texte attendu')
        const t = net(f.t)
        if (!t) throw refus('fiche : texte vide')
        if (t.length > KANBAN.fiche) throw refus(`fiche trop longue : ${KANBAN.fiche} caractères au plus`, 413)
        nTexte += t.length
        return { id: fid, t }
      })
      return { id, nom, fiches }
    })
    if (nTexte > KANBAN.texte) throw refus(`kanban plein : ${KANBAN.texte} caractères au plus pour toutes les fiches`, 413)
    return colonnes
  }

  return {
    kanban: {
      taille: { w: 820, h: 520, min: { w: 420, h: 260 } },
      defaut: () => ({ colonnes: PAR_DEFAUT.map(([id, nom]) => ({ id, nom, fiches: [] })) }),
      // Un déplacement, une taille ou un titre passent aussi par ici : sans `colonnes`, rien ne change.
      applique(k, corps) {
        if (corps.colonnes !== undefined) k.colonnes = valide(corps.colonnes)
      },
    },
  }
}
