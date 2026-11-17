#!/usr/bin/env python3
"""Police d'interface « Iosevka UI » : un sous-ensemble d'Iosevka 400 et 700 pour tout ce que l'interface écrit en
`--mono` (étiquettes de la liste, âges, chemins, boutons, musique, code de la discussion), sans les 2 Mo de l'Iosevka
complète.

Pourquoi : l'audit de réactivité du 11/11 (`test/chasse-2026-11-11/reactivite/report.md`, point 7) a mesuré que les
deux fichiers de `@fontsource/iosevka` (984 Ko et 988 Ko en woff2) partaient dès l'ouverture de la liste sur l'iPhone,
alors que l'Iosevka complète ne sert vraiment qu'au terminal. Le fichier complet porte 29 912 glyphes : 5 706 caractères
plus leurs variantes de style (cv01…cv98, ss01…ss20, ligatures propres à chaque langage), que la page ne demande jamais.

Ce que garde le sous-ensemble, pour que l'écran ne change pas d'un pixel :
- les dessins, les chasses et les métriques verticales d'origine (rien n'est recalculé) ;
- les instructions de rendu (hinting ttfautohint, tables cvt/fpgm/prep/gasp), pour les moteurs qui s'en servent.
  CoreText (iPhone, Mac) n'applique pas le hinting : le rendu y est celui des contours, identiques. Sous Linux,
  l'auto-hinter de FreeType range chaque glyphe d'après la cmap et le GSUB de toute la police : une police réduite
  change ce rangement pour une partie des glyphes (écarts d'anticrénelage mesurés au banc, nuls sans hinting) ;
- les fonctions OpenType qu'un navigateur applique d'office (HarfBuzz et CoreText) et que la police porte : `calt`
  (ses ligatures `->`, `=>`, `!=`… sont dans `calt`), `ccmp`, `mark`, `mkmk`. Son `locl` ne vaut que pour le cyrillique
  bulgare, macédonien et serbe : il part avec le cyrillique. Les autres fonctions de la liste par défaut des navigateurs
  (`liga`, `clig`, `kern`, `rlig`, `rclt`, `rvrn`, `curs`) sont absentes de la police d'origine. Rien dans l'interface
  ne demande de fonction facultative (aucun `font-feature-settings` ni `font-variant-*`) ;
- le copyright et la licence (noms 0 à 6, 13 et 14) : SIL Open Font License 1.1, sans nom de police réservé, d'où le
  droit de garder « Iosevka » dans le nom de la famille CSS.

Entrée : les WOFF (zlib) de `@fontsource/iosevka` 5.3.0 (Iosevka 22.1.2). Sortie : du WOFF (zlib), parce que ce
Python n'a pas brotli (ni lecture ni écriture de woff2). La CSP du serveur interdit les `data:` pour les polices : les
fichiers sont servis à part (`assetsInlineLimit: 0` dans `vite.config.js`), comme les autres polices de `web/src/fonts/`.

Usage : python3 scripts/police-ui.py   (relancer après une mise à jour de `@fontsource/iosevka` ; le résultat est le
même octet pour octet tant que l'entrée et fontTools ne changent pas : empreintes affichées à la fin).
"""
import hashlib
import io
import os
import sys

from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(RACINE, 'node_modules/@fontsource/iosevka/files/iosevka-latin-{}-normal.woff')
SORTIE = os.path.join(RACINE, 'web/src/fonts/IosevkaUI-{}.woff')
GRAISSES = {'400': 'Regular', '700': 'Bold'}  # les seules importées avant (main.jsx) : 500 tombe sur 400, 600 sur 700

