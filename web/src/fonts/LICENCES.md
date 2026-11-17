# Polices embarquées par Meydan — licences

Toutes sont sous SIL Open Font License 1.1 : usage commercial, embarquement dans une application et modification autorisés ; seule la vente de la police seule est interdite. Vérifié le 2026-11-09 pendant le débat des juges (détail et pages lues : `docs/juges/maquettes/sceptique/LICENCES.md`, `docs/juges/maquettes/pragmatique/LICENCES.md`).

| Police | Rôle | Fichier(s) | Source | Mention |
|---|---|---|---|---|
| Host Grotesk (variable 300–800) | interface du thème « Réverbère » | `HostGrotesk-var.woff2`, `HostGrotesk-var-latinext.woff2` | https://github.com/Element-Type/HostGrotesk | Copyright 2023 The Host Grotesk Project Authors |
| Doto (variable 100–900) | chiffre du compteur, rien d'autre | `Doto-var.woff2` | https://github.com/oliverlalan/Doto | Copyright 2024 The Doto Project Authors |
| Recursive Sans Linear (variable 300–1000) | candidate d'interface (`?police=recursive`) | `RecursiveSansLinear-300-1000.woff2` | https://github.com/arrowtype/recursive | Copyright 2020 The Recursive Project Authors |
| Martian Grotesk 400 / 500 / 700 | candidate d'interface (`?police=martian`) | `MartianGrotesk-Regular.woff2`, `-Medium.woff2`, `-Bold.woff2` | https://github.com/evilmartians/grotesk | Copyright 2021 The Martian Grotesk Project Authors |
| Iosevka 400 / 700 | terminal seulement (importée par `Term.jsx`) | paquet `@fontsource/iosevka` 5.3.0 (Iosevka 22.1.2) | https://github.com/be5invis/Iosevka | Copyright (c) 2015-2023, Renzhi Li (aka. Belleve Invis) |
| Iosevka UI 400 / 700 (sous-ensemble d'Iosevka 22.1.2, version modifiée au sens de l'OFL) | `--mono` de l'interface : étiquettes, âges, chemins, code de la discussion (les deux thèmes) | `IosevkaUI-Regular.woff`, `IosevkaUI-Bold.woff`, produits par `scripts/police-ui.py` | https://github.com/be5invis/Iosevka | Copyright (c) 2015-2023, Renzhi Li (aka. Belleve Invis) ; copyright et licence gardés dans la table `name` (0, 13, 14) |
| Archivo (variable) | interface du thème « Tapis » | paquet `@fontsource-variable/archivo` | https://github.com/Omnibus-Type/Archivo | Copyright 2020 The Archivo Project Authors |

Iosevka n'a pas de « Reserved Font Name » (la ligne de copyright de sa licence n'en nomme aucun, vérifié le 2026-11-11 dans `node_modules/@fontsource/iosevka/LICENSE`) : le sous-ensemble peut garder « Iosevka » dans son nom. Il reste sous OFL 1.1 ; texte entier dans `LICENCES-TIERCES.md`.
