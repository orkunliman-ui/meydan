// Lancer en nombre et préréglages de groupe (volet « raccourcis », lot C, 13/11). Orkun, 13/11 : « On est encore loin de
// toutes les fonctionnalitēs de Symvibe », puis « Go » ; dans l'écart relevé, le lancement de 12 agents d'un coup et de
// groupes préréglés. Ici le calcul seul (sans React ni navigateur) ; l'écran est dans Groupes.jsx.
//
// Un préréglage : { id, nom, lignes: [{ kind, nombre, modele, role, consigne }] }, retenu sur l'appareil
// (localStorage['meydan.groupes']) : aucune route de serveur ; sans stockage, la page marche et le groupe ne vaut que
// pour la page ouverte. Lancer = une POST /api/consoles par ligne, à la suite ; puis les consoles sont posées en rangée
// sous tout ce qui est déjà sur le plateau.

// Le plafond du formulaire « Nouvelle console » et d'un groupe. Le serveur borne au même nombre (server.mjs, POST
// /api/consoles, `num(…, 1, 12)` : au-delà il rogne à 12, il ne refuse pas).
export const MAX_CONSOLES = 12
export const CLE = 'meydan.groupes'
export const MAX_NOM = 48
// Le rôle devient le nom des consoles : le serveur le coupe à 48 caractères (`cleanName`), ajoute « 1 », « 2 »… quand il
// en lance plusieurs, puis coupe encore à 48. Au-delà de 45, « 10 », « 11 », « 12 » tomberaient et plusieurs consoles de
// la ligne porteraient le même nom.
export const MAX_ROLE = 45
export const MAX_CONSIGNE = 20000 // comme le champ « Consigne » du formulaire
// La liste fermée du serveur (`MODELES`, server.mjs) : Claude seulement. « Par défaut » = rien d'envoyé (Opus, avec Fable
// en conseiller).
export const MODELES = [
  ['', 'Modèle par défaut'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-2', 'Fable 5.2'],
]
// La rangée : écart entre deux consoles (celui des places libres du serveur, `freeSlot`) et marge sous ce qui existe.
export const ECART = 48
export const MARGE = 96

const sansControle = (v, n) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, n) : '')
// Consigne (texte destiné à un agent) : retours à la ligne et tabulations gardés ; contrôles, formats invisibles (dont la
// direction d'écriture), zones privées, non attribués, sélecteurs de variante et remplissages invisibles retirés
// (relecture du 13/11 ; leçon du 11/11 : « ce qu'Orkun voit est exactement ce qui est gardé »).
const INVISIBLES = /(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu
export const consigneNette = (v) => (typeof v === 'string' ? v.replace(INVISIBLES, '').slice(0, MAX_CONSIGNE) : '')
export const nouvelId = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// Ce qui vient du stockage est relu champ par champ : une valeur inattendue (écrite à la main, version plus ancienne)
// devient la valeur sûre, jamais une erreur.
export function ligneValide(l) {
  const n = Math.round(Number(l?.nombre))
  return {
    kind: typeof l?.kind === 'string' && /^[a-z][a-z0-9-]{0,15}$/.test(l.kind) ? l.kind : 'claude',
    nombre: Number.isFinite(n) ? Math.min(MAX_CONSOLES, Math.max(1, n)) : 1,
    modele: MODELES.some(([id]) => id && id === l?.modele) ? l.modele : '',
    role: sansControle(l?.role, MAX_ROLE),
    consigne: consigneNette(l?.consigne),
  }
}
export function groupeValide(g) {
  if (!g || typeof g !== 'object' || !Array.isArray(g.lignes) || !g.lignes.length) return null
  return {
    id: typeof g.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(g.id) ? g.id : nouvelId(),
    nom: sansControle(g.nom, MAX_NOM),
    lignes: g.lignes.slice(0, MAX_CONSOLES).map(ligneValide),
  }
}

// Lecture et écriture dans un try/catch : navigation privée, stockage plein ou refusé → la page continue sans.
export function lis() {
  try {
    const v = JSON.parse(localStorage.getItem(CLE) || '[]')
    return Array.isArray(v) ? v.map(groupeValide).filter(Boolean) : []
  } catch {
    return []
  }
}
export function ecris(liste) {
  try {
    localStorage.setItem(CLE, JSON.stringify(liste))
    return true
  } catch {
    return false
  }
}

export const total = (g) => g.lignes.reduce((s, l) => s + l.nombre, 0)
export const nomDuType = (kind, kinds = []) => kinds.find((k) => k.id === kind)?.label || kind
// « 2 Claude + 1 Codex » : par type, dans l'ordre des lignes (deux lignes Claude de modèles différents s'additionnent).
export function resume(g, kinds = []) {
  const parType = new Map()
  for (const l of g.lignes) parType.set(l.kind, (parType.get(l.kind) || 0) + l.nombre)
  return [...parType].map(([k, n]) => `${n} ${nomDuType(k, kinds)}`).join(' + ')
}

// Ce qui empêche de lancer, vérifié AVANT la première console : rien de lancé à moitié pour une raison connue d'avance.
export function refus(g, kinds, cwd) {
  if (!cwd) return 'choisis un dossier.'
  if (!kinds.length) return 'liste des types pas encore lue, réessaie dans un instant.'
  const t = total(g)
  if (t > MAX_CONSOLES) return `${t} consoles : ${MAX_CONSOLES} au plus par groupe.`
  const absent = g.lignes.find((l) => !kinds.some((k) => k.id === l.kind))
  if (absent) return `le type « ${absent.kind} » n'existe pas sur ce serveur.`
  return ''
}

// Le corps de POST /api/consoles pour une ligne : des champs, que le serveur relit (type connu, dossier sous le dossier
// personnel, nom sans caractère de contrôle, modèle de sa liste fermée) ; aucun texte ne devient une commande.
export function corpsDe(l, cwd) {
  return {
    kind: l.kind,
    cwd,
    count: l.nombre,
    ...(l.role ? { name: l.role } : {}),
    ...(l.kind === 'claude' && l.modele ? { modele: l.modele } : {}),
    ...(l.kind !== 'shell' && l.consigne.trim() ? { consigne: l.consigne } : {}),
  }
}

// En rangée : une seule ligne horizontale, chaque console garde sa taille, écart régulier, SOUS tout ce qui est déjà sur
// le plateau (`avant` : consoles et cartes, avec x, y, w, h) : x au bord gauche de l'ensemble, y sous son bas + marge.
// Plateau vide : à l'origine.
export function rangee(avant, neuves, ecart = ECART, marge = MARGE) {
  const boites = avant.filter((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite))
  const x0 = boites.length ? Math.min(...boites.map((b) => b.x)) : 0
  const y = boites.length ? Math.max(...boites.map((b) => b.y + b.h)) + marge : 0
  let x = x0
  return neuves.map((c) => {
    const p = { id: c.id, x: Math.round(x), y: Math.round(y) }
    x += (Number.isFinite(c.w) ? c.w : 720) + ecart
    return p
  })
}
