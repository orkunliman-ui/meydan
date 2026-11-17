// Silence de sortie tmux, indépendant des connexions du navigateur et des hooks.
export const SUSPECTE_MS = 5 * 60_000
export const MUETTE_MS = 15 * 60_000
export const REPORT_MS = 30 * 60_000
const travaille = (c) => ['working', 'running'].includes(c.status) && !c.fini

export function observeSilence(c, sortie, now = Date.now()) {
  const avant = JSON.stringify(c.silence)
  if (!travaille(c)) {
    delete c.silence
    return { change: avant !== undefined, notifie: false }
  }
  // window_activity est en secondes. Une reprise de travail commence un nouvel épisode,
  // même si l'écran n'a pas encore écrit. L'état est persistant dans state.json.
  const depuis = Math.max(c.since || now, Number.isFinite(sortie) ? sortie : 0)
  if (!c.silence || depuis > c.silence.depuis) c.silence = { depuis, notifie: false, reporte: 0 }
  const s = c.silence
  const duree = Math.max(0, now - s.depuis)
  s.etat = s.reporte > now ? 'reportee' : duree >= MUETTE_MS ? 'muette' : duree >= SUSPECTE_MS ? 'suspecte' : 'ok'
  const notifie = s.etat === 'muette' && !s.notifie
  if (notifie) s.notifie = true
  return { change: avant !== JSON.stringify(s), notifie }
}

export function reporteSilence(c, now = Date.now()) {
  if (!travaille(c) || !c.silence || !['suspecte', 'muette'].includes(c.silence.etat)) return false
  c.silence.reporte = now + REPORT_MS
  c.silence.etat = 'reportee'
  return true
}
