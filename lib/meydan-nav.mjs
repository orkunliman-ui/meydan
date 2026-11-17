// `meydan nav …` (bin/meydan) : le navigateur de cette console, piloté par son agent (volet « copies », 13/11 ; moteur :
// lib/navigateur.mjs). Marche pour Claude et Codex, avec le jeton de console déjà posé par Meydan.
// Reçoit les arguments après « nav », et { appel(method, chemin, corps), fin(message, code) } de bin/meydan.
// Codes de sortie : 0 fait ; 1 refusé par Meydan (message dit pourquoi) ; 2 commande mal écrite.
// Les textes rendus (titre, adresse, texte de la page, journal) sont déjà nettoyés par le serveur : ni caractère de
// contrôle ni séquence d'échappement, longueur bornée. Ils le sont une seconde fois ici avant d'être écrits (`net`).
import { NOM } from './nom.mjs'

export const AIDE_NAV = `meydan nav — le navigateur de cette console (sans écran, sur le VPS ; ${NOM} voit sa page sur le plateau)
Seulement http://localhost:<port>/…, http://127.0.0.1:<port>/… ou http://[::1]:<port>/… (port écrit en entier, ni celui
de Meydan ni un port de service), et seulement les ports que tu as ouverts ou permis : tout le reste est refusé, y
compris ce que la page charge elle-même.

  meydan nav ouvre <url>                    ouvrir une page (lance le navigateur au besoin ; son port devient permis)
  meydan nav permet <port>                  permettre un autre port à la page (ex. son API sur 3000), pour ce navigateur
  meydan nav capture                        capture d'écran PNG ; rend le chemin du fichier (lisible par toi)
  meydan nav clique <sélecteur CSS>         clic réel au milieu du premier élément qui correspond
  meydan nav tape <sélecteur CSS> <texte>   remplace le contenu du champ par ce texte (frappe réelle)
  meydan nav texte                          le texte visible de la page
  meydan nav console [mot]                  journal de la page : console, erreurs, requêtes et connexions refusées
                                            (avec un mot : seulement les entrées qui le contiennent, ex. « refus »)
  meydan nav etat                           page ouverte, titre
  meydan nav ferme                          fermer le navigateur (sinon il se ferme seul après 10 min sans commande)`

const usage = (ligne) => `usage : meydan nav ${ligne}`
// Seconde barrière : aucun caractère de contrôle (ESC, BEL, C1…) n'atteint le terminal de l'agent, hors retour de ligne et tabulation.
const net = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
const quand = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`
}
const page = (r) => `${net(r.url) || 'about:blank'}${r.titre ? ` — « ${net(r.titre)} »` : ''}`

export async function nav(a, { appel, fin }) {
  const [sous, ...reste] = a
  if (!sous || sous === 'aide' || sous === '--help' || sous === '-h') {
    console.log(AIDE_NAV)
    return
  }
  if (sous === 'ouvre') {
    if (reste.length !== 1) fin(usage('ouvre <url>'), 2)
    const r = await appel('POST', 'nav/ouvre', { url: reste[0] })
    console.log(`ouvert : ${page(r)}${r.charge === false ? ' (la page n’avait pas fini de charger après 20 s)' : ''}`)
  } else if (sous === 'capture') {
    if (reste.length) fin(usage('capture'), 2)
    const r = await appel('POST', 'nav/capture')
    console.log(`capture enregistrée : ${net(r.chemin)} (${Number(r.largeur)} × ${Number(r.hauteur)} px, ${Math.max(1, Math.round(Number(r.octets) / 1024))} Ko)`)
  } else if (sous === 'clique') {
    if (reste.length < 1) fin(usage('clique <sélecteur CSS>'), 2)
    const r = await appel('POST', 'nav/clique', { selecteur: reste.join(' ') })
    console.log(`cliqué : ${net(r.element)}${r.couvert ? ' (attention : un autre élément le recouvrait à cet endroit)' : ''}`)
    if (r.navigation) console.log(`page : ${page(r)}${r.charge === false ? ' (pas fini de charger après 20 s)' : ''}`)
  } else if (sous === 'tape') {
    if (reste.length < 2) fin(usage('tape <sélecteur CSS> <texte>'), 2)
    const r = await appel('POST', 'nav/tape', { selecteur: reste[0], texte: reste.slice(1).join(' ') })
    console.log(`tapé : ${Number(r.caracteres)} caractère(s) dans ${net(r.element)}`)
    if (r.navigation) console.log(`page : ${page(r)}`)
  } else if (sous === 'texte') {
    if (reste.length) fin(usage('texte'), 2)
    const r = await appel('GET', 'nav/texte')
    console.log(`${page(r)}\n\n${net(r.texte) || '(aucun texte visible)'}`)
  } else if (sous === 'console') {
    if (reste.length > 1) fin(usage('console [mot]'), 2)
    const r = await appel('GET', `nav/console${reste[0] ? `?filtre=${encodeURIComponent(reste[0])}` : ''}`)
    if (r.omises) console.log(`(${r.omises} entrée(s) plus ancienne(s) omise(s))`)
    console.log(r.lignes.length ? r.lignes.map(net).join('\n') : '(journal vide)')
  } else if (sous === 'etat') {
    if (reste.length) fin(usage('etat'), 2)
    const r = await appel('GET', 'nav')
    console.log(r.ouvert ? `ouvert depuis ${quand(r.depuis)} : ${page(r)}` : `aucun navigateur ouvert pour cette console${r.ferme ? ` (le dernier s’est fermé : ${net(r.ferme)})` : ''}`)
    if (r.ports?.length) console.log(`ports permis : ${r.ports.map(Number).join(', ')}`)
  } else if (sous === 'permet') {
    if (reste.length !== 1 || !/^\d{1,5}$/.test(reste[0])) fin(usage('permet <port>'), 2)
    const r = await appel('POST', 'nav/permet', { port: Number(reste[0]) })
    console.log(`ports permis à ce navigateur : ${r.ports.map(Number).join(', ')}`)
  } else if (sous === 'ferme') {
    if (reste.length) fin(usage('ferme'), 2)
    const r = await appel('POST', 'nav/ferme')
    console.log(r.ferme ? 'navigateur fermé' : 'aucun navigateur ouvert pour cette console')
  } else fin(`sous-commande inconnue : ${sous}\n\n${AIDE_NAV}`, 2)
}
