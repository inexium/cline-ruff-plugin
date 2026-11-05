# cline-ruff-plugin

Plugin [Cline](https://docs.cline.bot/customization/plugins) qui ajoute deux tools à l'agent pour le code Python, basés sur [Ruff](https://docs.astral.sh/ruff/) :

| Tool | Rôle |
| --- | --- |
| `ruff_check` | Lint (`ruff check`) : liste les violations (règle, message, fichier, ligne, colonne, lien vers la doc, fix disponible). Avec `fix: true`, applique les corrections automatiques. |
| `ruff_format` | Formatage (`ruff format`) : formate les fichiers, ou en mode `check` / `diff` indique ce qui changerait sans rien écrire. |

Les deux tools fonctionnent soit sur des fichiers/dossiers du projet (`paths`), soit sur un extrait de code (`code`), auquel cas rien n'est écrit sur le disque et le code corrigé/formaté est renvoyé. La configuration du projet (`pyproject.toml`, `ruff.toml`) est respectée.

> Les plugins Cline sont pris en charge par le Cline CLI, le SDK et Kanban (pas encore par les extensions VS Code / JetBrains).

## Prérequis

- Cline CLI (Node.js ≥ 22)
- Ruff installé : `pip install ruff`, `uv tool install ruff` ou `brew install ruff`.
  Pour utiliser un binaire précis, définir `RUFF_PATH=/chemin/vers/ruff`.

## Installation

```bash
# depuis GitHub
cline plugin install https://github.com/inexium/cline-ruff-plugin.git

# ou depuis un dossier local
cline plugin install ./cline-ruff-plugin
```

Vérifier le chargement dans l'onglet plugins de `cline config`.

Le point d'entrée est déclaré dans `package.json` :

```json
"cline": { "plugins": ["./index.ts"] }
```

## Paramètres

Communs aux deux tools :

| Paramètre | Description |
| --- | --- |
| `paths` | Fichiers/dossiers à traiter (défaut : `["."]`). |
| `code` | Code Python à traiter à la place des fichiers (via stdin). |
| `filename` | Nom virtuel du snippet, pour les réglages par fichier (défaut `snippet.py`). |
| `cwd` | Dossier depuis lequel lancer Ruff (défaut : dossier de la session). |
| `config` | Fichier de config Ruff ou surcharge TOML inline (`"line-length = 100"`). |

`ruff_check` : `fix`, `unsafe_fixes`, `select`, `extend_select`, `ignore`, `max_diagnostics` (défaut 200).

`ruff_format` : `check`, `diff`, `line_length`, `preview`.

## Exemples de résultat

`ruff_check { "paths": ["src"] }` :

```json
{
  "summary": "3 issue(s) found. 3 can be fixed automatically with fix=true.",
  "total": 3,
  "fixable": { "safe": 3, "unsafe": 0 },
  "by_rule": { "F401": 2, "I001": 1 },
  "diagnostics": [
    { "file": "src/app.py", "line": 1, "column": 8, "code": "F401",
      "message": "`os` imported but unused", "fixable": "safe", "url": "https://docs.astral.sh/ruff/rules/unused-import" }
  ]
}
```

`ruff_format { "paths": ["src"], "check": true }` :

```json
{ "summary": "1 file(s) would be reformatted. ...", "would_reformat": ["src/app.py"], "written": false }
```

Une erreur de Ruff (erreur de syntaxe, config invalide, Ruff introuvable) est remontée comme une erreur du tool, avec le message de Ruff.

## Développement

```bash
npm install
npm run typecheck
npm test
```
