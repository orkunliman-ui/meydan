// Plateau créatif (volet du 13/11) — la carte « image ». Demande (brief du volet, mot pour mot) : « Images insérées et
// annotées : coller / glisser une image sur le plateau → carte image (fichier gardé dans DATA, taille bornée, types image
// seulement, servie derrière la porte de session) ; annoter par-dessus au stylo ; « Envoyer à une console » réutilise la
// barre d'envoi existante (pièce jointe). »
//
// Le fichier : DATA/cartes-images/<id de la carte> (dossier 0700, fichier 0600). Son nom n'est jamais un nom venu du
// navigateur ; ses champs (fichier, mime, largeur, hauteur, octets) ne se posent qu'à la réception, jamais par une demande
// JSON. Ce dossier n'est PAS celui des envois des consoles (DATA/envois/<console>, balayé à 30 jours et à la fermeture
// d'une console) : une image du plateau vit autant que sa carte. Les annotations sont des traits du stylo
// (lib/traits.mjs, support = id de la carte), effacés par lib/cartes.mjs au retrait.
//
// Routes (lib/cartes.mjs remet `reste` = ['image']) :
//   POST /api/envois/cartes/<id>/image   corps brut = l'image (10 Mo au plus). Sous /api/envois/ parce que nginx borne
//                                        les corps à 64 Ko partout ailleurs (deploy/nginx-meydan.example.conf) ; server.mjs la
//                                        remet ici. Le type est reconnu par le CONTENU (octets du début), jamais par le nom
//                                        ni par l'en-tête content-type : PNG, JPEG, GIF, WEBP ; tout le reste (SVG, qui
//                                        peut porter un script, compris) → 415.
//   GET  /api/cartes/<id>/image?v=<fichier>  l'image, sous son type reconnu, `nosniff`, `inline`. `v` = la marque posée
//                                        à la réception (champ `fichier`) : elle ne change qu'avec l'image, pas quand la
//                                        carte est déplacée, agrandie ou renommée (modifieLe), donc le navigateur garde
//                                        l'image en cache tant qu'elle ne change pas.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream'

export const IMAGE_MAX = 10 * 1024 * 1024 // par image (le navigateur réduit d'abord les photos à 2 560 px : envoi.js)
export const DOSSIER_MAX = 500 * 1024 * 1024 // toutes les images du plateau ensemble
// Une image de 10 Mo peut annoncer 30 000 × 30 000 points : décodée, plusieurs Go dans le navigateur (l'iPhone
// tomberait). Bornée ici ; ce que l'interface envoie fait au plus 2 560 px de côté (GIF mis à part).
export const COTE_MAX = 8192
export const PIXELS_MAX = 40e6
// Les types servis, reconnus par leurs octets, et l'extension donnée au nom proposé au navigateur.
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const ID = /^k[0-9a-f]{8}$/
const TEMP = /^\.recu-[0-9a-f]{12}$/
const mo = (n) => `${Math.round(n / 1024 / 1024)} Mo`

