const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'database');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function read() {
  if (!fs.existsSync(DATA_FILE)) return { users: [], listings: [], deals: [], messages: [], ratings: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch (e) { return { users: [], listings: [], deals: [], messages: [], ratings: [] }; }
}

function write(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function init() {
  const data = read();
  ['users', 'listings', 'deals', 'messages', 'ratings'].forEach(k => { if (!Array.isArray(data[k])) data[k] = []; });
  write(data);
}

const db = {
  run(fn) {
    init();
    const data = read();
    fn(data);
    write(data);
  },
  get(fn) {
    init();
    const data = read();
    return fn(data);
  }
};

module.exports = { db };
