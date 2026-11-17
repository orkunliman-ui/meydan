// Le sujet d'une session, tel que l'agent le nomme lui-même. Orkun, 10/11 : « avoir un ptit titre du sujet de la session
// par fenetre […] apres que ce soit detectable biensur pas en debut de fenetre ». Rien n'est inventé ici : tant que
// l'agent n'a pas nommé sa session, le sujet est vide et l'écran n'affiche rien.
import fs from 'node:fs'
import os from 'node:os'

const propre = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

// Claude Code pose le sujet en titre de son terminal, derrière un signe (« ✳ Sujet »). Relevé sur de vraies sessions
// (test/seance-2026-11-10/sonde-titre.mjs) : « ✳ Claude Code » tant que la conversation est vide, le sujet 2 à 3 s après
// le premier message, « ✳ Claude Code » de nouveau dès un /clear. Avant que Claude ait pris la main (question au
// démarrage), le titre est celui de tmux : le nom de la machine.
// Rend le sujet, '' si Claude dit ne pas en avoir, null si le titre n'apprend rien (on garde alors ce qu'on savait).
export function sujetClaude(titre, hote = os.hostname()) {
  const t = propre(titre).replace(/^[^\p{L}\p{N}\s]{1,2}\s+/u, '')
  if (!t || t === hote) return null
  return /^claude(\s+code)?$/i.test(t) ? '' : t
}

// Codex note le nom de chaque fil dans son index (`session_index.jsonl`, une ligne JSON par changement : la dernière
// d'un fil gagne). Relu seulement quand le fichier a changé ; on ne lit que sa fin s'il est devenu très gros.
const FIN = 1 << 20
let vu = { fichier: '', mtime: 0, taille: 0, noms: new Map() }
export function sujetsCodex(fichier) {
  let st
  try {
    st = fs.statSync(fichier)
  } catch {
    return new Map() // pas d'index : Codex n'a encore rien nommé (ou n'est pas installé)
  }
  if (vu.fichier === fichier && vu.mtime === st.mtimeMs && vu.taille === st.size) return vu.noms
  const noms = new Map()
  const fd = fs.openSync(fichier, 'r')
  try {
    const debut = Math.max(0, st.size - FIN)
    const tampon = Buffer.alloc(st.size - debut)
    fs.readSync(fd, tampon, 0, tampon.length, debut)
    for (const ligne of tampon.toString('utf8').split('\n')) {
      try {
        const j = JSON.parse(ligne)
        if (typeof j.id === 'string' && propre(j.thread_name)) noms.set(j.id, propre(j.thread_name))
      } catch {} // ligne coupée (début de la fin lue, ou écriture en cours) : la suivante compte
    }
  } finally {
    fs.closeSync(fd)
  }
  vu = { fichier, mtime: st.mtimeMs, taille: st.size, noms }
  return noms
}
