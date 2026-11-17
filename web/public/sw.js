// Service worker de Meydan : notifications seulement (aucun cache, aucune interception des requêtes).
// Toucher une notification ramène Meydan à l'écran, sur la console qui attend.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { body: e.data ? e.data.text() : '' }
  }
  // L'iPhone coupe l'abonnement d'un site qui reçoit un message sans afficher de notification : toujours en afficher une.
  e.waitUntil(self.registration.showNotification(d.title || 'Meydan', { body: d.body || '', tag: d.tag || undefined, data: { ouvre: typeof d.ouvre === 'string' ? d.ouvre : '' } }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const ouvre = /^c[0-9a-f]{8}$/.test((e.notification.data && e.notification.data.ouvre) || '') ? e.notification.data.ouvre : ''
  e.waitUntil(
    (async () => {
      const fenetres = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const f of fenetres) {
        try {
          await f.focus()
          if (ouvre) f.postMessage({ ouvre }) // l'appli ouvre la console sans se recharger
          return
        } catch {
          // fenêtre que ce service worker ne peut pas ramener : on en ouvre une
        }
      }
      await self.clients.openWindow(ouvre ? `/?ouvre=${ouvre}` : '/')
    })(),
  )
})
