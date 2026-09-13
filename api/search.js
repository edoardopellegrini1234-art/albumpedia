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

    // Prova tutte le possibili divisioni:
    // "Sfera Ebbasta Rockstar"
    // -> "Sfera Ebbasta" + "Rockstar"
    const words = q.split(/\s+/);
    const candidates = [];

    for (let i = 1; i < words.length; i++) {
      candidates.push({
        artist: words.slice(0, i).join(" "),
        title: words.slice(i).join(" ")
      });
    }

    // Prima prova le divisioni più lunghe dell'artista.
    candidates.sort((a, b) => b.artist.length - a.artist.length);

    for (const candidate of candidates) {
      const artistSearch =
        "https://musicbrainz.org/ws/2/artist/?" +
        new URLSearchParams({
          query: `artist:"${candidate.artist}"`,
          fmt: "json",
          limit: "5"
        });

      const artistData = await mbFetch(artistSearch);

      const artists = (artistData.artists || [])
        .sort((a, b) => {
          const ae = normalize(a.name) === normalize(candidate.artist);
          const be = normalize(b.name) === normalize(candidate.artist);
          return Number(be) - Number(ae);
        });

      const artist = artists[0];

      if (!artist) continue;

      const releaseUrl =
        "https://musicbrainz.org/ws/2/release-group?" +
        new URLSearchParams({
          artist: artist.id,
          type: "album",
          fmt: "json",
          limit: "100"
        });

      const releaseData = await mbFetch(releaseUrl);

      const groups = releaseData["release-groups"] || [];

      const exact = groups.find(
        (g) => normalize(g.title) === normalize(candidate.title)
      );

      if (exact) {
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
                `https://coverartarchive.org/release-group/${exact.id}/front-500`
            }
          ]
        });
      }
    }

    // Fallback: ricerca diretta release-group.
    const fallbackUrl =
      "https://musicbrainz.org/ws/2/release-group/?" +
      new URLSearchParams({
        query: q,
        fmt: "json",
        limit: "20"
      });

    const fallbackData = await mbFetch(fallbackUrl);

    const results = (fallbackData["release-groups"] || [])
      .filter((g) => g["primary-type"] === "Album")
      .slice(0, 10)
      .map((g) => ({
        mbid: g.id,
        title: g.title,
        artist: (g["artist-credit"] || [])
          .map((a) => a.name || a.artist?.name)
          .filter(Boolean)
          .join(", "),
        date: g["first-release-date"] || "",
        type: g["primary-type"] || "Album",
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
