// Rendu des terminaux par la carte graphique (volet vitesse-term, 17/11). Orkun : « Vitesse des terminaux : essayer un
// rendu plus rapide des terminaux (par la carte graphique), sur le banc à la taille de ton grand écran et du Mac. Je ne
// le garde que si le gain est mesuré et le texte reste net. »
// Ici on décide QUI est rendu en WebGL (@xterm/addon-webgl, l'addon officiel d'xterm.js) ; Term.jsx s'inscrit, et tout
// terminal sans place reste au rendu DOM d'xterm.
// - `?rendu=` (LOOKS, lib.js) : « dom » (défaut) = jamais ; « auto » = WebGL seulement sur une vraie carte graphique,
//   jamais au doigt ; « webgl » = forcé, même en rendu logiciel (le banc n'a que SwiftShader).
// - Jamais de WebGL en « auto » : appareil mené au doigt (iPhone, iPad : Safari n'est pas essayable ici, et la mémoire
//   graphique y est comptée, leçon du 11/11 sur le paysage) ; rendu logiciel (SwiftShader, llvmpipe : le dessin passe
//   au processeur, mesuré au banc à plusieurs secondes de processeur par seconde) ; et dans tous les modes : WebGL2
//   absent, module introuvable, 3 pertes de contexte dans la page.
// - Au plus WEBGL_MAX terminaux à la fois : Chrome (et Safari) ne gardent qu'environ 16 contextes WebGL (par processus
//   de page : deux onglets Meydan peuvent se les partager) et perdent le plus ancien au-delà. L'actif d'abord, puis les
//   éveillés, puis les endormis (`veille`) ; à rang égal, celui qui a déjà sa place la garde, puis le plus ancien inscrit :
//   pas de va-et-vient (relecture du 17/11 : sans cette règle, chaque clic au-delà de 12 terminaux échangeait deux
//   rendus, et les endormis se repassaient les places). Un endormi ne rend son contexte que si un éveillé en manque.
// - Rendre un contexte = dispose de l'addon (xterm reprend son rendu DOM), PUIS `loseContext` : dispose retire la toile
//   sans rendre le contexte, qui resterait compté jusqu'au ramasse-miettes.
// - Perte de contexte (pilote, carte graphique qui redémarre) : ce terminal repasse en DOM pour de bon.
import { charge } from './differe.js'
import { journal } from './journal.jsx'

export const WEBGL_MAX = 12
let module = null // le module de l'addon, une fois arrivé
let vient = null // sa demande en cours ou réussie
let pertes = 0 // contextes perdus dans la page : à 3, plus de WebGL du tout
let ordre = 0
const membres = new Set()

const auDoigt = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches
// Une vraie carte graphique ? Regardé une fois par page, sur un contexte d'essai rendu aussitôt.
let materiel
export function carteGraphique() {
  if (materiel !== undefined) return materiel
  materiel = false
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      const nom = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      materiel = !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(nom)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      // Au journal du moteur (`[client] rendu-pc`) : on saura sur quelle carte tournent ses terminaux, et en quel rendu.
      journal('rendu-pc', materiel ? 'carte graphique : terminaux en WebGL' : 'rendu logiciel : terminaux en DOM', nom)
    }
  } catch {} // pas de WebGL2 : rendu DOM
  return materiel
}
const mode = () => document.documentElement.dataset.rendu || 'dom'
export function webglVoulu() {
  const m = mode()
  if (m === 'dom' || pertes >= 3 || typeof WebGL2RenderingContext === 'undefined') return false
  return m === 'webgl' || (!auDoigt() && carteGraphique())
}

// Le code de l'addon, chargé à part (rien pour le téléphone). Introuvable : rendu DOM, sans erreur à l'écran.
export function chargeWebgl() {
  if (!webglVoulu()) return Promise.resolve(null)
  vient ??= charge(() => import('@xterm/addon-webgl')).then(
    (m) => (module = m),
    () => {
      vient = null
      return null
    },
  )
  return vient
}

// `term` ouvert (term.open fait) ; `actif()`, `eveille()` lus à chaque répartition ; `apres(rendu)` : le rendu vient de
// changer ('webgl' | 'dom'), la taille des cellules aussi (Term refait sa grille).
export function inscris(term, { actif, eveille, apres }) {
  const m = { term, actif, eveille, apres, ordre: ordre++, addon: null, toile: null, perdu: false }
  membres.add(m)
  repartit()
  return {
    maj: repartit,
    quitte: () => {
      membres.delete(m)
      rends(m, false)
      repartit()
    },
  }
}

function repartit() {
  const rang = (m) => (m.actif() ? 0 : m.eveille() ? 1 : 2)
  // Un terminal déjà retiré de la page (démontage groupé : les nettoyages passent après le retrait) n'est pas candidat.
  const candidats = module && webglVoulu() ? [...membres].filter((m) => !m.perdu && m.term.element?.isConnected) : []
  const elus = new Set(candidats.sort((a, b) => rang(a) - rang(b) || !a.addon - !b.addon || a.ordre - b.ordre).slice(0, WEBGL_MAX))
  for (const m of membres) if (m.addon && !elus.has(m)) rends(m) // d'abord rendre : la place sert aussitôt
  for (const m of elus) if (!m.addon) prends(m)
}

function prends(m) {
  const avant = new Set(m.term.element.querySelectorAll('canvas'))
  let addon = null
  try {
    addon = new module.WebglAddon() // lève sur un vieux Safari sans WebGL2
    m.term.loadAddon(addon)
  } catch {
    // Contexte refusé (trop de contextes, pilote, shader) : ce terminal reste au DOM. Si l'addon a levé APRÈS avoir créé
    // sa toile, elle n'est jamais rendue par dispose : on rend son contexte et on la retire nous-mêmes.
    try {
      addon?.dispose()
    } catch {} // déjà défait
    for (const c of m.term.element.querySelectorAll('canvas'))
      if (!avant.has(c)) {
        try {
          c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
        } catch {} // contexte déjà perdu
        c.remove()
      }
    m.perdu = true
    return
  }
  m.addon = addon
  // La toile WebGL (l'addon pose aussi une toile 2d pour les liens : `getContext('webgl2')` y rend null).
  m.toile = [...m.term.element.querySelectorAll('canvas')].find((c) => !avant.has(c) && c.getContext('webgl2')) || null
  addon.onContextLoss(() => {
    pertes++
    m.perdu = true
    rends(m)
    repartit()
  })
  m.apres('webgl')
}

function rends(m, prevenir = true) {
  const { addon, toile } = m
  if (!addon) return
  m.addon = m.toile = null
  try {
    addon.dispose()
  } catch {} // terminal déjà défait
  try {
    toile?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {} // contexte déjà perdu
  if (prevenir) m.apres('dom')
}

// Pour les essais : combien de terminaux en WebGL, combien inscrits.
if (typeof window !== 'undefined') window.__rendu = () => ({ webgl: [...membres].filter((m) => m.addon).length, inscrits: membres.size, pertes, max: WEBGL_MAX })
