WORLDGUESS: how to edit

Host the whole folder on any static host (GitHub Pages, Cloudflare Pages, Netlify). Test locally with:  python3 -m http.server

FILES
  index.html   page layout (rarely needs edits)
  style.css    ALL colours/fonts/roundness are variables at the top. Edit them to restyle.
  app.js       game logic, with section comments
  config.json  title, favicon, banner, footer, tabs, relays, daily reset, theme overrides, ads
  lang/        translations
  pages/       text for the About / How to play / Privacy tabs (Markdown)

CONFIG.JSON
  favicon / banner   path or URL of an image (e.g. "assets/icon.png"). Leave "" for defaults.
  showTitle          false hides the title text next to a banner image.
  footer             text shown at the bottom; supports **bold** and [links](https://...).
  dailyResetOffsetMinutes   0 = daily challenge changes at 00:00 UTC. 330 = midnight India time.
  theme              override CSS variables without editing CSS, e.g. {"--accent":"#00d4ff"}
  tabs               add a tab: put a .md file in pages/ and add {"id","label","file"}.
                     label can be text or per-language: {"en":"About","hi":"..."}
  relays             default Nostr relays (players can change theirs in Settings)

ADD A LANGUAGE
  1. Copy lang/en.json to lang/xx.json (xx = language code) and translate the values only.
     Missing keys fall back to English.
  2. Add {"code":"xx","name":"Language name"} to lang/index.json.
  The language picker appears once there are two or more languages.

ADSENSE
  1. Set "enabled": true and paste your publisher ID in "client".
  2. Create ad units in AdSense and paste each unit's slot ID under "slots".
  3. Put an ads.txt file at your domain root, add a real privacy policy, and use AdSense's consent
     message tool for UK/EU visitors. Ads only appear on menu, end and leaderboard screens.

IMAGERY SOURCES (menu dropdown)
  Google Street View   needs the player's own Maps key.
  Wikimedia photos     no key. Geotagged Commons photos, credited after every guess.
  Street photos (beta) no key. Panoramax; API address in config.json -> "panoramaxApi". 360 images are skipped.
  The no-key modes use a Leaflet map. config.json -> "tiles" sets the tile server. OpenStreetMap's own tile
  server has a usage policy that forbids heavy traffic: before you get real traffic, switch to a provider
  that allows it, or host your own tiles.

COMMUNITY MAPS
  Players publish lists of places (5 to 300) as signed Nostr events; anyone can vote up or down, one vote per key.
  A map whose score drops to "mapHideBelow" (config.json, default -3) or lower disappears from the list.
  Anyone can create new keys, so votes can be gamed; this is self-moderation, not a guarantee.
  Maps hold only a name (40 characters) and coordinates, which keeps abuse low. Playing a map looks for
  photos or Street View within a short distance of each place, so places in remote spots may be skipped.
  Share links look like  #map=<author key>:<map id>.

MOBILE MENU: below 720px wide the tabs collapse into a hamburger button (style.css, "hamburger").

DUELS (unranked)
  Menu > "Duel a friend". One player creates a duel and shares the link or code; the other joins. Both get the same
  places (seeded by the code), the imagery source and mode chosen by the creator, and 6000 health each. After a round
  the lower score loses health equal to the score difference (x1, x1, x1.5, x2, x2.5 by round). First to 0, or the
  higher health after 5 rounds, wins. Duels always have a round timer (60s if the mode has none).
  Transport: ephemeral Nostr events through the relays in Settings, upgraded to a direct WebRTC connection when
  possible (public Google STUN only, no TURN server, so some mobile networks stay on relays). Players do not need
  an account: each duel uses a throwaway key.
  Limits: guesses are committed then revealed, which stops copying but a modified client could still read the answer.
  There is no ranking. If a relay drops messages the game resends them, but a long outage ends the duel.
  Opponent pins are not drawn on the map, only their score and distance are shown.
