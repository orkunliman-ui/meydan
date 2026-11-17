// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — le magasin
// des traits du stylo côté interface (serveur : lib/traits.mjs, routes /api/cartes/traits).
// Un seul magasin pour la page : le calque du plateau (support « plateau », Encre.jsx) et les cartes image (support =
// identifiant de la carte, SurfaceTraits) le lisent. Une lecture au premier lecteur et une écoute du flux d'état relayé
// par lib.js (« meydan:flux ») : `trait` (ajouté ou confirmé), `trait-retire` ({ id } : un trait gommé ; { support } :
// la carte est partie), `snapshot` (liaison refaite : on relit tout). Une réponse `{}` (serveurs factices des essais
// d'autres volets) donne une liste vide.
import { useMemo, useSyncExternalStore } from 'react'
import { api } from './lib.js'
import { COULEURS } from './cartes-types.js'

// Mêmes bornes que lib/traits.mjs.
export const EPAISSEUR = { min: 1, max: 24 }
export const POINTS_MAX = 1500
export const COORD_MAX = 50000

// ── Le magasin ──
let tous = []
const ecoutes = new Set()
// Traits gommés dont le serveur n'a pas encore répondu : une relecture faite entre-temps ne les ramène pas.
const enRetrait = new Set()
let vivant = false
const pose = (f) => {
  tous = f(tous)
  ecoutes.forEach((e) => e())
}
const estTrait = (t) => !!t && typeof t.id === 'string' && typeof t.support === 'string' && typeof t.couleur === 'string' && Number.isFinite(t.epaisseur) && Array.isArray(t.points) && t.points.length > 0
const remplace = (t) => (ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t])
const sans = (id) => (ts) => ts.filter((t) => t.id !== id)
// Pendant une relecture, les changements reçus entre-temps (flux, traits ajoutés ou gommés ici) sont notés et rejoués sur
// sa réponse : la réponse peut avoir été prise au serveur AVANT eux, elle ne les efface pas.
let lecture = null
const change = (f) => {
  lecture?.push(f)
  pose(f)
}
function charge() {
  const notes = (lecture = [])
  api('GET', '/api/cartes/traits').then(
    (j) => {
      if (lecture !== notes) return // une relecture plus récente est partie : c'est elle qui compte
      lecture = null
      if (!vivant) return
      pose((ts) => {
        const lus = (Array.isArray(j?.traits) ? j.traits : []).filter((t) => estTrait(t) && !enRetrait.has(t.id))
        const ids = new Set(lus.map((t) => t.id))
        // Les traits encore en route (envoyés, pas confirmés) restent à l'écran.
        return notes.reduce((acc, f) => f(acc), [...lus, ...ts.filter((t) => t.attente && !ids.has(t.id))])
      })
    },
    () => lecture === notes && (lecture = null),
  )
}
const recu = (e) => {
  const m = e.detail
  if (m?.type === 'snapshot') charge()
  else if (m?.type === 'trait' && estTrait(m.trait)) !enRetrait.has(m.trait.id) && change(remplace(m.trait))
  else if (m?.type === 'trait-retire') {
    if (typeof m.id === 'string') change(sans(m.id))
    else if (typeof m.support === 'string') change((ts) => ts.filter((t) => t.support !== m.support))
  }
}
// Le premier lecteur ouvre l'écoute et lit le serveur ; le dernier qui part la ferme.
function abonne(f) {
  ecoutes.add(f)
  if (!vivant) {
    vivant = true
    window.addEventListener('meydan:flux', recu)
    charge()
  }
  return () => {
    ecoutes.delete(f)
    if (!ecoutes.size) {
      vivant = false
      window.removeEventListener('meydan:flux', recu)
    }
  }
}
const lis = () => tous

// Les traits d'un support (« plateau » ou l'identifiant d'une carte image), dans l'ordre du tracé.
export function useTraits(support) {
  const ts = useSyncExternalStore(abonne, lis)
  return useMemo(() => ts.filter((t) => t.support === support), [ts, support])
}
// La même chose hors de React (l'image composée par la carte image) : ce que le magasin tient à cet instant, c'est-à-dire
// ce qui est à l'écran. Le magasin n'est tenu à jour que tant qu'un lecteur (useTraits, SurfaceTraits) est monté.
export function lisTraits(support) {
  return tous.filter((t) => t.support === support)
}

const nouvelId = () => `t${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}`

