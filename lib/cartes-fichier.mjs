// Plateau créatif (volet du 13/11, Orkun : « On est encore loin de toutes les fonctionnalitēs de Symvibe ») — Carte de
// fichier. Brief du volet : « Cartes de fichiers : choisir un fichier d'un projet (dossiers déjà permis par Meydan,
// `safeDir`) → carte avec nom, taille, aperçu du texte ou de l'image, « Ouvrir » (aperçu en grand), « Télécharger » ».
// Interface : web/src/FichierNode.jsx. Essais : test/volets/plateau-creatif/fichier-api.mjs (serveur), fichier-banc.mjs.
//
// Routes (sous /api/cartes/<id>/, donc derrière la porte de session ; GET seulement, l'écriture passe par le PATCH commun
// de lib/cartes.mjs, contrôlé par `originOk`) :
//   PATCH /api/cartes/<id>            { chemin }  → le fichier choisi (chemin réel) et son instantané { nom, octets, genre }
//   GET   /api/cartes/<id>/parcours?dossier=<chemin absolu>  → { dossier, fil, entrees, reste }
//   GET   /api/cartes/<id>/contenu?apercu=1 | ?apercu=grand  → { nom, octets, modifie, genre, texte?, coupe? }
//   GET   /api/cartes/<id>/contenu[?telecharger=1]           → les octets du fichier
//
// La route /fichier des consoles (server.mjs, GET /api/consoles/<id>/fichier) ne convient pas ici : elle ne sert qu'un
// fichier CITÉ dans la conversation de cette console. Ses exclusions sont reprises par `ctx.fichierPermis`.
//
// ── GARANTIES (pour la relecture de sécurité) ──
// G1. Politique : un chemin n'est montré, listé ou servi que si son chemin RÉEL (fs.realpathSync) passe
//     `ctx.fichierPermis` (sous ~, aucun segment caché, hors compte 2, hors fichiers d'identité, hors données de Meydan)
//     ET la liste locale `SECRET` ci-dessous (en plus, jamais à la place). Seule exception, voulue : le dossier personnel
//     lui-même peut être LISTÉ (le projet « ~ » de /api/projects) ; chacune de ses entrées passe la règle.
// G2. Contrôle À CHAQUE demande (choix, aperçu, contenu, téléchargement), jamais seulement au choix : realpath du chemin
//     enregistré, politique G1, fichier ordinaire (lstat), 100 Mo au plus. Un fichier devenu lien, dossier, tube,
//     disparu ou refusé depuis le choix → 403 / 404 / 409 / 413, aucun octet servi.
// G3. Pas de course entre le contrôle et la lecture : le fichier est ouvert UNE fois (O_NOFOLLOW | O_NONBLOCK : jamais
//     un lien en dernier segment, jamais d'attente sur un tube), puis vérifié SUR LE DESCRIPTEUR : fstat (fichier
//     ordinaire, même inode que le lstat, taille bornée) et /proc/self/fd/<fd> qui doit redonner exactement le chemin
//     contrôlé (un dossier parent remplacé par un lien entre-temps est vu là). Tout est lu et servi depuis ce descripteur,
//     jamais rouvert par son nom. Sans /proc (autre système que Linux), rien n'est servi (409). Un seul code pour cela :
//     `ouvreSur` (exportée, G8).
// G4. Ce qui est servi ne s'exécute jamais sous l'adresse de Meydan : seuls PNG, JPEG, GIF, WEBP (reconnus par leurs
//     premiers octets, pas par l'extension) et PDF (« %PDF- ») partent en `inline` avec leur type ; TOUT le reste (SVG et
//     HTML compris) part en `application/octet-stream` + `attachment`. `?telecharger=1` → toujours `attachment`.
//     Toujours : `x-content-type-options: nosniff`, `content-length` (= la taille lue sur le descripteur ; le flux est
//     borné à elle, et un fichier qui rétrécit en route fait couper la liaison : `envoieFd`), `cache-control: no-store`, `cross-origin-resource-policy: same-origin`, `x-frame-options: DENY`,
//     nom en `filename*=UTF-8''…` (encodeURIComponent, plus « ' ( ) * ») : le nom brut n'entre jamais dans un en-tête.
//     Hors PDF (dont le lecteur du navigateur refuse un bac à sable) : CSP `default-src 'none'; … ; sandbox`.
// G5. L'aperçu (`?apercu=`) est du JSON : `texte` seulement si les premiers octets n'ont aucun octet nul et sont de
//     l'UTF-8 valide (décodage strict, séquence entamée en fin d'extrait retirée) ; 16 Ko pour la carte, 1 Mo pour la
//     vue en grand. L'interface le rend comme texte (React), jamais comme HTML.
// G6. Le parcours d'un dossier : realpath, politique G1 sur le dossier, puis le dossier est OUVERT (O_DIRECTORY |
//     O_NOFOLLOW) et vérifié sur son descripteur comme un fichier (G3 : /proc/self/fd/<fd> = le chemin contrôlé, sinon
//     409) ; ses entrées sont lues et examinées PAR CE DESCRIPTEUR (/proc/self/fd/<fd>/<nom>), jamais en repassant par
//     le nom du dossier : un dossier qui bascule vers un lien sur un dossier caché ne fait lister ni nom ni taille de ce
//     dernier. Entrées cachées OMISES, entrées refusées OMISES (politique sur <chemin contrôlé>/<nom> ET, pour un lien,
//     sur le chemin réel de sa cible), liens cassés ou vers autre chose qu'un dossier ou un fichier ordinaire omis ; la
//     taille d'un lien n'est jamais donnée ; 5 000 entrées LUES au plus (`tronque`), 500 rendues (dossiers puis
//     fichiers), « reste » = le compte des suivantes parmi les lues ; un nom piégé (contrôle, inversion du sens
//     d'écriture) a son `affiche` nettoyé, le nom brut ne sert qu'au chemin.
// G7. Entrées : `chemin` et `dossier` = chaîne, absolu, 1 000 caractères au plus, sans octet nul ; chemin réel de 1 000
//     caractères au plus. Ce qui est enregistré : chemin réel, nom (caractères de contrôle et de mise en forme Unicode
//     remplacés), taille, genre — la carte entière tient en ~4 Ko au pire. Champs inconnus ignorés. Aucune commande lancée.
// G8. Exportées pour les autres usages de fichierPermis (route /fichier des consoles de server.mjs), le même code que
//     les cartes : `ouvreSur(chemin, fichierPermis, { max, choix })` → { fd, reel, st } (G2 + G3 ; l'appelant ferme fd) et
//     `envoieFd(res, fd, taille)` (envoie depuis fd, le ferme dans tous les cas, coupe la liaison si le fichier rétrécit).
// NE GARANTIT PAS :
// N1. Un lien DUR posé dans un projet vers un fichier secret (même propriétaire, même disque) a un chemin réel permis :
//     il serait servi. Le poser suppose déjà d'écrire dans le projet sous le compte de Meydan (un agent qui le peut peut aussi
//     copier le secret) ; la carte n'ajoute pas ce pouvoir, mais ne le détecte pas (nlink > 1 n'est pas refusé : pnpm).
// N2. Un secret rangé dans un fichier visible au nom ordinaire (`notes.txt` qui contient une clé) est montré : la
//     politique porte sur les chemins, pas sur le contenu. `SECRET` ne rattrape que les noms usuels.
// N3. Le dossier personnel est listable (noms de ses dossiers visibles, sauf cachés et refusés).
// N4. Les autres dossiers de données de Meydan (copies de travail des volets : data/access.key…) ne sont pas les
//     « données de Meydan » de CE serveur pour fichierPermis ; ils tombent sous `SECRET` (*.key), pas leurs autres fichiers.
// N5. Les codes de refus (404 introuvable, 403 refusé) disent à une session ouverte si un chemin caché EXISTE (jamais
//     son contenu ni la liste d'un dossier caché).
// N6. Pour une entrée du parcours qui est un LIEN, sa cible est résolue puis examinée par son chemin réel (lstat, sans
//     suivre son dernier segment) : pendant une bascule, cela peut dire si un objet caché est un dossier ou un fichier
//     (un bit), jamais son nom ni sa taille.
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const OCTETS_MAX = 100 * 1024 * 1024
const CHEMIN_MAX = 1000
const APERCU = 16 * 1024 // aperçu de la carte
const APERCU_GRAND = 1024 * 1024 // « Ouvrir » : le texte en grand
const ENTREES_MAX = 500 // entrées rendues par le parcours
const LECTURE_MAX = 5000 // entrées lues au plus : un dossier de 200 000 entrées ne fige pas le serveur (tri compris)
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants

