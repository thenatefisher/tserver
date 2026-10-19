/**
 * Create normal and opt-in timestamped debug logging functions.
 * Inputs: Debug-enabled flag and log messages/details.
 * Outputs: A logger object with info, error and debug methods.
 * Side effects: Writes bounded diagnostic text to stdout/stderr; no network sends or tick logs.
 * Coupling: Used by server lifecycle, HTTP, sockets and discovery.
 */
const { inspect } = require('node:util');
/** Create bounded diagnostic writers; output occurs only when methods are called. */
function createLogger(debug = false) {
    return {
        /** Write ordinary lifecycle information to stdout; returns no value. */
        info: (...args) => console.log(...args),
        /** Write failure diagnostics to stderr; returns no value. */
        error: (...args) => console.error(...args),
        /** Write bounded timestamped details when enabled; otherwise do nothing. */
        debug: (event, details) => {
            if (debug) console.log(`[DEBUG ${new Date().toISOString()}] ${event} ${inspect(details, {
                depth: 6, maxArrayLength: 20, maxStringLength: 300, breakLength: Infinity, compact: true, colors: false
            })}`);
        }
    };
}
module.exports = { createLogger };
