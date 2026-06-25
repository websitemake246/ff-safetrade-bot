const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, 'database');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  listings: path.join(DATA_DIR, 'listings.json'),
  deals: path.join(DATA_DIR, 'deals.json'),
  messages: path.join(DATA_DIR, 'messages.json'),
  ratings: path.join(DATA_DIR, 'ratings.json'),
  bot_state: path.join(DATA_DIR, 'bot_state.json'),
};

function load(name) {
  try {
    if (fs.existsSync(FILES[name])) return JSON.parse(fs.readFileSync(FILES[name], 'utf8'));
  } catch (e) {
    console.error('Failed to load', name, e.message);
  }
  return [];
}

function save(name, data) {
  try {
    fs.writeFileSync(FILES[name], JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save', name, e.message);
  }
}

const now = () => new Date().toISOString();

const insertUser = {
  run(params) {
    const users = load('users');
    const id = users.length ? Math.max(...users.map(u => u.id || 0)) + 1 : 1;
    const row = Object.assign({ id, created_at: now() }, params);
    users.push(row);
    save('users', users);
    return { lastInsertRowid: id, changes: 1 };
  }
};
const findUserByTelegram = {
  get(val) {
    const users = load('users');
    return users.find(u => u.telegram_id === val) || null;
  }
};
const findUserByEmail = {
  get(val) {
    const users = load('users');
    return users.find(u => u.email === val) || null;
  }
};
const listOpenListings = {
  all() {
    const listings = load('listings');
    return listings.filter(item => item.status === 'open').reverse();
  }
};
const insertListing = {
  run(params) {
    const listings = load('listings');
    const row = Object.assign({ id: uuidv4(), created_at: now() }, params);
    listings.push(row);
    save('listings', listings);
    return { lastInsertRowid: row.id, changes: 1 };
  }
};
const findListing = {
  get(id, status) {
    const listings = load('listings');
    return listings.find(item => item.id === id && (!status || item.status === status)) || null;
  }
};
const insertDeal = {
  run(params) {
    const deals = load('deals');
    const row = Object.assign({ id: uuidv4(), created_at: now(), updated_at: now() }, params);
    deals.push(row);
    save('deals', deals);
    return { lastInsertRowid: row.id, changes: 1 };
  }
};
const updateListingSold = {
  run(status, id) {
    const listings = load('listings');
    const item = listings.find(x => x.id === id);
    if (item) item.status = status;
    save('listings', listings);
    return { changes: item ? 1 : 0 };
  }
};
const updateListingStatusById = updateListingSold;
const findDeal = {
  get(id) {
    const deals = load('deals');
    return deals.find(item => item.id === id) || null;
  }
};
const updateDeal = {
  run(status, recovery_details, recovery_expires_at, id) {
    const deals = load('deals');
    const item = deals.find(x => x.id === id);
    if (!item) return { changes: 0 };
    if (status !== null && status !== undefined) item.status = status;
    if (recovery_details !== null && recovery_details !== undefined) item.recovery_details = recovery_details;
    if (recovery_expires_at !== null && recovery_expires_at !== undefined) item.recovery_expires_at = recovery_expires_at;
    item.updated_at = now();
    save('deals', deals);
    return { changes: 1 };
  }
};
const findDealsForUser = {
  all(userId) {
    const deals = load('deals');
    return deals.filter(item => item.buyer_id === userId || item.seller_id === userId).reverse();
  }
};
const insertMessage = {
  run(params) {
    const messages = load('messages');
    const row = Object.assign({ id: uuidv4(), created_at: now() }, params);
    messages.push(row);
    save('messages', messages);
    return { lastInsertRowid: row.id, changes: 1 };
  }
};
const findMessages = {
  all(dealId) {
    const messages = load('messages');
    return messages.filter(item => item.deal_id === dealId);
  }
};
const insertRating = {
  run(params) {
    const ratings = load('ratings');
    const row = Object.assign({ id: uuidv4(), created_at: now() }, params);
    ratings.push(row);
    save('ratings', ratings);
    return { lastInsertRowid: row.id, changes: 1 };
  }
};
const getBotState = {
  get(telegramId) {
    const states = load('bot_state');
    return states.find(item => item.telegram_id === telegramId) || null;
  }
};
const upsertBotState = {
  run(params) {
    const states = load('bot_state');
    const idx = states.findIndex(item => item.telegram_id === params.telegram_id);
    const row = Object.assign({ telegram_id: params.telegram_id, step: params.step || 'idle', details: typeof params.details === 'string' ? params.details : JSON.stringify(params.details || {}), updated_at: now() });
    if (idx >= 0) states[idx] = row;
    else states.push(row);
    save('bot_state', states);
    return { lastInsertRowid: params.telegram_id, changes: 1 };
  }
};
const updateBotState = {
  run(details, step, telegramId) {
    const states = load('bot_state');
    const idx = states.findIndex(item => item.telegram_id === telegramId);
    const row = { telegram_id: telegramId, step: step || 'idle', details: typeof details === 'string' ? details : JSON.stringify(details || {}), updated_at: now() };
    if (idx >= 0) states[idx] = row;
    else states.push(row);
    save('bot_state', states);
    return { changes: 1 };
  }
};
const claimDealAsBuyer = {
  run(id) {
    const deals = load('deals');
    const item = deals.find(x => x.id === id);
    if (item) item.updated_at = now();
    save('deals', deals);
    return { changes: item ? 1 : 0 };
  }
};
const claimDealAsSeller = {
  run(id) {
    const deals = load('deals');
    const item = deals.find(x => x.id === id);
    if (item) {
      item.status = 'completed';
      item.updated_at = now();
    }
    save('deals', deals);
    return { changes: item ? 1 : 0 };
  }
};
const setUserSellerTelegram = {
  run(params) {
    const users = load('users');
    const item = users.find(x => x.id === params.user_id);
    if (item) item.telegram_id = params.telegram_id;
    save('users', users);
    return { changes: item ? 1 : 0 };
  }
};

const tx = {
  run(fn) { return fn(); }
};

module.exports = {
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
  setUserSellerTelegram,
  tx
};
