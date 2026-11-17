import { useCallback, useState } from 'react'
import { api } from './lib.js'

// Barre d'envoi, côté navigateur : réduction des photos, envoi avec avancement, micro, dépôt sur ordinateur.
// Le moteur est dans lib/envois.mjs ; le dessin dans docs/specs/2026-11-10-barre-envoi.md.
export const MAX_FILE = 25 * 1024 * 1024
export const MAX_FILES = 10
export const MAX_AUDIO_S = 600

// Photo réduite à 2 560 px en JPEG : moins de données mobiles, et un format que le VPS lit toujours (pas le HEIC
// de l'iPhone). Une capture PNG déjà petite reste telle quelle : son texte reste net.
export async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|heic|heif|webp)$/.test(file.type)) return file
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height))
    if (k === 1 && file.type === 'image/png' && file.size < 4 * 1024 * 1024) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * k)
    canvas.height = Math.round(bmp.height * k)
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9))
    return blob ? new File([blob], (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : file
  } catch {
    return file // image illisible ici : on envoie l'original
  }
}

// Envoie un fichier à une console. Rend la promesse du fichier reçu ({ nom, taille, chemin }) et de quoi annuler.
export function upload(consoleId, file, onProgress) {
  const xhr = new XMLHttpRequest()
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `/api/envois/${consoleId}/fichier?nom=${encodeURIComponent(file.name || 'fichier')}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      let j = {}
      try {
        j = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status === 201 && j.fichier) return resolve(j.fichier)
      if (xhr.status === 401) location.reload() // session finie
      reject(new Error(j.error || (xhr.status === 413 ? 'fichier trop gros (25 Mo au plus)' : `envoi refusé (${xhr.status})`)))
    }
    xhr.onerror = () => reject(new Error('liaison coupée pendant l’envoi'))
    xhr.onabort = () => reject(new Error('envoi annulé'))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

export const removeFile = (consoleId, nom) => api('DELETE', `/api/envois/${consoleId}/fichier/${encodeURIComponent(nom)}`)
// `confirme` : l'empreinte d'un 409 « texte risqué » (second appui, lib/garde-envoi.mjs).
export const sendMessage = (consoleId, texte, fichiers, confirme) => api('POST', `/api/envois/${consoleId}/message`, { texte, fichiers, ...(confirme ? { confirme } : {}) })

// Enregistre le micro. Safari donne de l'AAC (audio/mp4), Chrome de l'Opus (audio/webm) : le VPS lit les deux.
export async function record() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('ce navigateur ne sait pas enregistrer')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
    throw new Error('micro refusé : autorise-le pour ce site dans les réglages')
  })
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const done = new Promise((resolve) => (rec.onstop = () => resolve(new Blob(chunks, { type: (rec.mimeType || type || 'audio/mp4').split(';')[0] }))))
  const off = () => stream.getTracks().forEach((t) => t.stop())
  rec.start()
  return {
    async stop() {
      if (rec.state !== 'inactive') rec.stop()
      const blob = await done
      off()
      return blob
    },
    cancel() {
      rec.onstop = null
      if (rec.state !== 'inactive') rec.stop()
      off()
    },
  }
}

// Transcription sur le VPS (moteur local) : rend { texte, duree }. Sans console (`null`) : la note de la barre de commande.
export async function transcribe(consoleId, blob) {
  const r = await fetch(consoleId ? `/api/envois/${consoleId}/voix` : '/api/ordre/voix', { method: 'POST', headers: { 'content-type': blob.type || 'audio/mp4' }, body: blob })
  if (r.status === 401) location.reload()
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `transcription refusée (${r.status})`)
  return j
}

// Ordinateur : coller (Ctrl+V) ou glisser un fichier sur une console l'envoie au VPS, puis écrit son chemin dans la
// console, sans valider. `termApi` = la référence que Term remplit ({ send }).
export function useDepot(consoleId, termApi) {
  const [etat, setEtat] = useState(null) // null | { texte, echec }
  const depose = useCallback(
    async (files) => {
      const list = [...files].slice(0, MAX_FILES)
      let fait = 0
      for (const brut of list) {
        setEtat({ texte: `envoi de ${brut.name || 'fichier'}…` })
        try {
          const f = brut.type.startsWith('image/') ? await shrinkImage(brut) : brut
          if (f.size > MAX_FILE) throw new Error(`${f.name} : plus de 25 Mo`)
          const recu = await upload(consoleId, f, () => {}).promise
          termApi.current?.send(`${recu.chemin} `)
          fait++
        } catch (e) {
          setEtat({ texte: e.message, echec: true })
          setTimeout(() => setEtat(null), 6000)
          return
        }
      }
      setEtat({ texte: fait > 1 ? `${fait} fichiers reçus : chemins écrits dans la console` : 'fichier reçu : chemin écrit dans la console' })
      setTimeout(() => setEtat(null), 3000)
    },
    [consoleId, termApi],
  )
  return {
    etat,
    // En phase de capture : avant le terminal, qui ne collerait que du texte.
    onPasteCapture: (e) => {
      const f = e.clipboardData?.files
      if (!f?.length) return
      e.preventDefault()
      e.stopPropagation()
      depose(f)
    },
    onDragOver: (e) => [...(e.dataTransfer?.types || [])].includes('Files') && e.preventDefault(),
    onDrop: (e) => {
      const f = e.dataTransfer?.files
      if (!f?.length) return
      e.preventDefault()
      depose(f)
    },
  }
}