# Plages gardées : tout ce qu'un agent écrit dans une discussion (code, tableaux, cadres, flèches, coches), ce qu'Orkun
# tape dans un nom (français, turc), et ce que les outils en ligne de commande affichent. Seuls les caractères que
# l'Iosevka dessine vraiment sont gardés (intersection avec sa table cmap).
PLAGES = [
    (0x0020, 0x007E, 'latin de base (ASCII imprimable)'),
    (0x00A0, 0x00FF, 'latin-1 : accents du français, ç ö ü du turc, « », °, ±, ×, ·'),
    (0x0100, 0x017F, 'latin étendu A : ğ ı İ ş du turc, œ, langues d’Europe centrale'),
    (0x0180, 0x024F, 'latin étendu B'),
    (0x02B0, 0x02FF, 'lettres modificatives : ˆ ˇ ˘ ˜ ʼ'),
    (0x0300, 0x036F, 'diacritiques combinants : accents décomposés (noms de fichiers venus d’un Mac)'),
    (0x0370, 0x03FF, 'grec : λ π Δ Σ Ω µ du code et des formules'),
    (0x1E00, 0x1EFF, 'latin étendu additionnel : ẞ, vietnamien'),
    (0x2000, 0x206F, 'ponctuation générale : – — ‘ ’ “ ” • … ‰ ′ ″ ‹ ›'),
    (0x2070, 0x209F, 'exposants et indices'),
    (0x20A0, 0x20CF, 'monnaies : € ₺ ₿'),
    (0x20D0, 0x20FF, 'signes combinants pour symboles (touche ⃣)'),
    (0x2100, 0x214F, 'symboles de lettres : ™ ℃ № ℹ'),
    (0x2150, 0x218F, 'formes numérales : ⅓ ⅔ Ⅻ'),
    (0x2190, 0x21FF, 'flèches : ← → ↑ ↓ ↔ ⇒ ↵'),
    (0x2200, 0x22FF, 'opérateurs mathématiques : ≤ ≥ ≠ ≈ ∞ √ ∑ ∈ ∀'),
    (0x2300, 0x23FF, 'technique : ⌘ ⌥ ⌫ ⏎ ⎿ ⏺ ⏵ ⏸ (Claude Code, Codex)'),
    (0x2400, 0x243F, 'images de contrôle : ␣ ␤'),
    (0x2460, 0x24FF, 'alphanumériques cerclés : ① ② ⓘ'),
    (0x2500, 0x257F, 'cadres : ─ │ ┌ ┐ └ ┘ ├ ┼ ╭ ╰ ═'),
    (0x2580, 0x259F, 'blocs : █ ▓ ▒ ░ ▌ ▁ (barres de progression)'),
    (0x25A0, 0x25FF, 'formes géométriques : ■ □ ▲ ▶ ▸ ● ○ ◆ ◇'),
    (0x2600, 0x26FF, 'symboles divers : ☐ ☑ ★ ☆ ⚠ ⚡ ♥'),
    (0x2700, 0x27BF, 'dingbats : ✓ ✔ ✗ ✘ ✶ ✻ ✳ ❯ ➜'),
    (0x27C0, 0x27FF, 'mathématiques divers A, flèches supplémentaires A : ⟨ ⟩ ⟶'),
    (0x2800, 0x28FF, 'braille : ⠋ ⠙ ⠹ (indicateurs de travail des outils en ligne de commande)'),
    (0x2900, 0x2AFF, 'flèches supplémentaires B, mathématiques divers B, opérateurs supplémentaires'),
    (0x2B00, 0x2BFF, 'symboles et flèches divers : ⬆ ⬇ ⬤ ⭐'),
    (0x2E00, 0x2E7F, 'ponctuation supplémentaire'),
    (0xE000, 0xF8FF, 'zone privée : symboles Powerline et barres de progression propres à Iosevka'),
    (0xFB00, 0xFB4F, 'ligatures typographiques : ﬁ ﬂ'),
    (0xFFF0, 0xFFFF, 'caractère de remplacement �'),
    (0x1F300, 0x1F6FF, 'les treize émojis qu’Iosevka dessine (🌑…🌘, 🙂 🙃 🙁 😐 😶) : ils gardent son dessin'),
]
# Écartés exprès (dessinés par l'Iosevka complète, jugés trop rares pour leur poids) : alphabet phonétique (IPA),
# cyrillique (~21 Ko par graisse), grec polytonique, latin étendu C à F, lettres mathématiques (𝐀 𝑥), symboles de
# l'informatique ancienne (U+1FB00), alchimie et flèches C (U+1F700-1F8FF). Un tel caractère s'affiche dans la police
# suivante de `--mono` (Cascadia Mono, SF Mono, Menlo…), jamais en carré vide.

