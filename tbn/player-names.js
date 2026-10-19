const { randomInt } = require('crypto');
const corpus = require('./data/player-names.json');

/** One English descriptor and one noun, for example "Brave Otter". */
function generatePlayerName() {
    const capitalize = word => word[0].toUpperCase() + word.slice(1);
    return `${capitalize(corpus.descriptors[randomInt(corpus.descriptors.length)])} ${capitalize(corpus.nouns[randomInt(corpus.nouns.length)])}`;
}

module.exports = { generatePlayerName };