// En plus de fichierPermis (jamais à la place) : les noms usuels de clés et d'identifiants, refusés même hors d'un
// dossier caché, sur CHAQUE segment du chemin sous ~ (un dossier « secrets/ » cache tout ce qu'il contient).
// Clés SSH privées, certificats et coffres (.pem .key .p12 .pfx .jks .keystore .ppk .kdbx), fichiers .env nommés
// (`prod.env`), tout nom qui contient secret, credential, service-account, htpasswd ; et les fichiers sensibles d'un
// AUTRE dossier de données de Meydan (copie de travail d'un volet) sous un nom sans « .key » : `hook.header` (la clé des
// hooks), `vapid.json` (la clé des notifications), le dossier `jetons/`.
const SECRET = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$|\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|env)$|secret|credential|service[-_]?account|htpasswd|^hook\.header$|^vapid\.json$|^jetons?$/i

// Signatures reconnues par le contenu (premiers octets), jamais par l'extension.
const SIGNATURES = [
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/gif', Buffer.from('GIF87a', 'latin1')],
  ['image/gif', Buffer.from('GIF89a', 'latin1')],
  ['application/pdf', Buffer.from('%PDF-', 'latin1')],
]
function typeDe(b) {
  for (const [type, sig] of SIGNATURES) if (b.length >= sig.length && b.subarray(0, sig.length).equals(sig)) return type
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}
// La fin d'un extrait UTF-8 : une séquence entamée (coupée par la borne de lecture) est retirée.
function finUtf8(b) {
  let i = b.length - 1
  let suite = 0
  while (i >= 0 && suite < 3 && (b[i] & 0xc0) === 0x80) {
    i--
    suite++
  }
  if (i < 0) return b.length
  const t = b[i]
  const long = t < 0x80 ? 1 : (t & 0xe0) === 0xc0 ? 2 : (t & 0xf0) === 0xe0 ? 3 : (t & 0xf8) === 0xf0 ? 4 : 1
  return i + long > b.length ? i : b.length
}
// Le texte d'un extrait, ou null : aucun octet nul, UTF-8 strictement valide (`complet` : l'extrait est tout le fichier,
// rien n'est retiré à la fin).
function texteDe(b, complet) {
  if (b.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(complet ? b : b.subarray(0, finUtf8(b)))
  } catch {
    return null
  }
}
const GENRE = { 'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image', 'application/pdf': 'pdf' }
const genreDe = (b, complet) => GENRE[typeDe(b)] || (texteDe(b, complet) === null ? 'autre' : 'texte')
// Genre d'une entrée du parcours, d'après son extension (simple indice pour l'icône : aucun fichier n'est ouvert).
const genreParNom = (nom) =>
  /\.(png|jpe?g|gif|webp)$/i.test(nom)
    ? 'image'
    : /\.pdf$/i.test(nom)
      ? 'pdf'
      : /\.(txt|md|markdown|json|jsonl|[cm]?js|jsx|tsx?|css|scss|html?|xml|svg|ya?ml|toml|ini|conf|cfg|sh|bash|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|sql|csv|tsv|log|lock)$/i.test(nom)
        ? 'texte'
        : 'autre'