# Fonctions OpenType appliquées d'office par les navigateurs (texte horizontal, gauche à droite) ; seules celles que la
# police porte restent, les autres sont simplement absentes.
FONCTIONS = ['calt', 'ccmp', 'clig', 'curs', 'kern', 'liga', 'locl', 'mark', 'mkmk', 'rclt', 'rlig', 'rvrn', 'ltra', 'ltrm']


def sous_ensemble(graisse):
    options = subset.Options()
    options.flavor = 'woff'           # zlib : pas de brotli ici
    options.layout_features = FONCTIONS
    options.layout_scripts = ['*']    # DFLT, latn, grek, cyrl : la langue de la page choisit, comme avant
    options.hinting = True            # garder ttfautohint : même rendu sous Windows et Linux
    options.notdef_outline = True     # garder le dessin de .notdef tel quel
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]  # copyright, noms, version, licence et son adresse
    options.name_languages = ['*']
    options.glyph_names = False       # les noms de glyphes ne servent pas à l'affichage
    # Rien n'est recalculé : ni les boîtes des glyphes (l'origine des points fantômes du hinting en dépend ; recalculées,
    # elles décalaient 840 caractères composés de quelques pixels au canevas, ligatures comprises : vu au banc le 11/11),
    # ni maxp, ni la date (sortie reproductible). D'où load_font / save_font du sous-ensembleur, qui appliquent ces
    # options ; un TTFont ouvert à la main recalcule tout à l'enregistrement.
    options.recalc_bounds = False
    options.recalc_timestamp = False
    police = subset.load_font(SOURCE.format(graisse), options)
    dessines = set(police.getBestCmap())
    voulus = set()
    for debut, fin, _ in PLAGES:
        voulus.update(range(debut, fin + 1))
    gardes = voulus & dessines
    sous = subset.Subsetter(options)
    sous.populate(unicodes=gardes)
    sous.subset(police)
    nettoie_drapeaux(police)
    subset.save_font(police, SORTIE.format(GRAISSES[graisse]), options)
    with open(SORTIE.format(GRAISSES[graisse]), 'rb') as f:
        octets = f.read()
    reste = TTFont(io.BytesIO(octets))
    verifie(TTFont(SOURCE.format(graisse)), reste)
    fonctions = sorted({r.FeatureTag for t in ('GSUB', 'GPOS') if t in reste for r in reste[t].table.FeatureList.FeatureRecord})
    return {
        'caracteres': len(reste.getBestCmap()),
        'source': len(dessines),
        'glyphes': len(reste.getGlyphOrder()),
        'glyphes_source': len(TTFont(SOURCE.format(graisse)).getGlyphOrder()),
        'octets': len(octets),
        'octets_source': os.path.getsize(SOURCE.format(graisse)),
        'fonctions': fonctions,
        'sha256': hashlib.sha256(octets).hexdigest(),
        'fichier': os.path.relpath(SORTIE.format(GRAISSES[graisse]), RACINE),
    }


