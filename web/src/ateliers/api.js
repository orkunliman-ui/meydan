// Ateliers (volet du 13/11) : les appels au serveur (specs/001-ateliers/contracts/api.md) et le suivi d'un fichier.
// Le flux /ws/events (relayé par lib.js en événement « meydan:flux ») n'annonce qu'une EMPREINTE ({ type: 'atelier', id,
// cle }) ; le contenu n'est relu que par l'écran qui le montre, et le serveur ne le renvoie pas s'il n'a pas changé.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib.js'

const q = (route, params) => `/api/ateliers/${route}?${new URLSearchParams(params)}`
export const lire = (projet, chemin, cle = '') => api('GET', q('lire', { projet, chemin, cle }))
export const arbre = (projet, chemin = '') => api('GET', q('arbre', { projet, chemin }))
export const recherche = (projet, texte) => api('GET', q('recherche', { projet, q: texte }))
export const coffre = (projet, dossier = '') => api('GET', q('coffre', { projet, dossier }))
export const projets = () => api('GET', '/api/projects').then((j) => j.projects || [])

// Ce que dit un refus du serveur, en clair.
export function ditRefus(r) {
  const mo = (n) => `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`
  switch (r?.refus) {
    case 'absent':
      return 'Fichier absent (pas encore écrit, ou déplacé).'
    case 'dossier':
      return 'C’est un dossier, pas un fichier.'
    case 'trop-gros':
      return `Fichier trop lourd pour l’aperçu : ${mo(r.taille)} (au plus ${mo(r.borne)}).`
    case 'binaire':
      return 'Fichier binaire : pas d’aperçu.'
    case 'secret':
      return 'Fichier de clé ou de secret : jamais affiché.'
    case 'interdit':
      return 'Fichier hors des dossiers permis (caché, données de Meydan, compte 2…).'
    case 'hors-projet':
      return 'Ce chemin sort du projet (lien symbolique) : refusé.'
    case 'lien-physique':
      return 'Fichier à plusieurs liens physiques : refusé (il peut être un autre fichier, protégé, sous un nom anodin).'
    default:
      return r?.refus ? `Refusé (${r.refus}).` : ''
  }
}

// Le contenu d'un fichier suivi : relu au montage, puis à chaque annonce du flux pour la carte `id` (ou, sans carte,
// toutes les 2 s — le lecteur ouvert depuis le Chat). `actif` faux : rien n'est lu (vue de loin, carte cachée).
// Rend { contenu, erreur, charge }. Un contenu déjà affiché reste à l'écran pendant une relecture.
export function useContenu({ id, projet, chemin, actif = true }) {
  const [etat, setEtat] = useState({ contenu: null, erreur: '', charge: false })
  const cle = useRef('')
  const vivant = useRef(true)
  useEffect(() => {
    vivant.current = true
    cle.current = ''
    setEtat({ contenu: null, erreur: '', charge: false })
    if (!actif || !projet || !chemin) return
    let enCours = false
    let encore = false
    const relit = async () => {
      if (enCours) return void (encore = true)
      enCours = true
      setEtat((e) => ({ ...e, charge: true }))
      try {
        const r = await lire(projet, chemin, cle.current)
        if (!vivant.current) return
        if (r.texte !== undefined || r.refus) {
          cle.current = r.cle
          setEtat({ contenu: r, erreur: '', charge: false })
        } else setEtat((e) => ({ ...e, charge: false }))
      } catch (e) {
        if (vivant.current) setEtat((x) => ({ ...x, erreur: e.message, charge: false }))
      } finally {
        enCours = false
        if (encore && vivant.current) {
          encore = false
          relit()
        }
      }
    }
    relit()
    const recu = (e) => {
      const m = e.detail
      if (m?.type === 'snapshot' || (m?.type === 'atelier' && m.id === id && m.cle !== cle.current)) relit()
    }
    window.addEventListener('meydan:flux', recu)
    const t = id ? null : setInterval(relit, 2000)
    return () => {
      vivant.current = false
      window.removeEventListener('meydan:flux', recu)
      if (t) clearInterval(t)
    }
  }, [id, projet, chemin, actif])
  return etat
}

// Export PDF : le serveur imprime le fichier HTML lui-même, ou l'article Markdown rendu à l'écran (`html`). Le fichier
// reçu est proposé au téléchargement.
export async function exportePdf({ projet, chemin, html, titre }) {
  const r = await fetch('/api/envois/ateliers/pdf', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projet, chemin, html, titre }),
  }).catch(() => {
    throw new Error('Liaison coupée : réessaie dans un instant.')
  })
  if (r.status === 401) location.reload()
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `erreur ${r.status}`)
  const blob = await r.blob()
  const nom = decodeURIComponent((r.headers.get('content-disposition') || '').split("''")[1] || 'document.pdf')
  telecharge(blob, nom)
  return { nom, taille: blob.size }
}

export function telecharge(blob, nom) {
  const u = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: u, download: nom }).click()
  setTimeout(() => URL.revokeObjectURL(u), 60000)
}

export const nomDe = (chemin) => (chemin || '').split('/').pop() || ''
export const dossierCourt = (projet) => (projet || '').replace(/^\/home\/[^/]+/, '~')