// Ajoute un trait { support, couleur, epaisseur, points } : à l'écran tout de suite, sous son identifiant définitif (pris
// ici : le message du flux qui revient le remplace au lieu de le doubler), puis envoyé. Refusé (ou liaison coupée) : il
// disparaît de l'écran et l'erreur revient à l'appelant. Rend la promesse du trait enregistré.
export function ajouteTrait({ support, couleur, epaisseur, points }) {
  const corps = { id: nouvelId(), support, couleur, epaisseur, points }
  // Le corps d'une demande est coupé à 64 Ko (readJson, nginx) : mesuré en octets avant l'envoi (il ne dépasse pas 31 Ko
  // quand les points sont arrondis et bornés comme le fait Encre.jsx ; ceci protège d'un appelant qui ne le ferait pas).
  if (new TextEncoder().encode(JSON.stringify(corps)).length > 60000) return Promise.reject(new Error('Trait trop lourd pour un envoi : rien n’est enregistré.'))
  const local = { ...corps, attente: true }
  change(remplace(local))
  return api('POST', '/api/cartes/traits', corps).then(
    (j) => {
      if (estTrait(j?.trait) && !enRetrait.has(j.trait.id)) change(remplace(j.trait))
      return j?.trait
    },
    (e) => {
      change((ts) => ts.filter((t) => t !== local)) // le trait local seul (un même identifiant déjà pris reste à l'écran)
      throw e
    },
  )
}
// Gomme un trait : il quitte l'écran tout de suite. Refusé : l'écran reprend ce que le serveur a vraiment (relecture) et
// l'erreur revient à l'appelant. Déjà gommé ailleurs (« trait inconnu ») : c'est ce qu'on voulait, pas une erreur.
export function retireTrait(id) {
  enRetrait.add(id)
  change(sans(id))
  return api('DELETE', `/api/cartes/traits/${id}`).then(
    () => void enRetrait.delete(id),
    (e) => {
      enRetrait.delete(id)
      if (e.message === 'trait inconnu') return
      charge()
      throw e
    },
  )
}

// La vraie couleur d'un nom (pour un canevas) : celle que la classe `cr-coul-<nom>` (cartes.css) donne dans le thème en
// cours, lue sur un élément posé un instant dans `dans` (par défaut le plateau : les jetons du thème y sont tous). Rend
// une couleur CSS calculée (« rgb(…) »).
export function couleurCss(nom, dans = document.querySelector('.react-flow') || document.body) {
  const sonde = document.createElement('span')
  sonde.className = `cr-coul-${COULEURS.includes(nom) ? nom : 'papier'}`
  sonde.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:var(--cr-c)'
  dans.appendChild(sonde)
  const c = getComputedStyle(sonde).color
  sonde.remove()
  return c
}

// Le chemin SVG d'un trait, lissé : une courbe qui passe par le milieu de chaque segment (les points eux-mêmes servent de
// points de contrôle) ; un seul point = un point rond (sous-chemin de longueur nulle, bouts ronds). Sert aussi à un
// canevas : new Path2D(cheminTrait(t)).
const chemins = new WeakMap()
export function cheminTrait(t) {
  let d = chemins.get(t)
  if (d !== undefined) return d
  const p = t.points || []
  const m = (a, b) => Math.round(((a + b) / 2) * 100) / 100
  if (!p.length) d = ''
  else if (p.length === 1) d = `M${p[0][0]} ${p[0][1]}l0 0`
  else if (p.length === 2) d = `M${p[0][0]} ${p[0][1]}L${p[1][0]} ${p[1][1]}`
  else {
    d = `M${p[0][0]} ${p[0][1]}`
    for (let i = 1; i < p.length - 1; i++) d += `Q${p[i][0]} ${p[i][1]} ${m(p[i][0], p[i + 1][0])} ${m(p[i][1], p[i + 1][1])}`
    d += `L${p[p.length - 1][0]} ${p[p.length - 1][1]}`
  }
  chemins.set(t, d)
  return d
}
// Peint des traits sur un canevas 2D, dans le repère courant du contexte (pour une image : 1 unité = 1 pixel de l'image),
// avec les vraies couleurs du thème (couleurCss) : l'image composée par la carte image (envoi à une console).
export function peinsTraits(ctx, traits, dans) {
  const couleurs = {}
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const t of traits) {
    ctx.strokeStyle = couleurs[t.couleur] ||= couleurCss(t.couleur, dans)
    ctx.lineWidth = t.epaisseur
    ctx.stroke(new Path2D(cheminTrait(t)))
  }
  ctx.restore()
}