// Type et dimensions d'une image, lus dans ses premiers octets (et, pour un JPEG, en sautant de segment en segment
// jusqu'au début de l'image). Rend { mime, largeur, hauteur }, ou null si ce n'est pas une image des quatre types.
async function entete(fichier, taille) {
  const fh = await fs.promises.open(fichier, 'r')
  try {
    const lis = async (pos, n) => {
      const b = Buffer.alloc(n)
      const { bytesRead } = await fh.read(b, 0, n, pos)
      return b.subarray(0, bytesRead)
    }
    const b = await lis(0, 32)
    const latin = (de, a) => b.toString('latin1', de, a)
    // PNG : signature, puis le premier bloc est IHDR (13 octets) : largeur, hauteur.
    if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return b.readUInt32BE(8) === 13 && latin(12, 16) === 'IHDR' ? { mime: 'image/png', largeur: b.readUInt32BE(16), hauteur: b.readUInt32BE(20) } : null
    // GIF : « GIF87a » ou « GIF89a », puis la taille de l'écran logique (celle que le navigateur affiche). Chaque image
    // du fichier (descripteur 0x2C) doit tenir dans cet écran : sinon un écran de 1 × 1 cacherait une image de
    // 30 000 × 30 000 que le navigateur décoderait quand même (relecture du 13/11). Le fichier entier est parcouru
    // (10 Mo au plus) ; un bloc inconnu, ou aucune image, et ce n'est pas un GIF.
    if (b.length >= 13 && (latin(0, 6) === 'GIF87a' || latin(0, 6) === 'GIF89a')) {
      const g = await lis(0, taille)
      const [l, h] = [g.readUInt16LE(6), g.readUInt16LE(8)]
      const table = (octet) => (octet & 0x80 ? 3 * 2 ** ((octet & 0x07) + 1) : 0) // table de couleurs qui suit
      let pos = 13 + table(g[10])
      let images = 0
      // Saute des sous-blocs (une taille, puis autant d'octets) jusqu'au bloc vide ; faux si le fichier s'arrête avant.
      const sousBlocs = () => {
        while (pos < g.length) {
          const n = g[pos]
          pos += 1 + n
          if (!n) return true
        }
        return false
      }
      while (pos < g.length && g[pos] !== 0x3b) {
        if (g[pos] === 0x21) {
          pos += 2 // extension : marque, étiquette, puis ses sous-blocs
          if (!sousBlocs()) break
        } else if (g[pos] === 0x2c) {
          if (pos + 10 > g.length) return null
          if (g.readUInt16LE(pos + 1) + g.readUInt16LE(pos + 5) > l || g.readUInt16LE(pos + 3) + g.readUInt16LE(pos + 7) > h) return null
          images++
          pos += 10 + table(g[pos + 9]) + 1 // descripteur, table locale, taille du code LZW
          if (!sousBlocs()) break // image coupée : le navigateur en montre le début
        } else return null
      }
      return images ? { mime: 'image/gif', largeur: l, hauteur: h } : null
    }
    // WEBP : RIFF….WEBP, puis un bloc VP8 (avec perte), VP8L (sans perte) ou VP8X (étendu).
    if (b.length >= 30 && latin(0, 4) === 'RIFF' && latin(8, 12) === 'WEBP') {
      const bloc = latin(12, 16)
      if (bloc === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: 'image/webp', largeur: b.readUInt16LE(26) & 0x3fff, hauteur: b.readUInt16LE(28) & 0x3fff }
      if (bloc === 'VP8L' && b[20] === 0x2f)
        return { mime: 'image/webp', largeur: 1 + (((b[22] & 0x3f) << 8) | b[21]), hauteur: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) }
      if (bloc === 'VP8X') return { mime: 'image/webp', largeur: 1 + b.readUIntLE(24, 3), hauteur: 1 + b.readUIntLE(27, 3) }
      return null
    }
    // JPEG : FF D8, puis des segments (FF <marque> <longueur>) jusqu'au début d'image SOFn, qui porte hauteur et largeur.
    // SOF0 à SOF15 sauf C4 (tables de Huffman), C8 (réservé) et CC (codage arithmétique).
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      let pos = 2
      for (let n = 0; n < 4000 && pos + 4 <= taille; n++) {
        const s = await lis(pos, 9)
        if (s.length < 4 || s[0] !== 0xff) return null
        const marque = s[1]
        if (marque === 0xff) {
          pos += 1 // octet de remplissage
          continue
        }
        if (marque === 0x01 || (marque >= 0xd0 && marque <= 0xd7)) {
          pos += 2 // marque seule, sans longueur
          continue
        }
        if (marque === 0xd9 || marque === 0xda) return null // fin, ou données de l'image, sans en avoir vu la taille
        // « FF 00 » n'est pas une marque : libjpeg le saute comme du bruit et lirait la taille d'un SOF plus loin
        // (un 1 × 1 annoncé ici, un 30 000 × 30 000 décodé par le navigateur : relecture du 13/11).
        if (marque === 0x00) return null
        const longueur = s.readUInt16BE(2)
        if (longueur < 2) return null
        if (marque >= 0xc0 && marque <= 0xcf && marque !== 0xc4 && marque !== 0xc8 && marque !== 0xcc)
          return s.length >= 9 && longueur >= 7 ? { mime: 'image/jpeg', largeur: s.readUInt16BE(7), hauteur: s.readUInt16BE(5) } : null
        pos += 2 + longueur
      }
    }
    return null
  } finally {
    await fh.close()
  }
}

