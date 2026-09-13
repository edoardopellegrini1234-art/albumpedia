export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({ error: "Parametro q mancante" });
    }

    const normalize = (s) =>
      String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    const sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    let lastRequest = 0;

    const mbFetch = async (url) => {
      const wait = 1100 - (Date.now() - lastRequest);

      if (wait > 0) {
        await sleep(wait);
      }

      lastRequest = Date.now();

      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "AlbumPedia/1.0 (albumpedia-577b.vercel.app)"
          }
        });

        if (response.ok) {
          return response.json();
        }

        if (response.status === 503 && attempt < 2) {
          await sleep(2000 * (attempt + 1));
          continue;
        }

        throw new Error(`MusicBrainz HTTP ${response.status}`);
      }
    };

    const words = q.split(/\s+/);
    const candidates = [];

    for (let i = 1; i < words.length; i++) {
      candidates.push({
        artist: words.slice(0, i).join(" "),
        title: words.slice(i).join(" ")
      });
    }

    candidates.sort((a, b) => b.artist.length - a.artist.length);

    for (const candidate of candidates) {

      // Trova artista
      const artistUrl =
        "https://musicbrainz.org/ws/2/artist/?" +
        new URLSearchParams({
          query: `artist:"${candidate.artist}"`,
          fmt: "json",
          limit: "3"
        });

      const artistData = await mbFetch(artistUrl);

      const artists = (artistData.artists || []).sort((a, b) => {
        const ae = normalize(a.name) === normalize(candidate.artist);
        const be = normalize(b.name) === normalize(candidate.artist);
        return Number(be) - Number(ae);
      });

      const artist = artists[0];

      if (!artist) continue;

      // Cerca direttamente il release-group
      const groupUrl =
        "https://musicbrainz.org/ws/2/release-group/?" +
        new URLSearchParams({
          artist: artist.id,
          type: "album",
          fmt: "json",
          limit: "100"
        });

      const groupData = await mbFetch(groupUrl);

      const groups = groupData["release-groups"] || [];

      const exact = groups.find(
        (g) => normalize(g.title) === normalize(candidate.title)
      );

      if (!exact) continue;

      // Un'unica richiesta per ottenere le release associate
      const lookupUrl =
        "https://musicbrainz.org/ws/2/release-group/" +
        exact.id +
        "?" +
        new URLSearchParams({
          inc: "releases",
          fmt: "json"
        });

      const groupDetail = await mbFetch(lookupUrl);

      const releases = groupDetail.releases || [];

      // Preferisci release ufficiali
      releases.sort((a, b) => {
        const ao = a.status === "Official" ? 1 : 0;
        const bo = b.status === "Official" ? 1 : 0;

        if (ao !== bo) return bo - ao;

        return String(a.date || "").localeCompare(
          String(b.date || "")
        );
      });

      let chosen = null;

      // Controlla al massimo 3 release.
      for (const release of releases.slice(0, 3)) {

        const detailUrl =
          "https://musicbrainz.org/ws/2/release/" +
          release.id +
          "?" +
          new URLSearchParams({
            inc: "recordings+artist-credits+labels+media",
            fmt: "json"
          });

        const detail = await mbFetch(detailUrl);

        const tracks = (detail.media || []).flatMap((medium) =>
          (medium.tracks || []).map((track) => ({
            position: track.position,
            number: track.number,
            title:
              track.title ||
              track.recording?.title ||
              "",
            length:
              track.length ||
              track.recording?.length ||
              null,
            artists:
              (track["artist-credit"] ||
                track.recording?.["artist-credit"] ||
                [])
                .map(
                  (a) => a.name || a.artist?.name
                )
                .filter(Boolean)
                .join(", ")
          }))
        );

        if (tracks.length > 0) {
          chosen = {
            detail,
            tracks
          };
          break;
        }
      }

      const result = {
        mbid: exact.id,
        title: exact.title,
        artist: artist.name,
        artistMbid: artist.id,
        date: exact["first-release-date"] || "",
        type: exact["primary-type"] || "Album",
        cover:
          `https://coverartarchive.org/release-group/${exact.id}/front-500`,
        trackCount: chosen ? chosen.tracks.length : 0,
        tracks: chosen ? chosen.tracks : []
      };

      if (chosen) {
        result.releaseMbid = chosen.detail.id;
        result.country = chosen.detail.country || "";
        result.status = chosen.detail.status || "";
        result.labels = (chosen.detail.labels || [])
          .map((x) => x.label?.name)
          .filter(Boolean);
      }

      return res.status(200).json({
        query: q,
        results: [result]
      });
    }

    return res.status(200).json({
      query: q,
      results: []
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Errore nella ricerca MusicBrainz",
      details: error.message
    });
  }
}
