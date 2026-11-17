// Plateau créatif (volet du 13/11) — Formes et texte, flèches. Demande d'Orkun (brief du volet) : « Formes et texte :
// rectangle, ellipse, flèche (qui peut relier deux éléments du plateau), texte libre ; couleur dans la palette du thème
// (jaune = seulement ce qui attend Orkun, règle du design : pas de jaune décoratif). »
//   forme  : { forme: 'rect' | 'ellipse' | 'texte', couleur, texte, plein, tailleTexte } + la boîte commune (x, y, w, h) ;
//   fleche : { de, vers, couleur }, sans boîte (`taille: null`) : chaque bout est un point du plan { x, y } ou un élément
//            du plateau { id, x, y } (console « c… » ou carte « k… »), x et y = sa dernière position connue (l'interface
//            dessine le bout sur l'élément tant qu'il est là, et à cette position quand il a disparu).
// Tout est validé ici ; un refus lève `refus` et lib/cartes.mjs, qui applique sur une copie, ne garde rien de la demande.
// Pire cas d'une carte : 2 000 unités de texte × 3 octets = 6 Ko, loin des 60 Ko d'un corps de demande.

export const FORMES = ['rect', 'ellipse', 'texte']
// Tailles du texte d'une forme, en points du plan (A− / A+ de la barre de la forme passent de l'une à la suivante).
export const TAILLES_TEXTE = [12, 14, 18, 24, 32, 48, 64, 96]
export const TEXTE_FORME_MAX = 2000
const BORNE = 50000 // = bornes de x et y des cartes (lib/cartes.mjs)
const ELEMENT = /^[ck][0-9a-f]{8}$/ // une console (server.mjs, newId) ou une carte (lib/cartes.mjs)

export function typesFormes({ refus, COULEURS }) {
  const couleurDe = (v) => {
    if (!COULEURS.includes(v)) throw refus(`couleur : une de ${COULEURS.join(', ')}`)
    return v
  }
  // Un texte sur plusieurs lignes : les retours à la ligne restent, la tabulation devient une espace, les autres
  // caractères de contrôle (C0, DEL, C1) sont retirés. Jamais injecté comme HTML (l'interface le rend en texte).
  const texteDe = (v) => {
    if (typeof v !== 'string') throw refus('texte : une chaîne attendue')
    if (v.length > TEXTE_FORME_MAX) throw refus(`texte trop long : ${TEXTE_FORME_MAX} caractères au plus`, 413)
    return v
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  }
  // Un bout de flèche, reconstruit champ par champ (ce qui n'est pas attendu ne passe pas).
  const boutDe = (v, nom) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw refus(`${nom} : un point { x, y } ou un élément { id, x, y }`)
    const b = {}
    if (v.id !== undefined && v.id !== null) {
      if (typeof v.id !== 'string' || !ELEMENT.test(v.id)) throw refus(`${nom}.id : l'identifiant d'une console ou d'une carte`)
      b.id = v.id
    }
    for (const c of ['x', 'y']) {
      const n = v[c]
      if (typeof n !== 'number' || !Number.isFinite(n)) throw refus(`${nom}.${c} : un nombre attendu`)
      if (Math.abs(n) > BORNE) throw refus(`${nom}.${c} : entre -${BORNE} et ${BORNE}`)
      b[c] = Math.round(n)
    }
    return b
  }
  return {
    forme: {
      taille: { w: 240, h: 160, min: { w: 40, h: 24 } },
      defaut: () => ({ forme: 'rect', couleur: 'papier', texte: '', plein: false, tailleTexte: 18 }),
      applique(k, corps, creation) {
        if (corps.forme !== undefined) {
          if (!FORMES.includes(corps.forme)) throw refus(`forme : une de ${FORMES.join(', ')}`)
          k.forme = corps.forme
        }
        // Un texte libre neuf s'écrit plus grand que l'étiquette d'une forme.
        if (creation && corps.tailleTexte === undefined && k.forme === 'texte') k.tailleTexte = 24
        if (corps.couleur !== undefined) k.couleur = couleurDe(corps.couleur)
        if (corps.texte !== undefined) k.texte = texteDe(corps.texte)
        if (corps.plein !== undefined) {
          if (typeof corps.plein !== 'boolean') throw refus('plein : vrai ou faux')
          k.plein = corps.plein
        }
        if (corps.tailleTexte !== undefined) {
          if (!TAILLES_TEXTE.includes(corps.tailleTexte)) throw refus(`tailleTexte : une de ${TAILLES_TEXTE.join(', ')}`)
          k.tailleTexte = corps.tailleTexte
        }
      },
    },
    fleche: {
      taille: null,
      defaut: () => ({ de: { x: 0, y: 0 }, vers: { x: 100, y: 0 }, couleur: 'papier' }),
      applique(k, corps) {
        if (corps.de !== undefined) k.de = boutDe(corps.de, 'de')
        if (corps.vers !== undefined) k.vers = boutDe(corps.vers, 'vers')
        if (corps.couleur !== undefined) k.couleur = couleurDe(corps.couleur)
        if (k.de?.id && k.de.id === k.vers?.id) throw refus('une flèche relie deux éléments différents')
      },
    },
  }
}
