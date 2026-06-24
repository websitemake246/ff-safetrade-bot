require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN required in .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').filter(Boolean));

function adminOnly(msg) {
  return ADMIN_IDS.has(String(msg.from?.id));
}

const state = {
  data() {
    const row = db.get(data => data.users.find(u => u.telegramId === String(this.chatId)));
    return row || { step: 'idle', details: {}, deals: [] };
  },
  set(data) {
    const idx = db.get(data => data.users.findIndex(u => u.telegramId === String(this.chatId)));
    if (idx === undefined || idx === -1) {
      db.run(data => {
        data.users.push({
          telegramId: String(this.chatId),
          username: String(this.username || ''),
          name: String(this.name || ''),
          step: data.step,
          details: data.details || {},
          deals: data.deals || [],
          created_at: new Date().toISOString()
        });
      });
      return;
    }
    db.run(data => { data.users[idx] = { ...data.users[idx], ...data }; });
  },
  chatId: null,
  username: null,
  name: null
};

function start(uid, chatId, username, name) {
  state.chatId = chatId;
  state.username = username;
  state.name = name;
  const person = state.data();
  if (!person || !person.telegramId) {
    state.set({ step: 'idle' });
  }
  bot.sendMessage(chatId,
    '👋 Welcome to *FF SafeTrade* - Free Fire Account Middleman\n\n' +
    'Buy & sell FF accounts safely. No scam. No stress.\n\n' +
    '⚠️ Game accounts violate Garena ToS. Trade at your own risk.',
    { parse_mode: 'Markdown', reply_markup: mainMenu(uid) });
}

function mainMenu(uid) {
  return {
    keyboard: [
      ['📋 List Account', '🛒 Browse Listings'],
      ['📦 My Deals', 'ℹ️ Help']
    ],
    resize_keyboard: true
  };
}

