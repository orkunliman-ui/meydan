// Les types de cartes du plateau, côté interface : nom affiché, taille d'une carte neuve et taille minimale (= lib/cartes.mjs
// et ses modules de type), et la façon de les poser. Un seul endroit pour Carte.jsx (cadre), Cartes.jsx (registre, barre
// « Ajouter ») et cartes.js (nœuds du plateau).
//   sansCadre : la dalle n'a pas la barre-poignée du cadre commun (une forme se déplace par toute sa surface) ;
//   sansBoite : pas une dalle du plateau (une flèche est dessinée entre ses deux bouts, Fleches.jsx).
export const TYPES_CARTES = {
  note: { nom: 'Note', w: 420, h: 340, min: { w: 220, h: 140 } },
  web: { nom: 'Web', w: 820, h: 560, min: { w: 320, h: 220 } },
  git: { nom: 'Git', w: 660, h: 640, min: { w: 420, h: 320 } },
  // Plateau créatif (volet du 13/11).
  checklist: { nom: 'Checklist', w: 360, h: 420, min: { w: 240, h: 180 } },
  kanban: { nom: 'Kanban', w: 820, h: 520, min: { w: 420, h: 260 } },
  calendrier: { nom: 'Calendrier', w: 560, h: 520, min: { w: 360, h: 340 } },
  forme: { nom: 'Forme', w: 240, h: 160, min: { w: 40, h: 24 }, sansCadre: true },
  fleche: { nom: 'Flèche', sansBoite: true },
  image: { nom: 'Image', w: 520, h: 400, min: { w: 160, h: 120 } },
  fichier: { nom: 'Fichier', w: 420, h: 320, min: { w: 260, h: 160 } },
  // Ateliers (volet du 13/11) : mêmes valeurs que lib/ateliers.mjs (TAILLES) et web/src/ateliers/types.js. `coffre`
  // s'appelle « Markdown » à l'écran.
  doc: { nom: 'Document', w: 640, h: 760, min: { w: 320, h: 240 } },
  code: { nom: 'Code', w: 860, h: 640, min: { w: 420, h: 300 } },
  coffre: { nom: 'Markdown', w: 860, h: 640, min: { w: 420, h: 300 } },
  diagramme: { nom: 'Diagramme', w: 640, h: 480, min: { w: 280, h: 200 } },
  // Volet copies (13/11) : ce que voit le navigateur de l'agent d'une console (NavNode.jsx). Posée par le serveur au premier
  // `meydan nav ouvre` (lib/cartes-nav.mjs, `serveurSeul`) : jamais dans le menu « Ajouter ».
  nav: { nom: 'Nav', w: 820, h: 560, min: { w: 320, h: 220 }, serveurSeul: true },
}

// Couleurs des formes, des flèches et de l'encre (= COULEURS de lib/cartes.mjs) : celles du thème, SANS le jaune (règle du
// design : le jaune est réservé à ce qui attend Orkun). Chaque nom a sa classe `cr-coul-<nom>`, qui pose `--cr-c` (cartes.css).
export const COULEURS = ['papier', 'gris', 'bleu', 'turquoise', 'vert', 'rouge']
export const NOM_COULEUR = { papier: 'Papier', gris: 'Gris', bleu: 'Bleu', turquoise: 'Turquoise', vert: 'Vert', rouge: 'Rouge' }
