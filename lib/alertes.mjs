// Notifications du téléphone (Web Push) : prévenir Orkun quand un agent l'attend, appli fermée. (Orkun, 10/11 :
// « 1. Ok », sur « Notifications iPhone quand un agent t'attend, appli fermée […] Le contenu passe par le service de
// notification d'Apple ».) Mécanisme éprouvé sur iPhone : iOS 16.4
// et plus, appli ouverte depuis l'écran d'accueil. Le contenu est chiffré pour l'appareil ; le service de notification
// ne voit que l'adresse du site.
//
// Deux fichiers dans le dossier de données, lisibles par le seul propriétaire : `vapid.json` (la paire de clés du
// serveur, créée au premier lancement) et `alertes.json` (les appareils abonnés).
import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'

// Le serveur poste vers l'adresse fournie par le navigateur : seulement les services de notification connus, jamais une
// adresse interne ou arbitraire.
const SERVICES = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/]
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/
export const MAX_APPAREILS = 8

export function abonnementValide(s) {
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !s.keys || typeof s.keys !== 'object') return false
  const { p256dh, auth } = s.keys
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !B64URL.test(p256dh) || !B64URL.test(auth) || p256dh.length > 120 || auth.length > 40) return false
  try {
    const u = new URL(s.endpoint)
    return u.protocol === 'https:' && !u.port && SERVICES.some((h) => h.test(u.hostname))
  } catch {
    return false
  }
}

const propre = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

// `hote` : le nom public du site (les notifications n'existent que derrière https). `aBlanc` (essais) : rien ne part sur
// le réseau, chaque notification est écrite dans `alertes-essai.jsonl`.
export function ouvreAlertes(data, hote, { aBlanc = false } = {}) {
  const fVapid = path.join(data, 'vapid.json')
  const fAbonnes = path.join(data, 'alertes.json')
  const fEssai = path.join(data, 'alertes-essai.jsonl')
  let vapid
  try {
    vapid = JSON.parse(fs.readFileSync(fVapid, 'utf8'))
    if (typeof vapid.publicKey !== 'string' || typeof vapid.privateKey !== 'string') throw new Error('clés illisibles')
  } catch {
    vapid = webpush.generateVAPIDKeys()
    fs.writeFileSync(fVapid, JSON.stringify(vapid), { mode: 0o600 })
  }
  let abonnes = []
  try {
    abonnes = JSON.parse(fs.readFileSync(fAbonnes, 'utf8')).filter(abonnementValide)
  } catch {} // pas encore d'appareil abonné
  const garde = () => {
    const tmp = fAbonnes + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(abonnes), { mode: 0o600 })
    fs.renameSync(tmp, fAbonnes)
  }
  // Un envoi vers un appareil. Rejette avec `statusCode` (404 / 410 = adresse morte) quand le service refuse.
  const pousse = async (sub, p, ttl) => {
    const charge = JSON.stringify({ title: propre(p.title, 80), body: propre(p.body, 240), tag: propre(p.tag, 40), ouvre: propre(p.ouvre, 16) })
    if (aBlanc) return void fs.appendFileSync(fEssai, charge + '\n', { mode: 0o600 })
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, charge, {
      vapidDetails: { subject: `https://${hote}`, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: Math.max(60, Math.round(ttl)),
      urgency: 'high',
      timeout: 15000,
    })
  }
  return {
    cle: vapid.publicKey,
    nombre: () => abonnes.length,
    // Cet appareil est-il encore dans la liste ? (Une adresse morte en est retirée par `envoie` : l'écran de l'appareil le
    // demande au lieu de croire son abonnement local ; chasse du 17/11, « Activées » affiché à tort.)
    connu: (endpoint) => abonnes.some((a) => a.endpoint === endpoint),
    // Abonne un appareil : il n'est gardé qu'une fois la notification d'essai acceptée par le service.
    async abonne(sub) {
      if (!abonnementValide(sub)) throw Object.assign(new Error('abonnement refusé : adresse ou clés inattendues'), { code: 400 })
      const neuf = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: Date.now() }
      try {
        await pousse(neuf, { title: 'Meydan', body: 'Notifications activées sur cet appareil.', tag: 'essai' }, 600)
      } catch (e) {
        // La raison du refus va au journal (vu le 11/11 : un refus sur son PC, et rien pour le comprendre). Ni clés ni adresse
        // complète : le service et sa réponse seulement.
        console.error(`[alertes] essai refusé par ${new URL(neuf.endpoint).hostname} : ${e.statusCode ?? '-'} ${propre(e.body ?? e.message, 200)}`)
        throw Object.assign(new Error(`le service de notification a refusé l’essai (${e.statusCode ?? e.message})`), { code: 502 })
      }
      abonnes = [...abonnes.filter((a) => a.endpoint !== neuf.endpoint), neuf].slice(-MAX_APPAREILS)
      garde()
    },
    retire(endpoint) {
      const avant = abonnes.length
      abonnes = abonnes.filter((a) => a.endpoint !== endpoint)
      if (abonnes.length !== avant) garde()
      return avant - abonnes.length
    },
    // À tous les appareils abonnés. Une adresse morte (404 / 410) est retirée. Rend { envoyes, echecs }.
    async envoie(p, ttl = 6 * 3600) {
      let envoyes = 0
      const echecs = []
      for (const a of [...abonnes]) {
        try {
          await pousse(a, p, ttl)
          envoyes++
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) abonnes = abonnes.filter((x) => x !== a)
          echecs.push(String(e.statusCode ?? e.message).slice(0, 120))
        }
      }
      if (echecs.length) garde()
      return { envoyes, echecs }
    },
  }
}
