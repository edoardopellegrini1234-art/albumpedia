export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({
        error: "Parametro q mancante"
      });
    }

    const normalize = (s) =>
      String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    const mbFetch = async (url) => {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "AlbumPedia/1.0 (albumpedia-577b.vercel.app)"
        }
      });

      if (!response.ok) {
        throw new Error(`MusicBrainz HTTP ${response.status}`);
      }

      return response.json();
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

      // 1. Trova l'artista
      const artistUrl =
        "https://musicbrainz.org/ws/2/artist/?" +
        new URLSearchParams({
          query: `artist:"${candidate.artist}"`,
          fmt: "json",
          limit: "5"
        });

      const artistData = await mbFetch(artistUrl);

      const artists = (artistData.artists || []).sort((a, b) => {
        const ae =
          normalize(a.name) === normalize(candidate.artist);
        const be =
          normalize(b.name) === normalize(candidate.artist);

        return Number(be) - Number(ae);
      });

      const artist = artists[0];

      if (!artist) continue;

      // 2. Trova il release-group dell'album
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
        (g) =>
          normalize(g.title) === normalize(candidate.title)
      );

      if (!exact) continue;

      // 3. Trova le release reali appartenenti al release-group
      const releaseUrl =
        "https://musicbrainz.org/ws/2/release/?" +
        new URLSearchParams({
          "release-group": exact.id,
          fmt: "json",
          limit: "100"
        });

      const releaseData = await mbFetch(releaseUrl);

      const releases = releaseData.releases || [];

      // Preferiamo release ufficiali con tracce
      const orderedReleases = [...releases].sort((a, b) => {
        const aOfficial = a.status === "Official" ? 1 : 0;
        const bOfficial = b.status === "Official" ? 1 : 0;

        if (aOfficial !== bOfficial) {
          return bOfficial - aOfficial;
        }

        return String(a.date || "").localeCompare(
          String(b.date || "")
        );
      });

      let chosen = null;

      // 4. Apriamo le release una per una finché troviamo una tracklist
      for (const release of orderedReleases) {

        const detailUrl =
          "https://musicbrainz.org/ws/2/release/" +
          release.id +
          "?" +
          new URLSearchParams({
            inc: "recordings+artist-credits+labels+media",
            fmt: "json"
          });

        const detail = await mbFetch(detailUrl);

        const media = detail.media || [];

        const tracks = media.flatMap((medium) =>
          (medium.tracks || []).map((track) => ({
            position: track.position,
            number: track.number,
            title: track.title || track.recording?.title || "",
            length: track.length || track.recording?.length || null,
            artists:
              (track["artist-credit"] ||
                track.recording?.["artist-credit"] ||
                [])
                .map((a) => a.name || a.artist?.name)
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

      // 5. Restituisci album + tracklist
      if (chosen) {
        const detail = chosen.detail;

        const labels = (detail.labels || [])
          .map((x) => x.label?.name)
          .filter(Boolean);

        return res.status(200).json({
          query: q,

          results: [
            {
              mbid: exact.id,
              title: exact.title,
              artist: artist.name,
              artistMbid: artist.id,
              date:
                exact["first-release-date"] ||
                detail.date ||
                "",
              type:
                exact["primary-type"] ||
                "Album",

              cover:
                `https://coverartarchive.org/release-group/${exact.id}/front-500`,

              releaseMbid: detail.id,

              country: detail.country || "",

              status: detail.status || "",

              labels,

              trackCount: chosen.tracks.length,

              tracks: chosen.tracks
            }
          ]
        });
      }

      // Se non abbiamo trovato una release con tracce,
      // restituiamo comunque l'album.
      return res.status(200).json({
        query: q,

        results: [
          {
            mbid: exact.id,
            title: exact.title,
            artist: artist.name,
            artistMbid: artist.id,
            date: exact["first-release-date"] || "",
            type: exact["primary-type"] || "Album",
            cover:
              `https://coverartarchive.org/release-group/${exact.id}/front-500`,
            trackCount: 0,
            tracks: []
          }
        ]
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
