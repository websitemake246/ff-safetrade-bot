require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default;
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN required in .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

const formatCurrency = (value) => {
  if (!Number.isFinite(Number(value))) {
    return '₦0';
  }
  return `₦${Number(value).toLocaleString()}`;
};

const renderStatus = (status) => {
  if (!status) return status;
  return status.toUpperCase();
};

const ensureListingState = (deal) => {
  if (!deal) return null;
  const stage = (deal.status || '').toLowerCase();
  const requestedRecovery = (deal.recovery_details || '').toString().trim();
  const recoveryOnFile = Boolean(requestedRecovery) && requestedRecovery !== 'null';

  if (stage === 'pending' || stage === 'paid') {
    if (recoveryOnFile) {
      return 'pending_recovery';
    }
    return stage;
  }

  if (stage === 'delivered') {
    if (recoveryOnFile) {
      return 'pending_recovery';
    }
    return 'completed';
  }

  if (stage === 'completed' || stage === 'disputed') {
    if (recoveryOnFile) {
      return 'pending_recovery';
    }
    return stage;
  }

  return stage || 'pending';
};

const renderDealSummary = (deal) => {
  if (!deal) return 'No deal found.';
  const id = String(deal.id || '').slice(0, 8);
  const price = formatCurrency(deal.price || deal.amount || 0);
  const seller = `@${deal.seller_username || 'seller'}`;
  const buyer = `@${deal.buyer_username || 'buyer'}`;
  const recoveryOnFile = Boolean(deal.recovery_details);
  return (
    `Deal ID: \`${id}\`\n` +
    `Status: *${renderStatus(deal.status)}*\n` +
    `Price: ${price}\n` +
    `Seller: ${seller}\n` +
    `Buyer: ${buyer}\n` +
    `Recovery shared: ${recoveryOnFile ? 'Yes' : 'No'}`
  );
};

const renderListing = (listing, index) => {
  const price = formatCurrency(listing.price || listing.amount || 0);
  return (
    `${index + 1}. ${listing.rank || 'Account'} Lv.${listing.level || '?'}\n` +
    `Skins: ${listing.skins || 'None'}\n` +
    `Price: ${price}\n` +
    `Seller: @${listing.seller_username || 'seller'}\n`
  );
};

const notifyAdmins = async (text, extra = {}) => {
  const message = Object.entries({ ...extra, text })
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.sendMessage(adminId, `🛠 *Admin Alert*\n${message}`, {
        parse_mode: 'Markdown',
      });
    } catch (e) {
      // ignore blocked / invalid admin chats
    }
  }
};

const notifyDealParticipants = async (deal, text) => {
  if (!deal) return;
  for (const telegramId of [
    String(deal.buyer_telegram_id || ''),
    String(deal.seller_telegram_id || ''),
  ]) {
    if (!telegramId) continue;
    try {
      await bot.sendMessage(telegramId, text, { parse_mode: 'Markdown' });
    } catch (e) {
      // ignore failed deliveries
    }
  }
};

const ensureUser = (msg) => {
  const telegramId = String(msg.from?.id || '');
  const username =
    String(msg.from?.username || '').replace(/^@/, '');
  const name = `${msg.from?.first_name || ''} ${msg.from?.last_name || ''}`
    .trim();

  if (!telegramId) {
    return null;
  }

  let user = db.findUserByTelegram.get(telegramId);
  if (!user) {
    const info = db.insertUser.run({
      telegram_id: telegramId,
      username,
      name,
      role: 'user',
    });
    user = { id: info.lastInsertRowid, telegram_id: telegramId, username, name, role: 'user' };
  }
  return user;
};

const setConversation = (telegramId, step, details = {}) => {
  const existing = db.getBotState.get(telegramId);
  if (existing) {
    db.updateBotState.run(JSON.stringify(details || {}), step, telegramId);
    return;
  }
  db.upsertBotState.run({
    telegram_id: telegramId,
    step,
    details: JSON.stringify(details || {}),
  });
};