bot.onText(/\/start/, (msg) => {
  if (!msg.chat || !msg.from) return;
  start(msg.from.id, msg.chat.id, msg.from.username || '', `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim());
});

bot.onText(/\/sell/, (msg) => {
  if (!msg.chat || !msg.from) return;
  state.chatId = msg.chat.id;
  state.username = msg.from.username || '';
  state.name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
  state.chatId = msg.chat.id;
  state.set({ step: 'listing_rank' });
  bot.sendMessage(msg.chat.id, '📝 Enter FF account *Rank* (e.g. Heroic, Legendary):', { parse_mode: 'Markdown' });
});

bot.onText(/\/listings/, (msg) => {
  if (!msg.chat) return;
  state.chatId = msg.chat.id;
  const rows = db.get(data => data.listings.filter(l => l.status === 'open').slice().reverse());
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'No listings yet.');
  let text = '📋 *Open Listings*\n\n';
  rows.forEach((l, i) => {
    text += `${i+1}. ${l.rank} Lv.${l.level}\nSkins: ${l.skins || 'None'}\nPrice: ₦${Number(l.price).toLocaleString()}\nSeller: @${l.sellerUsername || 'unknown'}\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/deals/, (msg) => {
  if (!msg.chat) return;
  state.chatId = msg.chat.id;
  const user = state.data();
  if (!user || !user.deals || !user.deals.length) return bot.sendMessage(msg.chat.id, 'No deals yet.');
  let text = '📦 *My Deals*\n\n';
  user.deals.forEach((d, i) => {
    text += `${i+1}. Deal ${d.id.slice(0,8)}\nStatus: ${d.status.toUpperCase()}\nPrice: ₦${Number(d.price || d.amount || 0).toLocaleString()}\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  if (!msg.chat) return;
  bot.sendMessage(msg.chat.id,
    'ℹ️ *FF SafeTrade Help*\n\n' +
    'Commands:\n' +
    '/start - Main menu\n' +
    '/sell - List an FF account\n' +
    '/listings - Browse accounts\n' +
    '/deals - View my trades\n' +
    '/help - Show this message\n\n' +
    '⚠️ Game accounts violate Garena ToS. Trade at your own risk.',
    { parse_mode: 'Markdown' });
});

bot.on('message', (msg) => {
  if (!msg.chat || !msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id.toString();
  state.chatId = msg.chat.id;
  state.username = msg.from?.username || '';
  state.name = `${msg.from?.first_name || ''} ${msg.from?.last_name || ''}`.trim();
  const user = state.data();
  if (!user) return;

  if (user.step === 'listing_rank') {
    state.set({ step: 'listing_level' });
    bot.sendMessage(msg.chat.id, 'Enter *Level*:', { parse_mode: 'Markdown' });
  } else if (user.step === 'listing_level') {
    state.set({ step: 'listing_skins', tempLevel: msg.text });
    bot.sendMessage(msg.chat.id, 'Enter *Skins* (comma separated):', { parse_mode: 'Markdown' });
  } else if (user.step === 'listing_skins') {
    state.set({ step: 'listing_price', tempSkins: msg.text });
    bot.sendMessage(msg.chat.id, 'Enter *Price* (₦):', { parse_mode: 'Markdown' });
  } else if (user.step === 'listing_price') {
    state.set({ step: 'listing_proof', tempPrice: msg.text });
    bot.sendMessage(msg.chat.id, 'Send *Recovery Proof* link or screenshot:', { parse_mode: 'Markdown' });
  } else if (user.step === 'listing_proof') {
    const rank = (state.data().tempRank || 'Unknown');
    const level = Number(state.data().tempLevel || 0);
    const skins = state.data().tempSkins || '';
    const price = Number(state.data().tempPrice || 0);
    const proof = msg.text || msg.caption || '';
    const id = uuidv4();
    db.run(data => {
      data.listings.push({
        id,
        user_id: user.id || 0,
        sellerTelegramId: chatId,
        sellerUsername: state.username || '',
        rank, level, skins, price, proof,
        status: 'open',
        created_at: new Date().toISOString()
      });
    });
    state.set({ step: 'idle' });
    bot.sendMessage(msg.chat.id, '✅ Listing created!', mainMenu(msg.from.id));
  }
});

bot.on('callback_query', (ctx) => {
  if (!ctx.from || !ctx.message) return;
  const chatId = String(ctx.from.id);
  state.chatId = ctx.message.chat.id;
  state.username = ctx.from.username || '';
  state.name = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
  const user = state.data();
  const action = String(ctx.data || '');

  if (action.startsWith('buy_')) {
    const listingId = action.replace('buy_', '');
    const listing = db.get(data => data.listings.find(l => l.id === listingId));
    if (!listing) return ctx.answerCbQuery({ text: 'Listing not found', show_alert: true });
    if (String(listing.sellerTelegramId) === chatId) return ctx.answerCbQuery({ text: 'Cannot buy your own listing', show_alert: true });
    const dealId = String(uuidv4());
    const deal = {
      id: dealId,
      listingId,
      buyerTelegramId: chatId,
      buyerUsername: state.username || '',
      sellerTelegramId: listing.sellerTelegramId,
      sellerUsername: listing.sellerUsername || '',
      price: listing.price,
      status: 'pending',
      recovery_details: '',
      recovery_expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.run(data => {
      data.deals.push(deal);
      const l = data.listings.find(x => x.id === listingId);
      if (l) l.status = 'sold';
      const buyer = data.users.find(u => u.telegramId === chatId);
      if (buyer) buyer.deals = buyer.deals || [];
      if (buyer) buyer.deals.push(dealId);
      const seller = data.users.find(u => u.telegramId === String(listing.sellerTelegramId));
      if (seller) seller.deals = seller.deals || [];
      if (seller) seller.deals.push(dealId);
    });
    ctx.editMessageText(`✅ Deal created!\nDeal ID: ${dealId.slice(0,8)}\nPrice: ₦${Number(listing.price).toLocaleString()}\nStatus: PENDING`,
      { reply_markup: { inline_keyboard: [
        [{ text: 'Confirm Recovery', callback_data: 'confirm_pay_' + dealId }],
        [{ text: 'Cancel', callback_data: 'cancel_deal_' + dealId }]
      ]}});
    ctx.answerCbQuery();
    return;
  }

  if (action.startsWith('confirm_pay_')) {
    const dealId = action.replace('confirm_pay_', '');
    ctx.editMessageText('Payment is held in escrow. Share recovery details now.', {
      reply_markup: { inline_keyboard: [[{ text: 'Done', callback_data: 'done_recovery_' + dealId }]] }
    });
    ctx.answerCbQuery();
    return;
  }

  if (action.startsWith('done_recovery_')) {
    const dealId = action.replace('done_recovery_', '');
    bot.sendMessage(state.chatId, 'Enter recovery details (password/email/OG player ID).');
    ctx.answerCbQuery();
    return;
  }

  if (action.startsWith('cancel_deal_')) {
    const dealId = action.replace('cancel_deal_', '');
    db.run(data => {
      const deal = data.deals.find(d => d.id === dealId);
      if (deal && deal.buyerTelegramId === chatId) {
        deal.status = 'cancelled';
        const l = data.listings.find(x => x.id === deal.listingId);
        if (l) l.status = 'open';
      }
    });
    ctx.editMessageText('❌ Deal cancelled.');
    ctx.answerCbQuery();
    return;
  }

  ctx.answerCbQuery();
});

bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = String(msg.chat.id);
  const user = state.data();
  if (!user) return;
  if (msg.text.startsWith('📋 List Account')) return bot.sendMessage(msg.chat.id, 'Use /sell to list an account.');
  if (msg.text.startsWith('🛒 Browse Listings')) return bot.processText(msg);
  if (msg.text.startsWith('📦 My Deals')) return bot.processText(msg);
  if (msg.text.startsWith('ℹ️ Help')) return bot.processText(msg);
});

bot.on('text', (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  bot.emit('message', msg);
});

bot.onText(/\/admin/, (msg) => {
  if (!adminOnly(msg)) return;
  const deals = db.get(data => data.deals.slice().reverse());
  let text = '🛠 *Admin - Recent Deals*\n\n';
  deals.forEach((d, i) => {
    text += `${i+1}. ID:${d.id.slice(0,8)} | ₦${Number(d.price).toLocaleString()} | ${d.status}\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

console.log('FF SafeTrade bot polling...');
