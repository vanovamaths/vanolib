# VanoLib — Math Library

Site public de la bibliothèque mathématique arXiv de Yassine Ait Mohamed :
recherche, filtres par année/catégorie, lecture des PDF directement depuis arXiv.

- **319 866 articles arXiv** (catégories `math.*` et `math-ph`) au moment de la
  première publication, mis à jour **automatiquement chaque lundi** via
  [GitHub Actions](.github/workflows/update.yml).
- Aucun PDF n'est hébergé ici : le lecteur intégré charge directement les
  fichiers depuis `arxiv.org` (pas de droit de republication, pas de stockage
  lourd).
- Génère `site/data/*.json` à partir de la base locale (voir
  `scripts/collect_arxiv.py` pour la logique de collecte incrémentale).

## Structure

```
site/               # site statique (déployé sur GitHub Pages)
  index.html
  app.js
  style.css
  data/
    manifest.json    # métadonnées globales (années, catégories, total)
    <année>.json      # un shard par année de publication
scripts/
  collect_arxiv.py    # collecte incrémentale arXiv, exécuté chaque lundi par la CI
.github/workflows/
  update.yml           # cron hebdomadaire : collecte + commit
  deploy.yml           # déploie site/ sur GitHub Pages à chaque push sur main
```

## Développement local

```
cd site && python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000