def nettoie_drapeaux(police):
    """Iosevka pose le drapeau OVERLAP_SIMPLE (bit 6) sur le premier point de chaque glyphe simple, et la source le
    répète sur les points suivants par le jeu du drapeau « répéter » (un seul octet pour deux points) : 479 glyphes. Après
    la réécriture de fontTools, le bit se retrouve écrit sur le deuxième point, et l'assainisseur OTS de Chrome et de
    Firefox refuse alors toute la police (« glyf: Bad glyph flag (101), bit 6 must be set to zero for flag 1 », relevé
    au banc le 11/11 : faces « Iosevka UI » en erreur). La norme OpenType ne lit ce bit que sur le premier point : on
    l'efface ailleurs, le premier point le garde (même rendu des contours qui se chevauchent)."""
    glyf = police['glyf']
    for nom in police.getGlyphOrder():
        g = glyf[nom]
        if g.numberOfContours > 0:
            for i in range(1, len(g.flags)):
                g.flags[i] &= ~0x40


def verifie(source, reste):
    """Preuve, caractère par caractère : même dessin (contours décomposés), même boîte, même chasse, mêmes instructions
    de rendu et même drapeau de chevauchement que l'Iosevka complète ; mêmes métriques verticales et mêmes tables de
    hinting ; aucun bit 6 hors du premier point (règle d'OTS). S'arrête au premier écart."""
    cs, cr = source.getBestCmap(), reste.getBestCmap()
    gs, gr = source.getGlyphSet(), reste.getGlyphSet()
    assert set(cr) <= set(cs)
    for cp, nom in cr.items():
        a, b = DecomposingRecordingPen(gs), DecomposingRecordingPen(gr)
        gs[cs[cp]].draw(a)
        gr[nom].draw(b)
        assert a.value == b.value, f'U+{cp:04X} : dessin différent'
        assert source['hmtx'][cs[cp]] == reste['hmtx'][nom], f'U+{cp:04X} : chasse différente'
        pa = getattr(source['glyf'][cs[cp]], 'program', None)
        pb = getattr(reste['glyf'][nom], 'program', None)
        assert (pa.getBytecode() if pa else b'') == (pb.getBytecode() if pb else b''), f'U+{cp:04X} : instructions différentes'
        ga, gb = source['glyf'][cs[cp]], reste['glyf'][nom]
        assert all(getattr(ga, k, None) == getattr(gb, k, None) for k in ('xMin', 'yMin', 'xMax', 'yMax')), f'U+{cp:04X} : boîte différente'
        if ga.numberOfContours > 0:
            assert (ga.flags[0] & 0x40) == (gb.flags[0] & 0x40), f'U+{cp:04X} : drapeau de chevauchement différent'
    for nom in reste.getGlyphOrder():  # la règle d'OTS, sur tous les glyphes gardés (ligatures comprises)
        g = reste['glyf'][nom]
        assert g.numberOfContours <= 0 or not any(f & 0x40 for f in g.flags[1:]), f'{nom} : bit 6 hors du premier point'
    for table, champs in (('hhea', ('ascent', 'descent', 'lineGap')), ('OS/2', ('sTypoAscender', 'sTypoDescender', 'sTypoLineGap', 'usWinAscent', 'usWinDescent', 'fsSelection', 'usWeightClass')), ('head', ('unitsPerEm',))):
        for c in champs:
            assert getattr(source[table], c) == getattr(reste[table], c), f'{table}.{c} différent'
    for t in ('cvt ', 'fpgm', 'prep', 'gasp'):
        assert source[t].compile(source) == reste[t].compile(reste), f'table {t} différente'


def main():
    for graisse in GRAISSES:
        r = sous_ensemble(graisse)
        print(f"{r['fichier']} : {r['caracteres']} caractères sur {r['source']}, {r['glyphes']} glyphes sur {r['glyphes_source']}, "
              f"{r['octets']} octets (source woff {r['octets_source']}) ; fonctions {' '.join(r['fonctions'])} ; sha256 {r['sha256']}")
        print(f"  vérifié : dessin, boîte, chasse, instructions et drapeau de chevauchement identiques à l'Iosevka complète pour les {r['caracteres']} caractères ; métriques et tables de rendu identiques ; aucun bit 6 hors du premier point")
    return 0


if __name__ == '__main__':
    sys.exit(main())
