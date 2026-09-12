# AlbumPedia 2.0 — Research Engine

Questa versione aggiunge il motore di ricerca editoriale.

## Avvio
1. Node.js 20+
2. `npm install`
3. copia `.env.example` in `.env.local`
4. inserisci `OPENAI_API_KEY=...`
5. opzionale: `OPENAI_MODEL=gpt-5.6-luna`
6. `npm run dev`
7. apri `http://localhost:3000`

## Flusso
Ricerca album -> MusicBrainz -> pagina album -> “Ricerca completa” -> OpenAI Responses API con web search -> JSON strutturato -> scheda con fonti.

Il modello è istruito a non inventare una trama quando non esiste e a distinguere:
- primary = fonte primaria
- confirmed = confermato da più fonti
- reconstructed = ricostruzione
- interpretation = interpretazione
- disputed = controverso

## Note
La chiave API resta sul server: non inserirla in componenti client o nel browser.
Il costo delle ricerche dipende dall'uso dell'API.
La scheda generata è ricerca assistita, non una garanzia di verità: le fonti vanno sempre controllate.

La base dati usa MusicBrainz per identificazione e metadati. Il web research usa il web search integrato nella Responses API.
