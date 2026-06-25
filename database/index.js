const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, 'database');
if (!require('fs').existsSync(DATA_DIR)) {
  require('fs').mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'ff_safetrade.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE,
    username TEXT,
    name TEXT,
    email TEXT UNIQUE,
    password_hash TEXT,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    rank TEXT DEFAULT '',
    level INTEGER DEFAULT 0,
    skins TEXT DEFAULT '',
    price REAL DEFAULT 0,
    proof TEXT DEFAULT '',
    status TEXT DEFAULT 'open',
    seller_telegram_id TEXT,
    seller_username TEXT DEFAULT '',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );
  CREATE TABLE IF NOT EXISTS deals (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    buyer_id INTEGER NOT NULL REFERENCES users(id),
    seller_id INTEGER NOT NULL REFERENCES users(id),
    amount REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    recovery_details TEXT DEFAULT '',
    recovery_expires_at TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    deal_id TEXT NOT NULL REFERENCES deals(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT DEFAULT '',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );
  CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    deal_id TEXT NOT NULL REFERENCES deals(id),
    from_user INTEGER NOT NULL REFERENCES users(id),
    to_user INTEGER NOT NULL REFERENCES users(id),
    score INTEGER,
    comment TEXT DEFAULT '',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );
  CREATE TABLE IF NOT EXISTS bot_state (
    telegram_id TEXT PRIMARY KEY,
    step TEXT DEFAULT 'idle',
    details TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );
`);

const insertUser = db.prepare(
  'INSERT INTO users (telegram_id, username, name, role) VALUES (@telegram_id, @username, @name, @role)'
);
const findUserByTelegram = db.prepare('SELECT * FROM users WHERE telegram_id = ?');
const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const listOpenListings = db.prepare(
  'SELECT l.*, u.username AS seller_username FROM listings l JOIN users u ON l.user_id = u.id WHERE l.status = ? ORDER BY l.id DESC'
);
const insertListing = db.prepare(
  'INSERT INTO listings (id, user_id, rank, level, skins, price, proof, status, seller_telegram_id, seller_username) VALUES (@id, @user_id, @rank, @level, @skins, @price, @proof, @status, @seller_telegram_id, @seller_username)'
);
const findListing = db.prepare('SELECT * FROM listings WHERE id = ? AND status = ?');
const insertDeal = db.prepare(
  'INSERT INTO deals (id, listing_id, buyer_id, seller_id, amount, status) VALUES (@id, @listing_id, @buyer_id, @seller_id, @amount, @status)'
);
const updateListingSold = db.prepare('UPDATE listings SET status = ? WHERE id = ?');
const updateListingStatusById = db.prepare(
  'UPDATE listings SET status = ? WHERE id = ?'
);
const findDeal = db.prepare(
  'SELECT d.*, l.price, u1.username AS buyer_username, u2.username AS seller_username, u1.telegram_id AS buyer_telegram_id, u2.telegram_id AS seller_telegram_id FROM deals d JOIN listings l ON d.listing_id = l.id JOIN users u1 ON d.buyer_id = u1.id JOIN users u2 ON d.seller_id = u2.id WHERE d.id = ?'
);
const updateDeal = db.prepare(
  'UPDATE deals SET status = COALESCE(?, status), recovery_details = COALESCE(?, recovery_details), recovery_expires_at = COALESCE(?, recovery_expires_at), updated_at = datetime(' +
  "'now') WHERE id = ?"
);
const findDealsForUser = db.prepare(
  'SELECT d.*, l.price, u1.username AS buyer_username, u2.username AS seller_username FROM deals d JOIN listings l ON d.listing_id = l.id JOIN users u1 ON d.buyer_id = u1.id JOIN users u2 ON d.seller_id = u2.id WHERE ? IN (d.buyer_id, d.seller_id) ORDER BY d.id DESC'
);
const insertMessage = db.prepare(
  'INSERT INTO messages (id, deal_id, sender_id, body) VALUES (@id, @deal_id, @sender_id, @body)'
);
const findMessages = db.prepare(
  'SELECT m.*, u.username FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.deal_id = ? ORDER BY m.id ASC'
);
const insertRating = db.prepare(
  'INSERT INTO ratings (id, deal_id, from_user, to_user, score, comment) VALUES (@id, @deal_id, @from_user, @to_user, @score, @comment)'
);

const getBotState = db.prepare('SELECT * FROM bot_state WHERE telegram_id = ?');
const upsertBotState = db.prepare(
  'INSERT INTO bot_state (telegram_id, step, details) VALUES (@telegram_id, @step, @details) ON CONFLICT(telegram_id) DO UPDATE SET step = excluded.step, details = excluded.details, updated_at = CURRENT_TIMESTAMP'
);
const updateBotState = db.prepare(
  'UPDATE bot_state SET step = ?, details = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?'
);

const claimDealAsBuyer = db.prepare(
  'UPDATE deals SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
);
const claimDealAsSeller = db.prepare(
  "UPDATE deals SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
);

const setUserSellerTelegram = db.prepare(
  'UPDATE users SET telegram_id = @telegram_id WHERE id = @user_id'
);

const tx = db.transaction(() => {});

module.exports = {
  db,
  insertUser,
  findUserByTelegram,
  findUserByEmail,
  listOpenListings,
  insertListing,
  findListing,
  insertDeal,
  updateListingSold,
  updateListingStatusById,
  findDeal,
  updateDeal,
  findDealsForUser,
  insertMessage,
  findMessages,
  insertRating,
  getBotState,
  upsertBotState,
  updateBotState,
  claimDealAsBuyer,
  claimDealAsSeller,
  setUserSellerTelegram
};
