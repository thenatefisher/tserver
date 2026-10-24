/** Own validated notice snapshots; persist replacements before making them visible. */
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { validate } = require('../contracts');

class SystemMessages {
    constructor({ systemMessages = [], systemMessagesFile } = {}) {
        this.file = systemMessagesFile;
        const initial = this.file && fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : systemMessages;
        this.messages = structuredClone(validate('system-messages', initial));
    }
    current() { return structuredClone(this.messages); }
    publish(next) {
        const snapshot = structuredClone(validate('system-messages', next));
        if (this.file) {
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            try {
                fs.writeFileSync(temporary, JSON.stringify(snapshot) + '\n', { mode: 0o600, flag: 'wx' });
                fs.renameSync(temporary, this.file);
            } finally { fs.rmSync(temporary, { force: true }); }
        }
        this.messages = snapshot;
    }
}
module.exports = { SystemMessages };
