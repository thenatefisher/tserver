const { inspect } = require('node:util');
function createLogger(debug = false) {
    return {
        info: (...args) => console.log(...args), error: (...args) => console.error(...args),
        debug: (event, details) => {
            if (debug) console.log(`[DEBUG ${new Date().toISOString()}] ${event} ${inspect(details, {
                depth: 6, maxArrayLength: 20, maxStringLength: 300, breakLength: Infinity, compact: true, colors: false
            })}`);
        }
    };
}
module.exports = { createLogger };
