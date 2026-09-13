export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const mbid = String(req.query.mbid || "").trim();

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let lastRequest = 0;

    async function mbFetch(url, attempts = 3) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const wait = Math.max(0, 1100 - (Date.now() - lastRequest));

        if (wait > 0) {
          await sleep(wait);
        }

        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "AlbumPedia/1.0 (https://albumpedia-577b.vercel.app)",
            "Accept": "application/json"
          }
        });

        lastRequest = Date.now();

        if (response.ok) {
          return await response.json();
        }

        if (response.status === 503) {
          await sleep(2000 * (attempt + 1));
          continue;
        }

        throw new Error(`MusicBrainz HTTP ${response.status}`);
      }

      throw new Error("MusicBrainz HTTP 503");
    }

    // ------------------------------------------------------------
    // DETTAGLIO ALBUM
    // ------------------------------------------------------------
    if (mbid) {
      const groupUrl =
        "https://musicbrainz.org/ws/2/release-group/" +
        encodeURIComponent(mbid) +
        "?fmt=json&inc=artist-credits+releases";

      const group = await mbFetch(groupUrl);

      const releases = Array.isArray(group.releases)
        ? group.releases
        : [];

      // Preferiamo una release ufficiale italiana, poi una ufficiale
      // con data, poi semplicemente la prima disponibile.
      const official = releases.filter(r => r.status === "Official");

      const italian = official.filter(r => {
        const country = String(r.country || "").toUpperCase();
        return country === "IT";
      });

      const pool =
        italian.length > 0
          ? italian
          : official.length > 0
          ? official
          : releases;

      pool.sort((a, b) => {
        const da = a.date || "9999-99-99";
        const db = b.date || "9999-99-99";
        return da.localeCompare(db);
      });

      const release = pool[0];

      if (!release || !release.id) {
        return res.status(200).json({
          title: group.title || "",
          artist:
            group["artist-credit"]?.map(x => x.name).join(", ") || "",
          date: group["first-release-date"] || "",
          type: group["primary-type"] || "Album",
          cover: `https://coverartarchive.org/release-group/${mbid}/front-500`,
          tracks: [],
          trackCount: 0,
          release: null
        });
      }

      const releaseUrl =
        "https://musicbrainz.org/ws/2/release/" +
        encodeURIComponent(release.id) +
        "?fmt=json&inc=media+recordings+artist-credits+labels";

      const releaseData = await mbFetch(releaseUrl);

      const tracks = [];

      for (const medium of releaseData.media || []) {
        for (const track of medium.tracks || []) {
          const recording = track.recording || {};

          tracks.push({
            number: track.position || tracks.length + 1,
            title: recording.title || track.title || "",
            length:
              track.length != null
                ? track.length
                : recording.length != null
                ? recording.length
                : null,
            artist:
              recording["artist-credit"]
                ?.map(x => x.name)
                .join(", ") || null
          });
        }
      }

      const labels = Array.isArray(releaseData["label-info"])
        ? releaseData["label-info"]
            .map(x => x.label?.name)
            .filter(Boolean)
        : [];

      return res.status(200).json({
        title: group.title || releaseData.title || "",
        artist:
          group["artist-credit"]?.map(x => x.name).join(", ") ||
          releaseData["artist-credit"]?.map(x => x.name).join(", ") ||
          "",
        date:
          group["first-release-date"] ||
          releaseData.date ||
          "",
        type: group["primary-type"] || "Album",
        cover:
          `https://coverartarchive.org/release-group/${mbid}/front-500`,
        mbid,
        trackCount: tracks.length,
        tracks,
        release: {
          id: releaseData.id,
          title: releaseData.title,
          date: releaseData.date || "",
          country: releaseData.country || "",
          status: releaseData.status || "",
          labels
        }
      });
    }

    // ------------------------------------------------------------
    // RICERCA ALBUM
    // ------------------------------------------------------------
    if (!q) {
      return res.status(400).json({
        error: "Parametro q mancante"
      });
    }

    /*
      Facciamo UNA SOLA richiesta a MusicBrainz.

      Generiamo localmente tutte le possibili divisioni:
      "Sfera Ebbasta Rockstar"

      può diventare:
      Sfera        / Ebbasta Rockstar
      Sfera Ebbasta / Rockstar

      e le mandiamo tutte dentro un'unica query.
    */

    const words = q.split(/\s+/).filter(Boolean);

    const escapeLucene = (value) =>
      String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');

    const clauses = [];

    for (let i = 1; i < words.length; i++) {
      const artist = words.slice(0, i).join(" ");
      const title = words.slice(i).join(" ");

      clauses.push(
        `(artist:"${escapeLucene(artist)}" AND releasegroup:"${escapeLucene(title)}")`
      );
    }

    // Aggiungiamo anche una ricerca libera come fallback,
    // sempre nella STESSA richiesta.
    clauses.push(`releasegroup:"${escapeLucene(q)}"`);
    clauses.push(`artist:"${escapeLucene(q)}"`);

    const luceneQuery =
      `primarytype:album AND (${clauses.join(" OR ")})`;

    const searchUrl =
      "https://musicbrainz.org/ws/2/release-group" +
      "?fmt=json&limit=20&inc=artist-credits" +
      "&query=" +
      encodeURIComponent(luceneQuery);

    const data = await mbFetch(searchUrl);

    const groups = Array.isArray(data["release-groups"])
      ? data["release-groups"]
      : [];

    const normalized = q.toLowerCase();

    function score(group) {
      const title = String(group.title || "").toLowerCase();
      const artist =
        group["artist-credit"]
          ?.map(x => x.name)
          .join(" ")
          .toLowerCase() || "";

      let score = 0;

      if (title === normalized) score += 100;
      if (artist === normalized) score += 50;

      const combined = `${artist} ${title}`;

      if (combined === normalized) score += 150;
      if (normalized.includes(title) && title) score += 40;
      if (normalized.includes(artist) && artist) score += 40;

      if (group["primary-type"] === "Album") score += 20;

      return score;
    }

    groups.sort((a, b) => score(b) - score(a));

    const results = groups.slice(0, 10).map(group => {
      const artist =
        group["artist-credit"]
          ?.map(x => x.name)
          .join(", ") || "";

      return {
        mbid: group.id,
        title: group.title || "",
        artist,
        date: group["first-release-date"] || "",
        type: group["primary-type"] || "Album",
        trackCount: 0,
        cover:
          `https://coverartarchive.org/release-group/${group.id}/front-500`
      };
    });

    return res.status(200).json({
      query: q,
      results
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Errore nella ricerca MusicBrainz",
      details: error.message || String(error)
    });
  }
}
