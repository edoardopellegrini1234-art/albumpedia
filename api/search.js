export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const mbid = String(req.query.mbid || "").trim();

    const sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    let lastRequest = 0;

    async function mbFetch(url, attempts = 4) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const wait = Math.max(
          0,
          1200 - (Date.now() - lastRequest)
        );

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
          await sleep(2500 * (attempt + 1));
          continue;
        }

        throw new Error(
          `MusicBrainz HTTP ${response.status}`
        );
      }

      throw new Error("MusicBrainz HTTP 503");
    }

    // ============================================================
    // DETTAGLIO ALBUM
    // ============================================================

    if (mbid) {
      /*
        UNA SOLA richiesta:
        cerchiamo direttamente le release appartenenti
        al release-group richiesto e includiamo media + recordings.
      */

      const url =
        "https://musicbrainz.org/ws/2/release" +
        "?fmt=json" +
        "&limit=20" +
        "&inc=media+recordings+artist-credits+labels" +
        "&release-group=" +
        encodeURIComponent(mbid);

      const data = await mbFetch(url);

      const releases = Array.isArray(data.releases)
        ? data.releases
        : [];

      if (!releases.length) {
        return res.status(200).json({
          mbid,
          title: "",
          artist: "",
          date: "",
          type: "Album",
          cover:
            `https://coverartarchive.org/release-group/${mbid}/front-500`,
          tracks: [],
          trackCount: 0,
          release: null
        });
      }

      // Preferiamo release ufficiali italiane.
      const official = releases.filter(
        (r) =>
          String(r.status || "").toLowerCase() === "official"
      );

      const italian = official.filter(
        (r) =>
          String(r.country || "").toUpperCase() === "IT"
      );

      let candidates =
        italian.length > 0
          ? italian
          : official.length > 0
          ? official
          : releases;

      // Preferiamo la release che contiene effettivamente tracce.
      const withTracks = candidates.filter(
        (r) =>
          Array.isArray(r.media) &&
          r.media.some(
            (m) =>
              Array.isArray(m.tracks) &&
              m.tracks.length > 0
          )
      );

      if (withTracks.length > 0) {
        candidates = withTracks;
      }

      // Ordine cronologico.
      candidates.sort((a, b) => {
        const da = a.date || "9999-99-99";
        const db = b.date || "9999-99-99";
        return da.localeCompare(db);
      });

      const release = candidates[0];

      const tracks = [];

      for (const medium of release.media || []) {
        for (const track of medium.tracks || []) {
          const recording = track.recording || {};

          tracks.push({
            number:
              track.position ||
              tracks.length + 1,

            title:
              recording.title ||
              track.title ||
              "",

            length:
              track.length != null
                ? track.length
                : recording.length != null
                ? recording.length
                : null,

            artist:
              recording["artist-credit"]
                ?.map((x) => x.name)
                .join(", ") || null
          });
        }
      }

      const labels = Array.isArray(
        release["label-info"]
      )
        ? release["label-info"]
            .map((x) => x.label?.name)
            .filter(Boolean)
        : [];

      const artist =
        release["artist-credit"]
          ?.map((x) => x.name)
          .join(", ") || "";

      return res.status(200).json({
        mbid,

        title:
          release.title || "",

        artist,

        date:
          release.date || "",

        type: "Album",

        cover:
          `https://coverartarchive.org/release-group/${mbid}/front-500`,

        trackCount: tracks.length,

        tracks,

        release: {
          id: release.id,
          title: release.title || "",
          date: release.date || "",
          country: release.country || "",
          status: release.status || "",
          labels
        }
      });
    }

    // ============================================================
    // RICERCA ALBUM
    // ============================================================

    if (!q) {
      return res.status(400).json({
        error: "Parametro q mancante"
      });
    }

    const words = q
      .split(/\s+/)
      .filter(Boolean);

    const escapeLucene = (value) =>
      String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');

    const clauses = [];

    // Generiamo tutte le possibili divisioni
    // artista / album senza fare richieste multiple.

    for (let i = 1; i < words.length; i++) {
      const artist = words
        .slice(0, i)
        .join(" ");

      const title = words
        .slice(i)
        .join(" ");

      clauses.push(
        `(artist:"${escapeLucene(
          artist
        )}" AND releasegroup:"${escapeLucene(
          title
        )}")`
      );
    }

    // Fallback.
    clauses.push(
      `releasegroup:"${escapeLucene(q)}"`
    );

    const luceneQuery =
      `primarytype:album AND (${clauses.join(
        " OR "
      )})`;

    // UNA SOLA richiesta di ricerca.
    const searchUrl =
      "https://musicbrainz.org/ws/2/release-group" +
      "?fmt=json" +
      "&limit=20" +
      "&inc=artist-credits" +
      "&query=" +
      encodeURIComponent(luceneQuery);

    const data = await mbFetch(searchUrl);

    const groups = Array.isArray(
      data["release-groups"]
    )
      ? data["release-groups"]
      : [];

    const normalized = q.toLowerCase();

    function score(group) {
      const title = String(
        group.title || ""
      ).toLowerCase();

      const artist =
        group["artist-credit"]
          ?.map((x) => x.name)
          .join(" ")
          .toLowerCase() || "";

      let value = 0;

      if (title === normalized) value += 100;
      if (artist === normalized) value += 50;

      const combined =
        `${artist} ${title}`;

      if (combined === normalized) {
        value += 150;
      }

      if (
        title &&
        normalized.includes(title)
      ) {
        value += 40;
      }

      if (
        artist &&
        normalized.includes(artist)
      ) {
        value += 40;
      }

      if (
        group["primary-type"] === "Album"
      ) {
        value += 20;
      }

      return value;
    }

    groups.sort(
      (a, b) => score(b) - score(a)
    );

    const results = groups
      .slice(0, 10)
      .map((group) => {
        const artist =
          group["artist-credit"]
            ?.map((x) => x.name)
            .join(", ") || "";

        return {
          mbid: group.id,

          title:
            group.title || "",

          artist,

          date:
            group["first-release-date"] || "",

          type:
            group["primary-type"] ||
            "Album",

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
      error:
        "Errore nella ricerca MusicBrainz",

      details:
        error.message ||
        String(error)
    });
  }
}
