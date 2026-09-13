export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const mbid = String(req.query.mbid || "").trim();

    const mbFetch = async (url) => {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "AlbumPedia/1.0 (albumpedia-577b.vercel.app)",
          "Accept": "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`MusicBrainz HTTP ${response.status}`);
      }

      return response.json();
    };

    // DETTAGLIO ALBUM
    if (mbid) {
      const url =
        "https://musicbrainz.org/ws/2/release-group/" +
        encodeURIComponent(mbid) +
        "?" +
        new URLSearchParams({
          inc: "artist-credits+releases",
          fmt: "json"
        });

      const group = await mbFetch(url);
      const releases = group.releases || [];

      let chosen = null;
      let tracks = [];

      for (const release of releases.slice(0, 3)) {
        if (!release.id) continue;

        const releaseUrl =
          "https://musicbrainz.org/ws/2/release/" +
          encodeURIComponent(release.id) +
          "?" +
          new URLSearchParams({
            inc: "media+recordings+artist-credits+labels",
            fmt: "json"
          });

        const data = await mbFetch(releaseUrl);

        const found = (data.media || []).flatMap(medium =>
          (medium.tracks || []).map(track => ({
            number: track.position || 0,
            title: track.title || track.recording?.title || "",
            length: track.length || track.recording?.length || null,
            artist: (track["artist-credit"] || [])
              .map(a => a.name || a.artist?.name)
              .filter(Boolean)
              .join(", ")
          }))
        );

        if (found.length > tracks.length) {
          tracks = found;
          chosen = data;
        }

        if (tracks.length >= 11) break;
      }

      const artist = (group["artist-credit"] || [])
        .map(a => a.name || a.artist?.name)
        .filter(Boolean)
        .join(", ");

      return res.status(200).json({
        mbid: group.id,
        title: group.title || "",
        artist,
        date: group["first-release-date"] || "",
        type: group["primary-type"] || "Album",
        cover:
          `https://coverartarchive.org/release-group/${group.id}/front-500`,
        trackCount: tracks.length,
        tracks,
        release: chosen
          ? {
              mbid: chosen.id,
              date: chosen.date || "",
              country: chosen.country || "",
              status: chosen.status || "",
              labels: (chosen["label-info"] || [])
                .map(x => x.label?.name)
                .filter(Boolean)
            }
          : null
      });
    }

    // RICERCA
    if (!q) {
      return res.status(400).json({
        error: "Parametro q mancante"
      });
    }

    // UNA SOLA RICHIESTA A MUSICBRAINZ
    const searchUrl =
      "https://musicbrainz.org/ws/2/release-group/?" +
      new URLSearchParams({
        query: q,
        type: "album",
        fmt: "json",
        limit: "10"
      });

    const data = await mbFetch(searchUrl);

    const results = (data["release-groups"] || [])
      .filter(g => g["primary-type"] === "Album")
      .map(g => ({
        mbid: g.id,
        title: g.title,
        artist: (g["artist-credit"] || [])
          .map(a => a.name || a.artist?.name)
          .filter(Boolean)
          .join(", "),
        date: g["first-release-date"] || "",
        type: "Album",
        cover:
          `https://coverartarchive.org/release-group/${g.id}/front-500`
      }));

    return res.status(200).json({
      query: q,
      results
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Errore nella ricerca MusicBrainz",
      details: error.message
    });
  }
}