// Nom affiché : caractères de contrôle et de mise en forme (dont les inversions de sens d'écriture) remplacés.
const nomPropre = (s) => String(s).replace(/[\p{Cc}\p{Cf}]/gu, String.fromCharCode(0xfffd)).slice(0, 255)
// `filename*` (RFC 5987) : encodeURIComponent laisse passer « ' ( ) * », qui n'y sont pas permis.
const nomEnTete = (nom) => encodeURIComponent(nom).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const tri = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

const INTROUVABLE = 'fichier introuvable (déplacé ou supprimé ?)'
const CHANGE = 'le fichier a changé pendant la lecture : réessaie'
const CHANGE_DOSSIER = 'le dossier a changé pendant la lecture : réessaie'
// Une erreur dont `code` est le statut HTTP à rendre (comme `refus` de lib/cartes.mjs) ; jamais de chemin du disque dedans.
const erreur = (message, code = 400) => Object.assign(new Error(message), { code })
// Le chemin réel de ce qui est ouvert sous ce descripteur (Linux : /proc/self/fd/<fd>), ou null.
function vraiChemin(fd) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`)
  } catch {
    return null
  }
}
// G7 : un chemin demandé.
function valide(v, quoi = 'chemin') {
  if (typeof v !== 'string' || !path.isAbsolute(v)) throw erreur(`${quoi} : un chemin absolu est attendu`)
  if (v.length > CHEMIN_MAX) throw erreur(`${quoi} trop long : ${CHEMIN_MAX} caractères au plus`)
  if (v.includes('\0')) throw erreur(`${quoi} : caractère nul refusé`)
  return v
}

// G2 + G3 — LE seul accès au contenu d'un fichier, ici et pour la route /fichier des consoles (server.mjs) :
//   ouvreSur(chemin, fichierPermis, { max = 100 Mo, choix = false }) → { fd, reel, st }
// `fichierPermis(reel)` rend '' si ce chemin RÉEL peut être montré, sinon la raison. `choix` : un dossier ou un tube est
// une demande fautive (400) plutôt qu'un fichier disparu (404). Lève une erreur dont `code` est le statut (400, 403, 404,
// 409, 413 ; 500 sans politique), au message sans chemin du disque. L'APPELANT FERME `fd` : fs.closeSync(fd), ou
// envoieFd ci-dessous, qui le ferme dans tous les cas. Il lit et sert depuis `fd`, jamais en rouvrant `reel` par son nom.
export function ouvreSur(chemin, fichierPermis, { max = OCTETS_MAX, choix = false } = {}) {
  valide(chemin)
  if (typeof fichierPermis !== 'function') throw erreur('politique des fichiers absente', 500)
  let reel
  try {
    reel = fs.realpathSync(chemin)
  } catch {
    throw erreur(INTROUVABLE, 404)
  }
  if (reel.length > CHEMIN_MAX) throw erreur(`chemin réel trop long : ${CHEMIN_MAX} caractères au plus`)
  const raison = fichierPermis(reel)
  if (raison) throw erreur(`fichier refusé : ${raison}`, 403)
  let st
  try {
    st = fs.lstatSync(reel)
  } catch {
    throw erreur(INTROUVABLE, 404)
  }
  if (st.isSymbolicLink()) throw erreur(CHANGE, 409) // devenu lien depuis le realpath
  if (!st.isFile()) throw erreur(st.isDirectory() ? 'c’est un dossier, pas un fichier' : 'pas un fichier ordinaire', choix ? 400 : 404)
  const trop = `fichier de plus de ${Math.round(max / 1024 / 1024)} Mo`
  if (st.size > max) throw erreur(trop, 413)
  let fd
  try {
    fd = fs.openSync(reel, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    throw e.code === 'EACCES' ? erreur('fichier illisible (droits)', 403) : e.code === 'ELOOP' ? erreur(CHANGE, 409) : erreur(INTROUVABLE, 404)
  }
  try {
    const f = fs.fstatSync(fd)
    // Ce qui est ouvert est bien ce qui a été contrôlé : même inode que le lstat, et le chemin réel du descripteur.
    if (!f.isFile() || f.dev !== st.dev || f.ino !== st.ino || vraiChemin(fd) !== reel) throw erreur(CHANGE, 409)
    if (f.size > max) throw erreur(trop, 413)
    return { fd, reel, st: f }
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
}

// Envoie `taille` octets lus sur `fd` (l'appelant a écrit les en-têtes, content-length = taille) et FERME `fd` dans
// tous les cas : fin normale, client qui raccroche (pipeline détruit le flux, autoClose ferme), erreur de lecture. Un
// fichier qui a rétréci en route (moins d'octets lus que `taille`) fait couper la liaison (res.destroy) : le client voit
// une réponse incomplète au lieu d'attendre la fin du keep-alive. La réponse n'est terminée (res.end) qu'APRÈS ce
// compte : terminée d'abord, elle serait détachée de sa liaison, que res.destroy ne fermerait plus (mesuré : 6 s).
export async function envoieFd(res, fd, taille) {
  if (!taille) {
    fs.closeSync(fd)
    return res.end()
  }
  let flux
  try {
    flux = fs.createReadStream(null, { fd, start: 0, end: taille - 1, autoClose: true })
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
  try {
    await pipeline(flux, res, { end: false })
    if (flux.bytesRead === taille) res.end()
    else res.destroy()
  } catch {
    res.destroy() // le client a raccroché, ou la lecture a échoué : rien d'autre à faire, le descripteur est fermé
  }
}

export function typesFichier(ctx) {
  const { HOME } = ctx
  const secretDe = (reel) =>
    reel.startsWith(HOME + path.sep) && reel.slice(HOME.length + 1).split(path.sep).some((s) => SECRET.test(s)) ? 'nom de fichier de clé ou d’identifiant' : ''
  // G1 : la politique de Meydan, puis la liste locale.
  const permis = (reel) => ctx.fichierPermis(reel) || secretDe(reel)
  const dossierPermis = (reel) => (reel === HOME ? '' : permis(reel))

  // G2 + G3 : ouvreSur avec la politique des cartes (fichierPermis + SECRET). L'appelant ferme `fd`.
  const ouvre = (chemin, choix = false) => ouvreSur(chemin, permis, { choix })
  // Les premiers octets (au plus n) d'un fichier ouvert.
  function tete(fd, n) {
    const b = Buffer.alloc(n)
    let lu = 0
    while (lu < n) {
      const k = fs.readSync(fd, b, lu, n - lu, lu)
      if (!k) break
      lu += k
    }
    return b.subarray(0, lu)
  }

  // GET …/parcours?dossier= (G6).
  async function parcours(res, url) {
    const demande = valide(url.searchParams.get('dossier') ?? '', 'dossier')
    let reel
    try {
      reel = fs.realpathSync(demande)
    } catch {
      throw erreur('dossier introuvable', 404)
    }
    if (reel.length > CHEMIN_MAX) throw erreur(`chemin réel trop long : ${CHEMIN_MAX} caractères au plus`)
    const raison = dossierPermis(reel)
    if (raison) throw erreur(`dossier refusé : ${raison}`, 403)
    let fd
    try {
      fd = fs.openSync(reel, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK)
    } catch (e) {
      // « pas un dossier » seulement pour un fichier qui est là ; un lien posé entre le realpath et l'ouverture (ELOOP, ou
      // ENOTDIR : O_DIRECTORY passe avant O_NOFOLLOW), ou un dossier qui a bougé entre-temps → 409.
      const l = fs.lstatSync(reel, { throwIfNoEntry: false })
      if (e.code === 'EACCES') throw erreur('dossier illisible', 403)
      if (e.code === 'ENOENT') throw erreur('dossier introuvable', 404)
      if (e.code === 'ENOTDIR' && l && !l.isDirectory() && !l.isSymbolicLink()) throw erreur('pas un dossier')
      throw erreur(CHANGE_DOSSIER, 409)
    }
    try {
      if (vraiChemin(fd) !== reel) throw erreur(CHANGE_DOSSIER, 409)
      // Toute lecture passe par le dossier OUVERT : /proc/self/fd/<fd> désigne ce dossier-là, pas un nom.
      const ici = `/proc/self/fd/${fd}`
      let dir
      try {
        dir = await fs.promises.opendir(ici, { bufferSize: 128 })
      } catch {
        throw erreur('dossier illisible', 403)
      }
      const vus = []
      let lues = 0
      let tronque = false
      for await (const d of dir) {
        if (++lues > LECTURE_MAX) {
          tronque = true
          break // ferme `dir`
        }
        const nom = d.name
        if (nom.startsWith('.') || permis(path.join(reel, nom))) continue // caché ou refusé : omis
        if (d.isDirectory()) vus.push({ nom, type: 'dossier' })
        else if (d.isFile()) vus.push({ nom, type: 'fichier' })
        else if (d.isSymbolicLink()) {
          // Un lien : sa cible est contrôlée comme un chemin demandé ; cassé, refusé ou ni dossier ni fichier → omis.
          try {
            const cible = await fs.promises.realpath(path.join(ici, nom))
            const st = await fs.promises.lstat(cible)
            if (st.isDirectory() && !dossierPermis(cible)) vus.push({ nom, type: 'dossier', lien: true })
            else if (st.isFile() && !permis(cible)) vus.push({ nom, type: 'fichier', lien: true })
          } catch {}
        }
      }
      vus.sort((a, b) => (a.type === b.type ? tri.compare(a.nom, b.nom) : a.type === 'dossier' ? -1 : 1))
      const entrees = []
      for (const e of vus.slice(0, ENTREES_MAX)) {
        const o = { nom: e.nom, type: e.type }
        if (nomPropre(e.nom) !== e.nom) o.affiche = nomPropre(e.nom)
        if (e.lien) o.lien = true
        if (e.type === 'fichier') {
          o.genre = genreParNom(e.nom)
          if (!e.lien) {
            // La taille, lue DANS le dossier ouvert, sans suivre de lien (une entrée devenue lien entre-temps est omise).
            // Celle d'un lien n'est jamais donnée.
            try {
              const st = await fs.promises.lstat(path.join(ici, e.nom))
              if (!st.isFile()) continue
              o.octets = st.size
            } catch {
              continue // partie entre-temps
            }
          }
        }
        entrees.push(o)
      }
      // Le fil d'Ariane, de ~ au dossier : chaque étape est un dossier permis (les parents d'un chemin permis le sont).
      const fil = [{ nom: '~', chemin: HOME }]
      if (reel !== HOME) {
        let c = HOME
        for (const s of reel.slice(HOME.length + 1).split(path.sep)) fil.push({ nom: s, chemin: (c = path.join(c, s)), ...(nomPropre(s) !== s ? { affiche: nomPropre(s) } : {}) })
      }
      return ctx.send(res, 200, { dossier: reel, fil, entrees, reste: Math.max(0, vus.length - ENTREES_MAX), ...(tronque ? { tronque: true } : {}) })
    } finally {
      fs.closeSync(fd)
    }
  }

  // GET …/contenu (G2 à G5).
  async function contenu(req, res, url, k) {
    if (!k.chemin) throw erreur('aucun fichier choisi sur cette carte', 404)
    const { fd, reel, st } = ouvre(k.chemin)
    const apercu = url.searchParams.get('apercu')
    if (apercu) {
      let corps
      try {
        const debut = tete(fd, Math.min(APERCU, st.size))
        const genre = genreDe(debut, debut.length >= st.size)
        corps = { nom: nomPropre(path.basename(reel)), octets: st.size, modifie: Math.round(st.mtimeMs), genre }
        if (genre === 'texte') {
          let b = debut
          if (apercu === 'grand' && st.size > debut.length) {
            // Plus loin que les 16 Ko, le fichier peut cesser d'être du texte (octet nul, binaire collé) : on garde alors les 16 Ko.
            const g = tete(fd, Math.min(APERCU_GRAND, st.size))
            if (texteDe(g, g.length >= st.size) !== null) b = g
          }
          corps.texte = texteDe(b, b.length >= st.size)
          corps.coupe = b.length < st.size
        }
      } finally {
        fs.closeSync(fd)
      }
      return ctx.send(res, 200, corps)
    }
    let type
    try {
      type = typeDe(tete(fd, Math.min(16, st.size)))
    } catch (e) {
      fs.closeSync(fd)
      throw e
    }
    const enLigne = type && url.searchParams.get('telecharger') !== '1'
    res.writeHead(200, {
      'content-type': type || 'application/octet-stream',
      'content-length': st.size,
      'content-disposition': `${enLigne ? 'inline' : 'attachment'}; filename*=UTF-8''${nomEnTete(path.basename(reel))}`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
      'x-frame-options': 'DENY',
      ...(type === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }),
    })
    // Lu sur le descripteur contrôlé, borné à la taille annoncée ; fermé quand le flux finit ou est coupé.
    await envoieFd(res, fd, st.size)
  }

  return {
    fichier: {
      taille: { w: 420, h: 320, min: { w: 260, h: 160 } },
      defaut: () => ({ chemin: '', nom: '', octets: 0, genre: '' }),
      // `chemin` : le fichier choisi (« » : aucun). Enregistré par son chemin réel, avec l'instantané que la tuile du
      // téléphone affiche sans rien demander.
      applique(k, corps) {
        if (corps.chemin === undefined) return
        if (corps.chemin === '' || corps.chemin === null) return Object.assign(k, { chemin: '', nom: '', octets: 0, genre: '' })
        const { fd, reel, st } = ouvre(corps.chemin, true)
        try {
          const debut = tete(fd, Math.min(APERCU, st.size))
          Object.assign(k, { chemin: reel, nom: nomPropre(path.basename(reel)), octets: st.size, genre: genreDe(debut, debut.length >= st.size) })
        } finally {
          fs.closeSync(fd)
        }
      },
      async api(req, res, url, k, reste) {
        if (reste.length === 1 && (reste[0] === 'parcours' || reste[0] === 'contenu')) {
          if (req.method !== 'GET') return ctx.send(res, 405, { error: 'méthode refusée' })
          return reste[0] === 'parcours' ? await parcours(res, url) : await contenu(req, res, url, k)
        }
        return ctx.send(res, 404, { error: 'route inconnue' })
      },
    },
  }
}
