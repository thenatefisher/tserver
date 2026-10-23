# Player names

[`tbn/data/player-names.json`](tbn/data/player-names.json) contains 250 English descriptors (adjectives or adverbs) and 250 English nouns. All words are family-friendly and fewer than 10 characters. A generated name combines one random descriptor and one random noun, capitalized and separated by a space, such as `Brave Otter`. There are 62,500 combinations; names are not guaranteed unique.

[`tbn/player-names.js`](tbn/player-names.js) exports `generatePlayerName()`. The local client generates a default name when it connects to the central server, logs it, and includes it as `playerName` in browser `server_status` events. The name stays the same across reconnects for that client instance. Set the `playerName` constructor option to choose a default explicitly.

When forwarding `register_actor`, the relay fills an absent or empty `name` with this default. An explicit actor name is preserved. Browsers may use the `playerName` status field to display the generated name or include it in their actor registration package.

For standalone HTML clients, embed the corpus/generator into the HTML at build time and generate/preserve the name in the browser. Do not require the Node helper or its relay at runtime; the relay behavior above describes legacy tooling only.
