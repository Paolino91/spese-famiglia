# Spese Famiglia

App web (installabile su iPhone) per le spese di famiglia, con sincronizzazione automatica in cloud.

- `index.html` — l'app
- `netlify/functions/sync.mjs` — funzione server che unisce e salva le spese (Netlify Blobs)
- `sw.js`, `manifest.webmanifest`, `icons/` — installazione come app e funzionamento offline

Variabile d'ambiente obbligatoria su Netlify: `FAMILY_KEY` (il codice famiglia, da inserire una volta su ogni telefono).
I dati NON sono in questo repository: stanno nello store Netlify Blobs del sito, con una copia di sicurezza al giorno.