const getConversation = (telegramId) => {
  const existing = db.getBotState.get(telegramId);
  if (!existing) {
    return null;
  }
  try {
    return {
      step: existing.step || 'idle',
      details: JSON.parse(existing.details || '{}'),
    };
  } catch (e) {
    return { step: existing.step || 'idle', details: {} };
  }
};

const clearConversation = (telegramId) => {
  db.updateBotState.run('{}', 'idle', telegramId);
};

const mainMenu = () => {
  return {
    reply_markup: {
      keyboard: [
        ['📋 List Account', '🛒 Browse Listings'],
        ['📦 My Deals', 'ℹ️ Help'],
      ],
      resize_keyboard: true,
    },
  };
};

bot.onText(/\/start/, async (msg) => {
  if (!msg.chat || !msg.from) return;
  const chatId = String(msg.chat.id);
  const telegramId = String(msg.from.id);
  const user = ensureUser(msg);
  if (!user) {
    return;
  }

  const conversation = getConversation(telegramId);
  if (conversation && conversation.step !== 'idle') {
    await bot.sendMessage(
      chatId,
      '⚠️ You have an unfinished action.\nChoose how to continue:',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Continue',
                callback_data: `resume_conversation_${telegramId}`,
              },
              {
                text: 'Cancel',
                callback_data: `cancel_conversation_${telegramId}`,
              },
            ],
          ],
        },
      }
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    '👋 Welcome to *FF SafeTrade* - Free Fire Account Middleman\n\n' +
      'Buy & sell FF accounts safely. No scam. No stress.\n\n' +
      '⚠️ Game accounts may violate Garena ToS. Trade at your own risk.',
    {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    }
  );
});

