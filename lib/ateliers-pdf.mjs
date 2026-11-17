// Ateliers (volet du 13/11) : le PDF d'un document, fabriqué par le Chromium sans écran déjà présent sur la machine
// (brief : « Page.printToPDF par CDP »). Piloté par le TUBE de débogage (`--remote-debugging-pipe`, descripteurs 3 et 4,
// messages terminés par un octet nul) : aucun port ouvert pendant l'export. La page est servie à une adresse fictive par
// interception (`Fetch`) ; TOUTE autre requête est refusée, une navigation de plus est annulée (204 : « pas de
// contenu », la page reste), les scripts sont coupés et aucun nom d'hôte ne se résout. Une fabrication à la fois, 30 s au
// plus, puis le Chromium est tué par son PID et son profil temporaire effacé. Essai éclair du 13/11 : 159 ms, 7 pages A4.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME_DEFAUT = '/snap/bin/chromium'
const ADRESSE = 'http://meydan.impression/'
const refus = (message, code) => Object.assign(new Error(message), { code })
// En tête de toute page imprimée (comme le cadre de l'écran, Document.jsx) : une politique ne peut que s'ajouter à celle
// du document ; aucune ressource ni connexion, quelle que soit la voie (relecture de sécurité du 13/11, F5).
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
export const pageBornee = (html) => `<!doctype html>${CSP}<meta charset="utf-8">${html}`
const PREFIXE = 'meydan-pdf-'
// Profils laissés par un moteur arrêté en plein export : effacés au démarrage s'ils ont plus de 10 min (un export dure
// 30 s au plus ; un autre Meydan de la machine peut être en train d'en fabriquer un).
function nettoieVieux() {
  try {
    for (const n of fs.readdirSync(os.tmpdir())) {
      if (!n.startsWith(PREFIXE)) continue
      const d = path.join(os.tmpdir(), n)
      try {
        const st = fs.lstatSync(d)
        if (st.isDirectory() && st.uid === process.getuid() && Date.now() - st.mtimeMs > 10 * 60 * 1000) fs.rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  } catch {}
}

export function ouvreImprimante({ chrome = process.env.MEYDAN_CHROME || CHROME_DEFAUT, delai = 30000 } = {}) {
  let occupe = false
  let dernier = 0
  nettoieVieux()
  async function imprime(html) {
    if (occupe) throw refus('un export PDF est déjà en cours : réessaie dans quelques secondes', 409)
    if (!fs.existsSync(chrome)) throw refus('navigateur d’impression introuvable sur la machine', 500)
    occupe = true
    let profil
    try {
      profil = fs.mkdtempSync(path.join(os.tmpdir(), PREFIXE))
    } catch (e) {
      occupe = false
      throw refus(`impression : ${e.message}`, 500)
    }
    // Liste d'arguments (jamais une ligne de shell). Aucun nom ne se résout (`--host-resolver-rules`), tout passe par un
    // proxy qui n'existe pas, WebRTC n'a pas d'UDP direct, pas de prélecture ni de règles de spéculation (relecture F5).
    // `--no-sandbox` : sans lui ce Chromium refuse de démarrer sur cette machine (AppArmor) — décision pour Orkun.
    // Environnement minimal : rien de celui du moteur (relecture F6).
    const p = spawn(
      chrome,
      ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps', '--mute-audio', '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=127.0.0.1:9', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=SpeculationRules,Prerender2,NetworkPrediction,PreloadMediaEngagementData', '--dns-prefetch-disable', '--remote-debugging-pipe', `--user-data-dir=${profil}`, 'about:blank'],
      // `detached` : Chromium et ses enfants (zygote, rendu, GPU) forment leur propre groupe, tué d'un coup à l'échéance
      // (comme lib/planificateur.mjs). `cwd` : le profil temporaire — un plantage n'y laisse son « core » qu'à effacer
      // (un core de chrome-headless-shell était tombé dans la copie de travail, dossier courant du moteur, le 13/11).
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: profil, LANG: 'C.UTF-8', TMPDIR: profil }, cwd: profil, detached: true },
    )
    dernier = p.pid
    const sortie = new Promise((r) => p.once('exit', r))
    let fini = false
    const attente = new Map()
    const ecoutes = new Set()
    let n = 0
    let morceaux = [] // le message en cours de réception (l'octet nul n'est cherché que dans le morceau neuf : F7)
    const meurt = (e) => {
      for (const { ko } of attente.values()) ko(e)
      attente.clear()
    }
    p.on('error', (e) => meurt(refus(`navigateur d’impression : ${e.message}`, 500)))
    p.on('exit', () => meurt(refus('le navigateur d’impression s’est arrêté', 500)))
    p.stdio[4].on('data', (d) => {
      let i
      while ((i = d.indexOf(0)) >= 0) {
        morceaux.push(d.subarray(0, i))
        d = d.subarray(i + 1)
        let m
        try {
          m = JSON.parse(Buffer.concat(morceaux).toString('utf8'))
        } catch {
          m = {}
        }
        morceaux = []
        if (m.id && attente.has(m.id)) {
          const { ok, ko } = attente.get(m.id)
          attente.delete(m.id)
          m.error ? ko(refus(`impression : ${m.error.message}`, 500)) : ok(m.result)
        } else for (const f of ecoutes) f(m)
      }
      if (d.length) morceaux.push(d)
    })
    p.stdio[3].on('error', () => {})
    const cdp = (method, params = {}, sessionId) =>
      new Promise((ok, ko) => {
        if (fini) return ko(refus('impression arrêtée', 500))
        const id = ++n
        attente.set(id, { ok, ko })
        p.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
      })
    let minuteur
    const delaiDepasse = new Promise((_, ko) => {
      minuteur = setTimeout(() => ko(refus('export PDF trop long (30 s) : arrêté', 504)), delai)
    })
    try {
      const travail = (async () => {
        const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
        const S = (m, pa) => cdp(m, pa, sessionId)
        let premiere = true
        ecoutes.add((m) => {
          if (m.method !== 'Fetch.requestPaused' || m.sessionId !== sessionId) return
          const { requestId, request, resourceType } = m.params
          if (premiere && request.url === ADRESSE && resourceType === 'Document') {
            premiere = false
            S('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body: Buffer.from(pageBornee(html), 'utf8').toString('base64') }).catch(() => {})
          } else if (resourceType === 'Document') {
            // Une navigation demandée par le document (<meta refresh>, lien) : 204, la page imprimée reste la sienne.
            S('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [], body: '' }).catch(() => {})
          } else S('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
        })
        await S('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
        await S('Emulation.setScriptExecutionDisabled', { value: true })
        await S('Page.enable')
        const charge = new Promise((ok) => ecoutes.add((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId && ok()))
        await S('Page.navigate', { url: ADRESSE })
        await charge
        const { data } = await S('Page.printToPDF', {
          paperWidth: 8.27, // A4
          paperHeight: 11.69,
          marginTop: 0.6,
          marginBottom: 0.7,
          marginLeft: 0.6,
          marginRight: 0.6,
          printBackground: true,
          preferCSSPageSize: false,
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate: '<div style="font-size:8px;font-family:sans-serif;color:#777;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        })
        return Buffer.from(data, 'base64')
      })()
      return await Promise.race([travail, delaiDepasse])
    } finally {
      fini = true
      clearTimeout(minuteur)
      try {
        process.kill(-p.pid, 'SIGKILL') // tout le GROUPE du Chromium que l'on vient de lancer (son PID en est le chef)
      } catch {}
      try {
        p.kill('SIGKILL')
      } catch {}
      // Effacer le profil APRÈS la fin du processus (ses enfants pouvaient le recréer : F8) ; un échec ne bloque jamais
      // les exports suivants.
      await Promise.race([sortie, new Promise((r) => setTimeout(r, 3000))])
      try {
        fs.rmSync(profil, { recursive: true, force: true })
      } catch (e) {
        console.error(`[ateliers] profil d'impression non effacé : ${e.message}`)
      }
      occupe = false
    }
  }
  // `dernier()` : le PID (et groupe) du dernier Chromium lancé — pour les essais (aucun processus restant).
  return { imprime, occupe: () => occupe, dernier: () => dernier }
}