export function typesImage(ctx) {
  const DIR = path.join(ctx.DATA, 'cartes-images')
  const fichierDe = (id) => {
    if (!ID.test(String(id))) throw ctx.refus('carte invalide') // les id viennent de lib/cartes.mjs ; jamais du client
    return path.join(DIR, id)
  }
  // Cartes retirées (lib/cartes.mjs appelle `retire`) : une réception encore en route pour l'une d'elles n'écrit rien et
  // ne l'annonce pas (sinon le flux ferait réapparaître la carte sur les écrans, et son fichier resterait).
  const parties = new WeakSet()
  // Au démarrage : les réceptions laissées en route par un arrêt brutal sont jetées ; et, si data/cartes.json se lit,
  // les images dont la carte n'existe plus du tout (arrêt entre le retrait d'une carte et l'effacement de son fichier,
  // effacement en échec). Prudent : une carte présente garde son fichier quel que soit son type ou ses champs ; fichier
  // illisible, absent ou d'une autre forme : aucune image n'est effacée.
  let gardees = null
  try {
    const lu = JSON.parse(fs.readFileSync(path.join(ctx.DATA, 'cartes.json'), 'utf8'))
    if (Array.isArray(lu?.cartes)) gardees = new Set(lu.cartes.map((k) => k?.id))
  } catch {}
  for (const n of fs.existsSync(DIR) ? fs.readdirSync(DIR) : [])
    if (TEMP.test(n) || (gardees && ID.test(n) && !gardees.has(n)))
      try {
        fs.rmSync(path.join(DIR, n), { force: true })
      } catch {} // un dossier à ce nom (pas notre œuvre) : laissé, le reste continue

  // Octets déjà pris dans le dossier, sauf l'image que celle-ci remplacera ; les réceptions en route comptent par ce qui
  // leur est promis (`promis`), pas par ce qu'elles ont déjà écrit : deux envois simultanés ne passent pas le plafond.
  let promis = 0
  async function occupe(id) {
    let total = 0
    for (const n of await fs.promises.readdir(DIR).catch(() => [])) {
      if (n === id || TEMP.test(n)) continue
      const st = await fs.promises.lstat(path.join(DIR, n)).catch(() => null)
      if (st?.isFile()) total += st.size
    }
    return total
  }

  // Écrit le corps de la demande dans `dest`, au fil de l'eau, sans jamais dépasser `max` (même façon que `pour` de
  // lib/envois.mjs, non exportée). Au-delà, ou demande coupée : rien n'est laissé, le reste du corps est jeté (jamais
  // `req.destroy()` : server.mjs rend sa réponse pendant que le corps arrive encore, voir `send`).
  function pour(req, dest, max, refusAuDela) {
    return new Promise((resolve, reject) => {
      if (req.destroyed) return reject(ctx.refus('envoi interrompu'))
      const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 })
      let taille = 0
      let fini = false
      const stop = (err) => {
        if (fini) return
        fini = true
        req.unpipe(out)
        out.destroy()
        req.resume()
        fs.rm(dest, { force: true }, () => reject(err))
      }
      req.on('data', (morceau) => {
        taille += morceau.length
        if (taille > max) stop(refusAuDela())
      })
      req.on('error', () => stop(ctx.refus('envoi interrompu')))
      req.on('close', () => !req.complete && stop(ctx.refus('envoi interrompu')))
      out.on('error', (e) => stop(ctx.refus(`écriture impossible (${e.code || 'erreur'})`, 500)))
      out.on('finish', () => {
        if (fini) return
        fini = true
        resolve(taille)
      })
      req.pipe(out)
    })
  }

  // Une panne du disque se dit sans montrer de chemin (le message va au navigateur).
  const ecriture = (e) => ctx.refus(`écriture impossible (${e.code || 'erreur'})`, 500)
  // Reçoit l'image d'une carte : écrite à part, reconnue, puis mise à la place de l'ancienne d'un seul coup (renommage).
  async function recoit(req, k) {
    const annonce = Number(req.headers['content-length'])
    const tropLourde = () => ctx.refus(`image trop lourde : ${mo(IMAGE_MAX)} au plus`, 413)
    if (annonce > IMAGE_MAX) throw tropLourde()
    await fs.promises.mkdir(DIR, { recursive: true, mode: 0o700 }).catch((e) => {
      throw ecriture(e)
    })
    const pris = await occupe(k.id)
    // D'ici à `promis += max`, rien n'attend : une autre réception voit cette promesse.
    const place = DOSSIER_MAX - pris - promis
    const plein = () => ctx.refus(`place des images du plateau pleine (${mo(DOSSIER_MAX)}) : retire des cartes image`, 507)
    if (annonce > place) throw plein()
    const max = Math.max(0, Math.min(IMAGE_MAX, place, annonce >= 0 ? annonce : Infinity))
    promis += max
    const tmp = path.join(DIR, `.recu-${crypto.randomBytes(6).toString('hex')}`)
    try {
      const taille = await pour(req, tmp, max, place < IMAGE_MAX ? plein : tropLourde)
      if (!taille) throw ctx.refus('image vide')
      const e = await entete(tmp, taille).catch((x) => {
        throw ecriture(x)
      })
      if (!e) throw ctx.refus('pas une image PNG, JPEG, GIF ou WEBP', 415)
      if (!(e.largeur >= 1 && e.hauteur >= 1 && e.largeur <= COTE_MAX && e.hauteur <= COTE_MAX && e.largeur * e.hauteur <= PIXELS_MAX))
        throw ctx.refus(`image de ${e.largeur} × ${e.hauteur} points : ${COTE_MAX} de côté et ${PIXELS_MAX / 1e6} millions de points au plus`, 413)
      // De la vérification à l'annonce, rien n'attend : un retrait arrive avant (refus) ou après (il efface le fichier).
      if (parties.has(k)) throw ctx.refus('carte retirée pendant l’envoi', 404)
      try {
        fs.renameSync(tmp, fichierDe(k.id))
      } catch (x) {
        throw ecriture(x)
      }
      Object.assign(k, { fichier: `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, mime: e.mime, largeur: e.largeur, hauteur: e.hauteur, octets: taille })
      // Une nouvelle image : les annotations de l'ancienne n'y correspondent plus (autre dessin, autre repère), elles
      // partent (lib/traits.mjs : flux « trait-retire », ne lève jamais). Lus à l'appel : lib/cartes.mjs les pose après
      // avoir ouvert les modules.
      ctx.retireTraits?.(k.id)
      ctx.majCarte(k)
      return k
    } finally {
      promis -= max
      await fs.promises.rm(tmp, { force: true }) // déjà renommé : rien à faire
    }
  }

  async function sert(res, k, url) {
    const pas = () => ctx.send(res, 404, { error: 'pas d’image sur cette carte' })
    if (!k.fichier || !Object.hasOwn(TYPES, k.mime)) return pas()
    let fh
    try {
      // Jamais à travers un lien ; sans attendre devant un tube nommé (O_NONBLOCK) : seul un vrai fichier est servi.
      fh = await fs.promises.open(fichierDe(k.id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    } catch {
      return pas()
    }
    const st = await fh.stat()
    if (!st.isFile()) {
      await fh.close()
      return pas()
    }
    res.writeHead(200, {
      'content-type': k.mime, // posé par la réception, d'après le contenu, parmi les quatre types
      'content-length': st.size,
      'content-disposition': `inline; filename="${k.id}.${TYPES[k.mime]}"`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // L'adresse porte la marque de l'image (?v=) : une autre image = une autre adresse. Une marque périmée (ou
      // absente) n'est jamais gardée : sinon l'image d'aujourd'hui resterait un an sous l'adresse d'hier.
      'cache-control': url.searchParams.get('v') === k.fichier ? 'private, max-age=31536000, immutable' : 'no-store',
    })
    // Fichier fermé à la fin, ou dès que la liaison se coupe.
    pipeline(fh.createReadStream(), res, () => {})
  }

  return {
    image: {
      taille: { w: 520, h: 400, min: { w: 160, h: 120 } },
      defaut: () => ({ fichier: null, mime: null, largeur: 0, hauteur: 0, octets: 0 }),
      // Rien de propre au type ne se pose par une demande JSON (création ou modification) : les champs du fichier ne
      // viennent que de la réception. Place, taille et titre : lib/cartes.mjs.
      applique() {},
      async api(req, res, url, k, reste) {
        if (reste.length !== 1 || reste[0] !== 'image') return ctx.send(res, 404, { error: 'route inconnue' })
        if (req.method === 'POST') return ctx.send(res, 200, { carte: await recoit(req, k) })
        if (req.method === 'GET') return await sert(res, k, url)
        return ctx.send(res, 405, { error: 'méthode refusée' })
      },
      async retire(k) {
        parties.add(k)
        await fs.promises.rm(fichierDe(k.id), { force: true })
      },
    },
  }
}