bot.on('callback_query', async (ctx) => {
  if (!ctx.from || !ctx.message) {
    if (ctx.from) {
      try {
        await ctx.answerCbQuery({ text: 'Action not allowed here.' });
      } catch (e) {
        // ignore answer failures
      }
    }
    return;
  }
  const chatId = String(ctx.message.chat.id);
  const telegramId = String(ctx.from.id);
  const action = String(ctx.data || '');

  try {
    await ctx.answerCbQuery('Processing...');
  } catch (e) {
    // avoid duplicate-answer errors
  }

  const handleResume = async () => {
    if (action.startsWith('resume_conversation_')) {
      const conversation = getConversation(telegramId);
      if (!conversation || conversation.step === 'idle') {
        await bot.sendMessage(chatId, 'No active conversation to resume.', {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        });
        return true;
      }
      await bot.sendMessage(
        chatId,
        'Resuming your last step. Please continue where you left off.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Discard',
                  callback_data: `cancel_conversation_${telegramId}`,
                },
              ],
            ],
          },
        }
      );
      return true;
    }

    if (action.startsWith('cancel_conversation_')) {
      clearConversation(telegramId);
      await bot.sendMessage(
        chatId,
        'Your pending action was discarded.',
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      return true;
    }

    return false;
  };

  if (await handleResume()) return;

  if (action.startsWith('buy_')) {
    const listingId = action.replace('buy_', '');
    const listing = db.findListing.get(listingId);
    if (!listing) {
      await bot.sendMessage(chatId, 'Listing is no longer available.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const sellerTelegramId = String(listing.seller_telegram_id || '');
    if (sellerTelegramId === telegramId) {
      await bot.sendMessage(chatId, 'You cannot buy your own listing.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const dealId = uuidv4();
    db.insertDeal.run({
      id: dealId,
      listing_id: listingId,
      buyer_id: null,
      seller_id: null,
      amount: listing.price,
      status: 'pending',
    });
    db.updateListingSold.run(listingId);
    const deal = db.findDeal.get(dealId);
    await notifyAdmins('New deal created', {
      deal_id: dealId,
      price: formatCurrency(listing.price),
    });
    await bot.sendMessage(
      chatId,
      `✅ Deal created!\nDeal ID: \`${dealId.slice(0, 8)}\`\nPrice: ${formatCurrency(listing.price)}\nStatus: PENDING\n\nReply with /claim \`${dealId.slice(0, 8)}\` to confirm your role.`,
      {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      }
    );
    return;
  }

  if (action.startsWith('claim_')) {
    const dealId = action.replace('claim_', '');
    const deal = db.findDeal.get(dealId);
    if (!deal) {
      await bot.sendMessage(chatId, 'Deal not found.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const buyerTelegramId = String(deal.buyer_telegram_id || '');
    const sellerTelegramId = String(deal.seller_telegram_id || '');
    const stage = ensureListingState(deal);
    const requestedRecovery = Boolean(
      deal.recovery_details && deal.recovery_details !== 'null'
    );

    if (buyerTelegramId === telegramId) {
      if (stage !== 'pending' || requestedRecovery) {
        await bot.sendMessage(
          chatId,
          'Deal cannot be claimed anymore. Use /status to check current progress.',
          {
            reply_markup: {
              keyboard: [
                ['📋 List Account', '🛒 Browse Listings'],
                ['📦 My Deals', 'ℹ️ Help'],
              ],
              resize_keyboard: true,
            },
          }
        );
        return;
      }
      db.updateDeal.run(null, deal.recovery_details, dealId);
      const refreshed = db.findDeal.get(dealId);
      await bot.sendMessage(
        chatId,
        `🛒 You took the buyer role.\n\n${renderDealSummary(refreshed)}`,
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      await notifyDealParticipants(
        refreshed,
        `Deal \`${dealId.slice(0, 8)}\` buyer confirmed.\n`
      );
      return;
    }

    if (sellerTelegramId === telegramId) {
      if (stage !== 'pending' || !requestedRecovery) {
        await bot.sendMessage(
          chatId,
          'You can only deliver if the buyer has paid.',
          {
            reply_markup: {
              keyboard: [
                ['📋 List Account', '🛒 Browse Listings'],
                ['📦 My Deals', 'ℹ️ Help'],
              ],
              resize_keyboard: true,
            },
          }
        );
        return;
      }
      db.updateDeal.run('completed', deal.recovery_details, dealId);
      const refreshed = db.findDeal.get(dealId);
      await bot.sendMessage(
        chatId,
        `🚚 You marked the account as delivered.\n\n${renderDealSummary(refreshed)}`,
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      await notifyDealParticipants(
        refreshed,
        `Deal \`${dealId.slice(0, 8)}\` delivery confirmed.\n`
      );
      return;
    }

    await bot.sendMessage(chatId, 'You are not a party to this deal.', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (action.startsWith('confirm_pay_')) {
    await ctx.editMessageText(
      '💳 Payment is held in escrow. Share the recovery details (email or password) below.'
    );
    setConversation(telegramId, 'payment_confirmation', {
      dealId: action.replace('confirm_pay_', ''),
    });
    return;
  }

  if (action.startsWith('cancel_deal_')) {
    const dealId = action.replace('cancel_deal_', '');
    const deal = db.findDeal.get(dealId);
    if (!deal) {
      await ctx.editMessageText('❌ Deal not found.');
      return;
    }
    if (String(deal.buyer_telegram_id || '') !== telegramId) {
      await ctx.editMessageText('❌ Only the buyer can cancel this deal.');
      return;
    }
    if (String(deal.status || '').toLowerCase() !== 'pending') {
      await ctx.editMessageText('❌ This deal can no longer be cancelled.');
      return;
    }
    db.updateListingSold.run(deal.listing_id);
    db.updateDeal.run('cancelled', deal.recovery_details, dealId);
    await bot.sendMessage(
      chatId,
      `❌ Deal cancelled.\n\n${renderDealSummary(db.findDeal.get(dealId))}`,
      {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      }
    );
    await notifyDealParticipants(
      db.findDeal.get(dealId),
      `Deal \`${dealId.slice(0, 8)}\` was cancelled.\n`
    );
    return;
  }

  if (action.startsWith('done_recovery_')) {
    await ctx.editMessageText(
      '📨 Send your recovery details in the next message (password, email or OG player ID).'
    );
    setConversation(telegramId, 'collecting_recovery', {
      dealId: action.replace('done_recovery_', ''),
    });
    return;
  }

  if (action.startsWith('status_update_')) {
    const parts = action.replace('status_update_', '').split('_');
    const dealId = parts[0];
    const rawStatus = parts.slice(1).join('_');
    const deal = db.findDeal.get(dealId);
    if (!deal) {
      await bot.sendMessage(chatId, 'Deal not found.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const stage = ensureListingState(deal);
    const requestedRecovery = Boolean(
      deal.recovery_details && deal.recovery_details !== 'null'
    );
    const telegramRole = String(deal.buyer_telegram_id || '') === telegramId
      ? 'buyer'
      : String(deal.seller_telegram_id || '') === telegramId ? 'seller' : null;
    const canClaim = telegramRole === 'buyer' && stage === 'pending' && !requestedRecovery;
    const canRequestRecovery = telegramRole === 'buyer' && stage !== 'pending' && !requestedRecovery;
    const canDeliver = telegramRole === 'seller' && stage === 'pending' && requestedRecovery;
    const canDisputeRaw = (stage === 'pending' || stage === 'delivered' || stage === 'overdue') && !String(deal.status || '').match(/dispute|disputed/i);

    if (rawStatus === 'request_recovery' && !canRequestRecovery) {
      await bot.sendMessage(chatId, 'Request recovery is not needed now.');
      return;
    }
    if (rawStatus === 'deliver' && !canDeliver) {
      await bot.sendMessage(chatId, 'Delivery is not possible right now.');
      return;
    }
    if (rawStatus === 'claim' && !canClaim) {
      await bot.sendMessage(chatId, 'Claim is not available right now.');
      return;
    }
    if (rawStatus === 'dispute' && !canDisputeRaw) {
      await bot.sendMessage(chatId, 'This deal cannot be disputed anymore.');
      return;
    }

    setConversation(telegramId, 'actor_status_update', {
      dealId,
      rawStatus,
      role: telegramRole,
    });

    const prompt =
      rawStatus === 'request_recovery'
        ? 'Share your recovery details (credentials) now.'
        : rawStatus === 'deliver'
          ? 'Will you mark this deal as delivered?'
          : rawStatus === 'claim'
            ? 'Please confirm payment and role.'
            : rawStatus === 'dispute'
              ? 'Explain the issue for an admin review.'
              : 'Please proceed.';

    await bot.sendMessage(chatId, prompt, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Cancel', callback_data: `cancel_update_${dealId}` },
          ],
        ],
      },
    });
    return;
  }

  if (action.startsWith('cancel_update_')) {
    clearConversation(telegramId);
    await ctx.answerCbQuery('Update cancelled.');
    return;
  }
});

bot.on('message', async (msg) => {
  if (!msg.chat || !msg.text) {
    return;
  }
  const chatId = String(msg.chat.id);
  const telegramId = String(msg.from?.id || '');
  const user = ensureUser(msg);
  if (!user || !telegramId) {
    return;
  }

  const text = String(msg.text || '').trim();
  const commandMatcher = text.match(/^\/([A-Za-z0-9_]+)(?:\s+(.*))?$/);
  const command = commandMatcher ? commandMatcher[1].toLowerCase() : null;
  const commandPayload = commandMatcher ? (commandMatcher[2] || '').trim() : '';

  if (command === 'sell') {
    setConversation(telegramId, 'listing_rank', {});
    await bot.sendMessage(chatId, '📝 Enter FF account *Rank* (e.g. Heroic, Legendary):', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (command === 'listings') {
    const rows = db.listOpenListings.all();
    if (!rows.length) {
      await bot.sendMessage(chatId, 'No listings yet.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    let output = '📋 *Open Listings*\n\n';
    for (const [index, listing] of rows.entries()) {
      output += renderListing(listing, index);
    }
    await bot.sendMessage(chatId, output, {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (command === 'deals') {
    const deals = db.findDealsForUser.all(user.id);
    if (!deals.length) {
      await bot.sendMessage(chatId, 'No deals yet.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    let output = '📦 *My Deals*\n\n';
    for (const [index, deal] of deals.entries()) {
      output += `${index + 1}. \`${String(deal.id || '').slice(0, 8)}\` - ${renderStatus(deal.status)}\n`;
    }
    await bot.sendMessage(chatId, output, {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (command === 'claim') {
    const dealIdInput = commandPayload.replace(/[^a-zA-Z0-9-]/g, '');
    if (!dealIdInput) {
      await bot.sendMessage(chatId, 'Usage: /claim <dealId>', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const exact = db.findDeal.get(dealIdInput);
    const deal = exact || db.findDeal.all(
      'SELECT * FROM deals WHERE substr(id, 1, 8) = ?',
      dealIdInput
    )[0];
    if (!deal) {
      await bot.sendMessage(chatId, 'Deal not found.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const sellerTelegramId = String(deal.seller_telegram_id || '');
    const buyerTelegramId = String(deal.buyer_telegram_id || '');
    if (
      telegramId !== sellerTelegramId &&
      telegramId !== buyerTelegramId
    ) {
      await bot.sendMessage(chatId, 'You are not a party to this deal.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const stage = ensureListingState(deal);
    const requestedRecovery = Boolean(
      deal.recovery_details && deal.recovery_details !== 'null'
    );

    if (telegramId === buyerTelegramId) {
      if (stage !== 'pending' || requestedRecovery) {
        await bot.sendMessage(
          chatId,
          'Claim is unavailable. Proceed with /status.',
          {
            reply_markup: {
              keyboard: [
                ['📋 List Account', '🛒 Browse Listings'],
                ['📦 My Deals', 'ℹ️ Help'],
              ],
              resize_keyboard: true,
            },
          }
        );
        return;
      }
      db.updateDeal.run(null, deal.recovery_details, deal.id);
      const refreshed = db.findDeal.get(deal.id);
      await bot.sendMessage(
        chatId,
        `🛒 You confirmed payment.\n\n${renderDealSummary(refreshed)}`,
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      await notifyDealParticipants(
        refreshed,
        `Deal \`${String(refreshed.id || '').slice(0, 8)}\` buyer confirmed.\n`
      );
      return;
    }

    if (telegramId === sellerTelegramId) {
      if (stage !== 'pending' || !requestedRecovery) {
        await bot.sendMessage(
          chatId,
          'You cannot deliver before the buyer has paid.',
          {
            reply_markup: {
              keyboard: [
                ['📋 List Account', '🛒 Browse Listings'],
                ['📦 My Deals', 'ℹ️ Help'],
              ],
              resize_keyboard: true,
            },
          }
        );
        return;
      }
      db.updateDeal.run('completed', deal.recovery_details, deal.id);
      const refreshed = db.findDeal.get(deal.id);
      await bot.sendMessage(
        chatId,
        `🚚 Account delivered.\n\n${renderDealSummary(refreshed)}`,
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      await notifyDealParticipants(
        refreshed,
        `Deal \`${String(refreshed.id || '').slice(0, 8)}\` delivery confirmed.\n`
      );
      return;
    }

    await bot.sendMessage(chatId, 'Deal claim failed.', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (command === 'statuses') {
    const deals = db.findDealsForUser.all(user.id);
    let output = '📊 *Deal Statuses*\n\n';
    for (const [index, deal] of deals.entries()) {
      output += `${index + 1}. \`${String(deal.id || '').slice(0, 8)}\` => ${renderStatus(deal.status)}\n`;
    }
    await bot.sendMessage(chatId, output, {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (command === 'status') {
    const dealIdInput = commandPayload.replace(/[^a-zA-Z0-9-]/g, '');
    if (dealIdInput) {
      const exact = db.findDeal.get(dealIdInput);
      const deal = exact || db.findDeal.all(
        'SELECT * FROM deals WHERE substr(id, 1, 8) = ?',
        dealIdInput
      )[0];
      if (!deal) {
        await bot.sendMessage(chatId, 'Deal not found.', {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        });
        return;
      }
      const sellerTelegramId = String(deal.seller_telegram_id || '');
      const buyerTelegramId = String(deal.buyer_telegram_id || '');
      if (
        telegramId !== sellerTelegramId &&
        telegramId !== buyerTelegramId
      ) {
        await bot.sendMessage(chatId, 'Not authorized.', {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        });
        return;
      }
      await bot.sendMessage(chatId, renderDealSummary(deal), {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }

    const deals = db.findDealsForUser.all(user.id);
    if (!deals.length) {
      await bot.sendMessage(chatId, 'You have no deals.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    let output = '📦 *Select a deal*\n\n';
    for (const [index, deal] of deals.entries()) {
      output += `${index + 1}. \`${String(deal.id || '').slice(0, 8)}\` ${renderStatus(deal.status)}\n`;
    }
    await bot.sendMessage(chatId, output, {
      reply_markup: {
        inline_keyboard: deals.map((deal, index) => [
          {
            text: `${index + 1}. ${renderStatus(deal.status)}`,
            callback_data: `status_update_${deal.id}_status`,
          },
        ]),
      },
    });
    return;
  }

  if (command === 'dispute') {
    const dealIdInput = commandPayload.replace(/[^a-zA-Z0-9-]/g, '');
    if (!dealIdInput) {
      await bot.sendMessage(chatId, 'Usage: /dispute <dealId>', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const exact = db.findDeal.get(dealIdInput);
    const deal = exact || db.findDeal.all(
      'SELECT * FROM deals WHERE substr(id, 1, 8) = ?',
      dealIdInput
    )[0];
    if (!deal) {
      await bot.sendMessage(chatId, 'Deal not found.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const stage = ensureListingState(deal);
    const sellerTelegramId = String(deal.seller_telegram_id || '');
    const buyerTelegramId = String(deal.buyer_telegram_id || '');
    if (
      !['pending', 'delivered', 'overdue'].includes(stage) ||
      String(deal.status || '').match(/dispute|disputed/i)
    ) {
      await bot.sendMessage(chatId, 'This deal cannot be disputed.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    if (
      telegramId !== sellerTelegramId &&
      telegramId !== buyerTelegramId
    ) {
      await bot.sendMessage(chatId, 'Not authorized.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    setConversation(telegramId, 'collecting_dispute', { dealId: deal.id });
    await bot.sendMessage(
      chatId,
      '⚠️ Describe the issue in detail. An admin will be notified.',
      {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      }
    );
    return;
  }

  if (command === 'help') {
    await bot.sendMessage(
      chatId,
      'ℹ️ *FF SafeTrade Help*\n\n' +
        'Commands:\n' +
        '/start - Main menu\n' +
        '/sell - List an FF account\n' +
        '/listings - Browse accounts\n' +
        '/deals - View my trades\n' +
        '/claim <id> - Confirm payment or delivery\n' +
        '/status [id] - Get deal status\n' +
        '/statuses - List deal statuses\n' +
        '/dispute <id> - Open an admin dispute\n' +
        '/help - Show this message\n\n' +
        '⚠️ Game accounts may violate Garena ToS. Trade at your own risk.',
      {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      }
    );
    return;
  }

  if (text.startsWith('📋 List Account')) {
    await bot.sendMessage(chatId, 'Use /sell to list an account.', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (text.startsWith('🛒 Browse Listings')) {
    await bot.processText('/listings');
    return;
  }

  if (text.startsWith('📦 My Deals')) {
    await bot.processText('/deals');
    return;
  }

  if (text.startsWith('ℹ️ Help')) {
    await bot.processText('/help');
    return;
  }

  const conversation = getConversation(telegramId);
  if (!conversation || conversation.step === 'idle') {
    await bot.sendMessage(chatId, 'Use a command or button to continue.', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (conversation.step === 'listing_rank') {
    setConversation(telegramId, 'listing_level', { tempRank: text });
    await bot.sendMessage(chatId, 'Enter *Level*:', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }
  if (conversation.step === 'listing_level') {
    setConversation(telegramId, 'listing_skins', { tempLevel: text });
    await bot.sendMessage(chatId, 'Enter *Skins* (comma separated):', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }
  if (conversation.step === 'listing_skins') {
    setConversation(telegramId, 'listing_price', { tempSkins: text });
    await bot.sendMessage(chatId, 'Enter *Price* (₦):', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }
  if (conversation.step === 'listing_price') {
    const parsed = Number(String(text).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsed) || parsed < 0) {
      await bot.sendMessage(chatId, 'Enter a valid price.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    setConversation(telegramId, 'listing_proof', { tempPrice: parsed });
    await bot.sendMessage(
      chatId,
      'Send *Recovery Proof* link or screenshot:',
      {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      }
    );
    return;
  }
  if (conversation.step === 'listing_proof') {
    const state = getConversation(telegramId);
    const rank = state?.details?.tempRank || 'Unknown';
    const level = Number(state?.details?.tempLevel || 0);
    const skins = state?.details?.tempSkins || '';
    const price = Number(state?.details?.tempPrice || 0);
    const id = uuidv4();
    const proofText = msg.caption ? String(msg.caption).trim() : text;

    db.insertListing.run({
      id,
      user_id: user.id,
      rank,
      level,
      skins,
      price,
      proof: proofText,
      status: 'open',
      seller_telegram_id: String(msg.from?.id || ''),
      seller_username: user.username || '',
    });
    clearConversation(telegramId);
    await notifyAdmins('New listing created', {
      listing_id: id,
      price: formatCurrency(price),
    });
    await bot.sendMessage(
      chatId,
      '✅ Listing created!',
      {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      }
    );
    return;
  }
  if (conversation.step === 'collecting_recovery') {
    const { dealId } = conversation.details || {};
    if (!dealId) {
      clearConversation(telegramId);
      await bot.sendMessage(chatId, 'No deal context found.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const deal = db.findDeal.get(dealId);
    if (!deal) {
      clearConversation(telegramId);
      await bot.sendMessage(chatId, 'Deal not found.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const sellerTelegramId = String(deal.seller_telegram_id || '');
    if (telegramId !== sellerTelegramId) {
      await bot.sendMessage(chatId, 'Not authorized.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const recoveryDetails = text;
    db.updateDeal.run(deal.status, recoveryDetails, dealId);
    const refreshed = db.findDeal.get(dealId);
    clearConversation(telegramId);
    await bot.sendMessage(
      chatId,
      `📨 Recovery details saved.\n\n${renderDealSummary(refreshed)}`,
      {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      }
    );
    await notifyDealParticipants(
      refreshed,
      `Recovery information updated for deal \`${dealId.slice(0, 8)}\`.\n`
    );
    return;
  }
  if (conversation.step === 'actor_status_update') {
    const { dealId, rawStatus, role } = conversation.details || {};
    const deal = db.findDeal.get(dealId);
    if (!deal) {
      clearConversation(telegramId);
      await bot.sendMessage(chatId, 'Deal not found.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    const stage = ensureListingState(deal);
    const requestedRecovery = Boolean(
      deal.recovery_details && deal.recovery_details !== 'null'
    );

    if (rawStatus === 'claim' && role === 'buyer') {
      db.updateDeal.run(null, deal.recovery_details, deal.id);
      const refreshed = db.findDeal.get(deal.id);
      clearConversation(telegramId);
      await bot.sendMessage(
        chatId,
        `🛒 Payment confirmed.\n\n${renderDealSummary(refreshed)}`,
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      await notifyDealParticipants(
        refreshed,
        `Deal \`${dealId.slice(0, 8)}\` payment confirmed.\n`
      );
      return;
    }

    if (rawStatus === 'deliver' && role === 'seller') {
      db.updateDeal.run('completed', deal.recovery_details, deal.id);
      const refreshed = db.findDeal.get(deal.id);
      clearConversation(telegramId);
      await bot.sendMessage(
        chatId,
        `🚚 Account delivered.\n\n${renderDealSummary(refreshed)}`,
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      await notifyDealParticipants(
        refreshed,
        `Deal \`${dealId.slice(0, 8)}\` marked delivered.\n`
      );
      return;
    }

    if (rawStatus === 'request_recovery' && role === 'buyer') {
      db.updateDeal.run(deal.status, null, deal.id);
      const refreshed = db.findDeal.get(deal.id);
      clearConversation(telegramId);
      await bot.sendMessage(
        chatId,
        `🔔 Recovery requested. Share details with the seller.\n\n${renderDealSummary(refreshed)}`,
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      await notifyDealParticipants(
        refreshed,
        `Recovery requested for deal \`${dealId.slice(0, 8)}\`.\n`
      );
      return;
    }

    if (rawStatus === 'dispute') {
      db.updateDeal.run(
        (deal.status || '').toLowerCase() === 'dispute' ? deal.status : 'disputed',
        deal.recovery_details,
        dealId
      );
      const refreshed = db.findDeal.get(dealId);
      clearConversation(telegramId);
      await bot.sendMessage(
        chatId,
        `⚠️ Dispute opened. Use /status \`${dealId.slice(0, 8)}\` to track.\n\n${renderDealSummary(refreshed)}`,
        {
          reply_markup: {
            keyboard: [
              ['📋 List Account', '🛒 Browse Listings'],
              ['📦 My Deals', 'ℹ️ Help'],
            ],
            resize_keyboard: true,
          },
        }
      );
      await notifyAdmins('Deal disputed', {
        deal_id: dealId,
        notes: text || 'None',
      });
      return;
    }

    clearConversation(telegramId);
    await bot.sendMessage(chatId, 'Update not accepted.', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (conversation.step === 'collecting_dispute') {
    const { dealId } = conversation.details || {};
    if (!dealId) {
      clearConversation(telegramId);
      await bot.sendMessage(chatId, 'Lost dispute context.', {
        reply_markup: {
          keyboard: [
            ['📋 List Account', '🛒 Browse Listings'],
            ['📦 My Deals', 'ℹ️ Help'],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }
    db.updateDeal.run(
      'disputed',
      db.findDeal.get(dealId).recovery_details,
      dealId
    );
    clearConversation(telegramId);
    await notifyAdmins('Dispute evidence received', {
      deal_id: dealId,
      evidence: text,
    });
    await bot.sendMessage(chatId, '⚠️ Dispute submitted.', {
      reply_markup: {
        keyboard: [
          ['📋 List Account', '🛒 Browse Listings'],
          ['📦 My Deals', 'ℹ️ Help'],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  await bot.sendMessage(chatId, 'Use a command or button to continue.', {
    reply_markup: {
      keyboard: [
        ['📋 List Account', '🛒 Browse Listings'],
        ['📦 My Deals', 'ℹ️ Help'],
      ],
      resize_keyboard: true,
    },
  });
});

bot.onText(/\/admin/, (msg) => {
  if (!msg.chat || !msg.from) return;
  if (!ADMIN_IDS.has(String(msg.from.id))) return;

  const rows = db.findDeal.all(
    'SELECT d.*, l.price, u1.username AS buyer, u2.username AS seller FROM deals d JOIN listings l ON d.listing_id = l.id JOIN users u1 ON d.buyer_id = u1.id JOIN users u2 ON d.seller_id = u2.id ORDER BY d.id DESC LIMIT 20'
  );
  let text = '🛠 *Admin - Recent Deals*\n\n';
  rows.forEach((d, i) => {
    text += `${i + 1}. \`${String(d.id || '').slice(0, 8)}\` | ${formatCurrency(d.price)} | ${renderStatus(d.status)}\n`;
  });
  bot.sendMessage(msg.chat.id, text, {
    reply_markup: {
      keyboard: [
        ['📋 List Account', '🛒 Browse Listings'],
        ['📦 My Deals', 'ℹ️ Help'],
      ],
      resize_keyboard: true,
    },
  });
});

console.log('FF SafeTrade bot polling...');
