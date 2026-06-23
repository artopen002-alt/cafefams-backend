// ============================================================
// CAFÉ FAMS — Backend Server
// Node 20 | Railway Deploy
// AI: Groq (primary) → OpenRouter (fallback)
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ─── ENV ─────────────────────────────────────────────────────
const GROQ_API_KEY          = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY    = process.env.OPENROUTER_API_KEY;
const TELEGRAM_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID      = process.env.TELEGRAM_CHAT_ID;
const RAZORPAY_KEY_ID       = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET   = process.env.RAZORPAY_KEY_SECRET;
const ADMIN_PASSWORD        = process.env.ADMIN_PASSWORD || '';

// ─── GOOGLE SHEETS ───────────────────────────────────────────
const GOOGLE_SHEET_ID         = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_EMAIL    = process.env.GOOGLE_SERVICE_EMAIL;
const GOOGLE_PRIVATE_KEY_RAW  = process.env.GOOGLE_PRIVATE_KEY || '';
// Railway-তে env var-এ \n literal থাকে, সেটা real newline-এ convert করতে হয়
const GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY_RAW.replace(/\\n/g, '\n');

async function appendToSheet(rowData) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.log('Google Sheets: env vars missing, skipping.');
    return;
  }
  try {
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    console.log('✅ Google Sheets: row appended');
  } catch (e) {
    console.error('Google Sheets error:', e.message);
  }
}

// ─── REORDER FEATURE: READ PAST ORDERS BY PHONE ───────────────
// Column layout written by appendToSheet (0-indexed):
// 0 orderId | 1 time | 2 name | 3 phone | 4 table | 5 guests |
// 6 itemsSummary | 7 subtotal | 8 gst | 9 total | 10 status | 11 itemsJson (নতুন কলাম)
async function getOrdersByPhoneFromSheet(phone) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_EMAIL || !GOOGLE_PRIVATE_KEY) {
    return [];
  }
  try {
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A:L'
    });
    const rows = result.data.values || [];
    const cleanPhone = phone.replace(/\D/g, '').slice(-10); // শেষ ১০ ডিজিট ধরে match (country code থাকলেও কাজ করে)
    if (!cleanPhone) return [];

    const matches = rows.filter(row => {
      const orderId  = row[0] || '';
      const rowPhone = (row[3] || '').replace(/\D/g, '');
      const status   = row[10] || '';
      return orderId.startsWith('CF-') && rowPhone && rowPhone.endsWith(cleanPhone) && status === 'confirmed';
    });

    return matches.reverse(); // sheet-এ chronological order-এ appended হয় — তাই reverse করলে সবচেয়ে recent আগে আসে
  } catch (e) {
    console.error('Google Sheets read error:', e.message);
    return [];
  }
}

// Row থেকে items array বের করে — নতুন rows-এ JSON column থাকবে, পুরনো (এই feature আসার আগের) rows-এর জন্য summary string parse করে fallback করে
function parseItemsFromRow(row) {
  const itemsJsonRaw = row[11];
  if (itemsJsonRaw) {
    try {
      const parsed = JSON.parse(itemsJsonRaw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) { /* fall through to legacy parsing */ }
  }
  const summary = row[6] || '';
  if (!summary) return [];
  return summary.split(',').map(part => {
    const m = part.trim().match(/^(.+?)\s+x(\d+)$/i);
    if (!m) return null;
    const name = m[1].trim();
    const qty  = parseInt(m[2]) || 1;
    const item = ALL_ITEMS.find(i => i.name.toLowerCase() === name.toLowerCase());
    return { name, qty, price: item ? item.price : 0 };
  }).filter(Boolean);
}

// ─── AI PROVIDERS ────────────────────────────────────────────
// Groq — primary (fast, reliable, separate from OpenRouter pool)
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it'
];

// OpenRouter — fallback (only used if Groq fully fails)
const OR_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-2-9b-it:free'
];

// ─── IN-MEMORY ORDER STORE ───────────────────────────────────
const orders = {};
const feedbackList = [];   // customer ratings/reviews
const activityLog  = [];   // live "who asked what" feed for admin
const MAX_ACTIVITY = 200;  // memory cap

// ─── HUMAN ASSIST REQUESTS ────────────────────────────────
// Customer chatbot থেকে "Talk to Human" request এখানে জমা হয়
const assistRequests = [];
const MAX_ASSIST = 100;

// ─── MENU ────────────────────────────────────────────────────
const MENU = {
  coffee_tea: [
    { id:'CT01', name:'Espresso',        price:80,  time:'3 min',  emoji:'☕', ingredients:'Arabica beans, hot water' },
    { id:'CT02', name:'Café Latte',      price:120, time:'5 min',  emoji:'🥛', ingredients:'Espresso, steamed milk, foam' },
    { id:'CT03', name:'Cappuccino',      price:110, time:'5 min',  emoji:'☕', ingredients:'Espresso, steamed milk, dry foam' },
    { id:'CT04', name:'Cold Coffee',     price:130, time:'5 min',  emoji:'🧊', ingredients:'Coffee, milk, ice, sugar' },
    { id:'CT05', name:'Masala Chai',     price:40,  time:'4 min',  emoji:'🍵', ingredients:'Tea, milk, ginger, cardamom, spices' },
    { id:'CT06', name:'Green Tea',       price:60,  time:'3 min',  emoji:'🍵', ingredients:'Green tea leaves, hot water, lemon' },
    { id:'CT07', name:'Mango Smoothie',  price:150, time:'5 min',  emoji:'🥭', ingredients:'Fresh mango, milk, ice, sugar' },
    { id:'CT08', name:'Strawberry Shake',price:160, time:'5 min',  emoji:'🍓', ingredients:'Strawberry, milk, ice cream, sugar' },
  ],
  indian: [
    { id:'IN01', name:'Paneer Butter Masala', price:220, time:'15 min', emoji:'🧆', ingredients:'Paneer, tomato, butter, cream, spices' },
    { id:'IN02', name:'Dal Tadka',            price:130, time:'12 min', emoji:'🍲', ingredients:'Yellow dal, ghee, cumin, garlic, spices' },
    { id:'IN03', name:'Chicken Curry',        price:260, time:'20 min', emoji:'🍛', ingredients:'Chicken, onion, tomato, garam masala' },
    { id:'IN04', name:'Veg Biryani',          price:200, time:'20 min', emoji:'🍚', ingredients:'Basmati rice, vegetables, saffron, spices' },
    { id:'IN05', name:'Chicken Biryani',      price:280, time:'25 min', emoji:'🍗', ingredients:'Basmati rice, chicken, dum spices' },
    { id:'IN06', name:'Aloo Paratha',         price:100, time:'10 min', emoji:'🫓', ingredients:'Wheat flour, potato, spices, butter' },
    { id:'IN07', name:'Samosa (2 pcs)',       price:50,  time:'5 min',  emoji:'🥟', ingredients:'Maida, potato, peas, spices' },
    { id:'IN08', name:'Pav Bhaji',            price:140, time:'12 min', emoji:'🍞', ingredients:'Mixed veg, butter, pav bread, spices' },
  ],
  italian: [
    { id:'IT01', name:'Margherita Pizza',  price:280, time:'20 min', emoji:'🍕', ingredients:'Pizza dough, tomato sauce, mozzarella, basil' },
    { id:'IT02', name:'Chicken Pizza',    price:340, time:'20 min', emoji:'🍕', ingredients:'Pizza dough, chicken, mozzarella, sauce, bell peppers' },
    { id:'IT03', name:'Pasta Arrabbiata', price:220, time:'15 min', emoji:'🍝', ingredients:'Penne, tomato, garlic, chili, parsley' },
    { id:'IT04', name:'Pasta Alfredo',    price:240, time:'15 min', emoji:'🍝', ingredients:'Fettuccine, cream, parmesan, butter' },
    { id:'IT05', name:'Chicken Lasagna',  price:320, time:'25 min', emoji:'🥘', ingredients:'Lasagna sheets, chicken, béchamel, cheese' },
    { id:'IT06', name:'Bruschetta',       price:150, time:'8 min',  emoji:'🍞', ingredients:'Ciabatta, tomato, garlic, olive oil, basil' },
    { id:'IT07', name:'Tiramisu',         price:180, time:'5 min',  emoji:'🍰', ingredients:'Mascarpone, coffee, ladyfingers, cocoa' },
  ],
  arabian: [
    { id:'AR01', name:'Chicken Shawarma', price:180, time:'10 min', emoji:'🌯', ingredients:'Chicken, pita, garlic sauce, vegetables' },
    { id:'AR02', name:'Veg Shawarma',     price:150, time:'10 min', emoji:'🌯', ingredients:'Mixed veg, pita, tahini, pickles, onion' },
    { id:'AR03', name:'Falafel Wrap',     price:150, time:'10 min', emoji:'🧆', ingredients:'Falafel, hummus, pita, tomato, cucumber' },
    { id:'AR04', name:'Hummus Platter',   price:140, time:'5 min',  emoji:'🫙', ingredients:'Chickpeas, tahini, lemon, olive oil, pita' },
    { id:'AR05', name:'Chicken Kebab',    price:280, time:'20 min', emoji:'🍢', ingredients:'Minced chicken, spices, onion, herbs' },
    { id:'AR06', name:'Arabic Coffee',    price:90,  time:'5 min',  emoji:'☕', ingredients:'Arabic coffee, cardamom, saffron' },
  ],
  european: [
    { id:'EU01', name:'Club Sandwich',    price:200, time:'10 min', emoji:'🥪', ingredients:'Bread, chicken, egg, lettuce, mayo, tomato' },
    { id:'EU02', name:'Grilled Chicken',  price:300, time:'20 min', emoji:'🍗', ingredients:'Chicken breast, herbs, lemon, garlic butter' },
    { id:'EU03', name:'Fish & Chips',     price:280, time:'18 min', emoji:'🐟', ingredients:'Battered fish, potato fries, tartar sauce' },
    { id:'EU04', name:'Mushroom Soup',    price:130, time:'10 min', emoji:'🍲', ingredients:'Mushroom, cream, garlic, thyme, bread' },
    { id:'EU05', name:'Caesar Salad',     price:160, time:'8 min',  emoji:'🥗', ingredients:'Romaine, croutons, parmesan, caesar dressing' },
    { id:'EU06', name:'Chicken Burger',   price:250, time:'15 min', emoji:'🍔', ingredients:'Chicken patty, brioche bun, cheese, lettuce, sauce' },
    { id:'EU07', name:'Chocolate Brownie',price:120, time:'5 min',  emoji:'🍫', ingredients:'Dark chocolate, butter, flour, eggs, vanilla' },
    { id:'EU08', name:'Cheesecake',       price:160, time:'5 min',  emoji:'🍰', ingredients:'Cream cheese, graham cracker, sugar, vanilla' },
  ]
};

const ALL_ITEMS = Object.values(MENU).flat();
const MENU_TEXT = ALL_ITEMS.map(i =>
  `[${i.id}] ${i.emoji} ${i.name} — ₹${i.price} (${i.time})`
).join('\n');

// ─── SOLD OUT TRACKING (Admin Dashboard) ──────────────────────
// Railway restart হলে reset হয় — owner সকালে আবার set করে নেবে
const soldOutItems = new Set();

function getUnavailableNote() {
  if (soldOutItems.size === 0) return '';
  const names = ALL_ITEMS.filter(i => soldOutItems.has(i.id)).map(i => i.name);
  if (names.length === 0) return '';
  return `\n\nCURRENTLY SOLD OUT TODAY (do NOT offer or accept orders for these — say it's sold out and suggest a similar alternative from the menu): ${names.join(', ')}`;
}

// ─── ADMIN AUTH MIDDLEWARE ────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not set in Railway variables' });
  }
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are "Fams", the AI assistant for Café Fams restaurant in Dhupguri, West Bengal.

LANGUAGE RULE — HIGHEST PRIORITY, NEVER BREAK THIS:
- The customer's selected language will be sent as [LANG:en] or [LANG:bn] at the start of each message.
- If [LANG:en] → reply ONLY in English. Zero Bengali words allowed.
- If [LANG:bn] → reply ONLY in Bengali. Zero English words allowed.
- NEVER use "আসসালামু আলাইকুম" or any religious greeting. EVER.
- Cool, friendly greetings only: "Hey!", "Hi!", "Great choice!", "Sure thing!" etc.

GREETING RULE:
- You already know the customer's name from the system. Use it naturally.
- Never ask for name/phone/guests — that info is already provided.

Your job:
1. Help customers browse the menu and place orders
2. Walk through order confirmation properly (see ORDER FLOW below)
3. Help cancel orders (only within 5 minutes)
4. Show bill with 5% GST when asked
5. Be cool, friendly and professional

NO BEEF RULE:
This restaurant does NOT serve beef or beef products. If asked, say it's not available and suggest chicken as an alternative.

FULL MENU:
${MENU_TEXT}

ORDER FLOW — FOLLOW THIS EXACTLY:
Step 1: Customer asks for an item → ask how many plates/cups
Step 2: Customer gives quantity → show a confirmation summary like:
  "Got it! Just to confirm your order:
  • [Item Name] x[qty] — ₹[price each] × [qty] = ₹[total]
  Ready to place this order? Reply Yes to confirm."
Step 3: Customer says Yes/Confirm/হ্যাঁ → THEN place the order with the full format below.

ORDER RULES:
- NEVER place order without customer confirmation
- Always show item name + quantity + per-item price + line total in confirmation summary
- Add 5% GST on subtotal when showing bill
- Never make up dishes not listed in the menu

FORMATTING RULE — ALWAYS FOLLOW WHEN LISTING 2+ MENU ITEMS:
NEVER write item names in a flowing sentence or comma-separated. Always use ONE item per line with bold name, price, and prep time, like this:

• **Café Latte** — ₹120 ⏱ 5 min
• **Cappuccino** — ₹110 ⏱ 5 min
• **Cold Coffee** — ₹130 ⏱ 5 min
• **Masala Chai** — ₹40 ⏱ 4 min

Keep any sold-out notices on a separate line AFTER the list, never mixed in. Never list more items than the user asked for in a single paragraph.

MENU CATEGORY IMAGES are available in the Menu tab — always remind customers to check the 🍽️ Menu tab to see photos of each dish.

ORDER CONFIRMATION FORMAT (use ONLY after customer confirms):
✅ Order Confirmed!
Table: [table number]
Items:
• [Item Name] × [qty] — ₹[line total]
Subtotal: ₹[sum]
GST (5%): ₹[gst]
Total: ₹[grand total]
Cooking Time: [estimated time]
Order ID: CF-XXXX

CRITICAL — ORDER DATA TAG:
After EVERY confirmed order, add this at the very end on a new line.
Replace SUBTOTAL with actual number, and replace ITEMS_JSON with a JSON array of ordered items:
[ORDER_DATA]{"confirmed":true,"subtotal":SUBTOTAL,"items":[{"name":"Item Name","qty":1,"price":280}]}[/ORDER_DATA]

Example:
[ORDER_DATA]{"confirmed":true,"subtotal":560,"items":[{"name":"Chicken Biryani","qty":2,"price":280}]}[/ORDER_DATA]

Add this tag ONLY when placing a confirmed order. Never for any other message. Never show or explain this tag to the customer.`;

// ─── TELEGRAM ────────────────────────────────────────────────
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// ─── ACTIVITY LOG (Admin "who asked what" live feed) ──────────
function logActivity(tableNumber, guestName, message, reply, isOrder, guestPhone, guestCount) {
  activityLog.unshift({
    tableNumber, guestName: guestName || 'Guest',
    guestPhone: guestPhone || '',
    guestCount: guestCount || 1,
    message: (message || '').slice(0, 200),
    reply: (reply || '').slice(0, 200),
    isOrder: !!isOrder,
    isWaiter: false,
    time: new Date().toISOString()
  });
  if (activityLog.length > MAX_ACTIVITY) activityLog.length = MAX_ACTIVITY;
}

// ─── GROQ CALL ───────────────────────────────────────────────
async function callGroq(messages) {
  if (!GROQ_API_KEY) return null;

  for (const model of GROQ_MODELS) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: 1024
        })
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`Groq model ${model} failed:`, err);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        console.log(`✅ Groq model used: ${model}`);
        return content;
      }
    } catch (e) {
      console.error(`Groq ${model} exception:`, e.message);
      continue;
    }
  }
  return null;
}

// ─── OPENROUTER CALL (FALLBACK) ──────────────────────────────
async function callOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) return null;

  for (const model of OR_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://cafefams.netlify.app',
          'X-Title': 'Cafe Fams'
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: 1024
        })
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`OpenRouter model ${model} failed:`, err);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        console.log(`✅ OpenRouter fallback used: ${model}`);
        return content;
      }
    } catch (e) {
      console.error(`OpenRouter ${model} exception:`, e.message);
      continue;
    }
  }
  return null;
}

// NOTE: order-data extraction from the AI's [ORDER_DATA] tag happens inline
// in the /api/chat handler below (it needs the full parsed object, including
// items[], not just subtotal).

// ─── ROUTES ──────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Café Fams Backend Running ☕',
    node: process.version,
    groq: GROQ_API_KEY ? 'configured' : 'missing',
    openrouter: OPENROUTER_API_KEY ? 'configured' : 'missing',
    telegram: TELEGRAM_BOT_TOKEN ? 'configured' : 'missing',
    admin: ADMIN_PASSWORD ? 'configured' : 'missing',
    timestamp: new Date().toISOString()
  });
});

// Menu (public — now includes availability flag for sold-out items)
app.get('/api/menu', (req, res) => {
  const menuWithAvailability = {};
  Object.entries(MENU).forEach(([cat, items]) => {
    menuWithAvailability[cat] = items.map(i => ({ ...i, available: !soldOutItems.has(i.id) }));
  });
  res.json({ success: true, menu: menuWithAvailability, total: ALL_ITEMS.length });
});

// Reorder — find this phone's most recent confirmed order (current server uptime only)
app.get('/api/orders/by-phone/:phone', (req, res) => {
  const phone = (req.params.phone || '').trim();
  if (!phone) return res.json({ success: true, found: false });

  const matches = Object.entries(orders)
    .filter(([, o]) => o.guestPhone === phone && o.status === 'confirmed')
    .sort((a, b) => new Date(b[1].time) - new Date(a[1].time));

  if (!matches.length) return res.json({ success: true, found: false });

  const [orderId, last] = matches[0];
  res.json({
    success: true, found: true, orderId,
    items: last.items || [], total: last.total, time: last.time
  });
});

// NOTE: /api/feedback POST and /api/public/ratings GET are defined below (near admin routes)

// ─── MAIN CHAT ───────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const {
    message, history = [], tableNumber = 1, sessionId,
    lang = 'en', guestName = 'Guest', guestCount = 1, guestPhone = ''
  } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  if (!GROQ_API_KEY && !OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'No AI API key configured in Railway variables' });
  }

  try {
    // Prepend lang tag so AI knows which language to use — this is the key fix
    const taggedMessage = `[LANG:${lang}] ${message}`;

    const messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT + getUnavailableNote() +
          `\n\nCUSTOMER INFO (already collected, do not ask again):\n` +
          `Name: ${guestName}\nGuests: ${guestCount}\nPhone: ${guestPhone || 'not provided'}\nTable: ${tableNumber}`
      },
      ...history.map(h => ({
        role: h.role === 'model' ? 'assistant' : 'user',
        content: h.content
      })),
      { role: 'user', content: taggedMessage }
    ];

    let rawReply = await callGroq(messages);
    if (!rawReply) {
      console.log('Groq failed — trying OpenRouter fallback...');
      rawReply = await callOpenRouter(messages);
    }

    if (!rawReply) {
      return res.status(503).json({
        error: 'All AI models are temporarily busy. Please try again in a moment.',
      });
    }

    // Extract ORDER_DATA tag
    const tagMatch = rawReply.match(/\[ORDER_DATA\]\s*(\{.*?\})\s*\[\/ORDER_DATA\]/s);
    let orderData = null;
    if (tagMatch) {
      try {
        const parsed = JSON.parse(tagMatch[1]);
        if (parsed && parsed.confirmed && typeof parsed.subtotal === 'number' && parsed.subtotal > 0) {
          orderData = parsed;
        }
      } catch (e) {
        console.error('ORDER_DATA parse error:', e.message);
      }
    }

    // Remove tag from customer-facing reply
    let reply = rawReply.replace(/\[ORDER_DATA\].*?\[\/ORDER_DATA\]/s, '').trim();

    if (orderData) {
      const subtotal = Math.round(orderData.subtotal);
      const gst      = Math.round(subtotal * 0.05);
      const total    = subtotal + gst;
      const orderId  = 'CF-' + Math.floor(1000 + Math.random() * 9000);

      // Build items summary for Telegram
      const items = Array.isArray(orderData.items) ? orderData.items : [];
      const itemsText = items.length > 0
        ? items.map(i => `  • ${i.name} × ${i.qty} — ₹${i.price * i.qty}`).join('\n')
        : `  • ${message}`;

      // IST timestamp
      const istTime = new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: true,
        day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      orders[orderId] = {
        sessionId, tableNumber, message,
        subtotal, gst, total, items,
        guestName, guestCount, guestPhone,
        time: new Date().toISOString(),
        status: 'confirmed',
        kitchenStatus: 'pending' // pending → preparing → ready → served
      };

      // ── Google Sheets log ──
      const itemsSummary = items.length > 0
        ? items.map(i => `${i.name} x${i.qty}`).join(', ')
        : message;
      await appendToSheet([
        orderId,
        new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        guestName,
        guestPhone || '',
        String(tableNumber),
        String(guestCount),
        itemsSummary,
        subtotal,
        gst,
        total,
        'confirmed',
        JSON.stringify(items) // 12th col — Reorder feature: exact items+qty+price for accurate re-suggestion
      ]);

      reply = reply.replace(/CF-[A-Za-z0-9]{4,6}/g, orderId);
      if (!reply.includes(orderId)) reply += `\n\nOrder ID: ${orderId}`;

      // Full Telegram notification with all details
      await sendTelegram(
        `🆕 <b>New Order!</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📋 Order ID: <b>${orderId}</b>\n` +
        `🪑 Table: <b>${tableNumber}</b>\n` +
        `👤 Name: <b>${guestName}</b>\n` +
        `👥 Guests: ${guestCount}\n` +
        `📱 Phone: ${guestPhone || 'not provided'}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🍽️ <b>Items:</b>\n${itemsText}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💵 Subtotal: ₹${subtotal}\n` +
        `🧾 GST (5%): ₹${gst}\n` +
        `💰 <b>Total: ₹${total}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⏰ ${istTime} IST`
      );

      logActivity(tableNumber, guestName, message, reply, true, guestPhone, guestCount);

      return res.json({
        success: true, reply, orderId,
        orderSubtotal: subtotal, orderGst: gst, orderTotal: total, orderItems: items
      });
    }

    logActivity(tableNumber, guestName, message, reply, false, guestPhone, guestCount);
    res.json({ success: true, reply });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// ─── CANCEL ORDER ────────────────────────────────────────────
app.post('/api/cancel', async (req, res) => {
  const { orderId, tableNumber } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = orders[orderId];
  if (!order) {
    return res.json({ success: false, message: `Order ${orderId} not found.` });
  }

  const diffMinutes = (Date.now() - new Date(order.time)) / 60000;
  if (diffMinutes > 5) {
    return res.json({
      success: false,
      message: 'More than 5 minutes have passed. Cannot cancel. Please ask staff for help.'
    });
  }

  orders[orderId].status = 'cancelled';
  await sendTelegram(
    `❌ <b>Order Cancelled</b>\n📋 Order ID: <b>${orderId}</b>\n🪑 Table: ${tableNumber}\n` +
    `⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour:'2-digit', minute:'2-digit', second:'2-digit' })} IST`
  );
  res.json({ success: true, message: `Order ${orderId} has been cancelled.` });
});

// ─── ORDER NOTE ──────────────────────────────────────────────
app.post('/api/note', async (req, res) => {
  const { orderId, tableNumber, guestName, note } = req.body;
  if (!orderId || !note) return res.status(400).json({ error: 'orderId and note required' });

  // Save note to order if it exists
  if (orders[orderId]) {
    orders[orderId].note = note;
  }

  const istTime = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: true,
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });

  await sendTelegram(
    `📝 <b>Special Note Added</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📋 Order ID: <b>${orderId}</b>\n` +
    `🪑 Table: <b>${tableNumber}</b>\n` +
    `👤 Name: <b>${guestName}</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `💬 Note: <b>${note}</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `⏰ ${istTime} IST`
  );

  res.json({ success: true, message: 'Note sent!' });
});

// ─── CALL WAITER ─────────────────────────────────────────────
// অর্ডার ছাড়াই customer staff কে call করতে পারবে (পানি, bill, সাহায্য ইত্যাদি)
app.post('/api/call-waiter', async (req, res) => {
  const { tableNumber, guestName, reason, sessionId } = req.body;
  if (!tableNumber) return res.status(400).json({ error: 'tableNumber required' });

  const istTime = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: true,
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  await sendTelegram(
    `🛎️ <b>Waiter Called!</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🪑 Table: <b>${tableNumber}</b>\n` +
    `👤 Name: <b>${guestName || 'Guest'}</b>\n` +
    `📋 Need: <b>${reason || 'Assistance needed'}</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `⏰ ${istTime} IST`
  );

  // Log to activity feed so admin can see it in Live Feed tab
  activityLog.unshift({
    tableNumber, guestName: guestName || 'Guest',
    guestPhone: '', guestCount: 1,
    message: reason || 'Assistance needed',
    reply: '',
    isOrder: false,
    isWaiter: true,
    time: new Date().toISOString()
  });
  if (activityLog.length > MAX_ACTIVITY) activityLog.length = MAX_ACTIVITY;

  res.json({ success: true, message: 'Waiter has been notified!' });
});

// ─── BILL ────────────────────────────────────────────────────
app.post('/api/bill', async (req, res) => {
  const { items = [], tableNumber } = req.body;
  const subtotal = items.reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);
  const gst   = Math.round(subtotal * 0.05);
  const total = subtotal + gst;
  res.json({
    success: true,
    bill: { tableNumber, items, subtotal, gst, gstPercent: 5, total, billId: 'BILL-' + Date.now() }
  });
});

// ─── PAYMENT CREATE ──────────────────────────────────────────
app.post('/api/payment/create', async (req, res) => {
  const { amount, tableNumber, orderId } = req.body;

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Razorpay keys missing in Railway variables' });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    });
    const order = await razorpay.orders.create({
      amount: Math.round(amount) * 100, // paise
      currency: 'INR',
      receipt: `cafefam_t${tableNumber}_${Date.now()}`,
      notes: { tableNumber, orderId }
    });
    res.json({ success: true, order, key: RAZORPAY_KEY_ID });
  } catch (e) {
    console.error('Razorpay error:', e);
    res.status(500).json({ error: 'Payment creation failed', detail: e.message });
  }
});

// ─── PAYMENT VERIFY ──────────────────────────────────────────
app.post('/api/payment/verify', async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, tableNumber } = req.body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: 'Missing payment verification fields' });
  }
  if (!RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ success: false, error: 'Razorpay not configured' });
  }

  // BUG FIX: previously this endpoint trusted whatever IDs the client sent and
  // always replied success — anyone could POST fake IDs and get a "payment verified"
  // response (and a false "Payment Received!" alert to staff). We must recompute the
  // HMAC signature ourselves and compare it to the one Razorpay sent the client.
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const isValid = expectedSignature === razorpay_signature;
  if (!isValid) {
    console.error('Razorpay signature mismatch — possible spoofed payment attempt', { razorpay_order_id, razorpay_payment_id });
    return res.status(400).json({ success: false, error: 'Invalid payment signature' });
  }

  await sendTelegram(
    `💰 <b>Payment Received!</b>\n` +
    `🪑 Table: ${tableNumber}\n` +
    `💳 Payment ID: ${razorpay_payment_id}\n` +
    `📋 Order ID: ${razorpay_order_id}`
  );
  res.json({ success: true, message: 'Payment verified!' });
});

// ─── REORDER LOOKUP ──────────────────────────────────────────
// Phone number দিয়ে Google Sheets-এ customer-এর সবচেয়ে recent confirmed order খুঁজে বের করে
app.get('/api/reorder-lookup', async (req, res) => {
  const phone = (req.query.phone || '').toString().trim();
  if (!phone || phone.replace(/\D/g, '').length < 6) {
    return res.json({ success: true, found: false });
  }

  try {
    const matches = await getOrdersByPhoneFromSheet(phone);
    if (matches.length === 0) {
      return res.json({ success: true, found: false });
    }
    const latest = matches[0];
    const items = parseItemsFromRow(latest);
    if (items.length === 0) {
      return res.json({ success: true, found: false });
    }
    res.json({
      success: true,
      found: true,
      order: {
        orderId: latest[0],
        time: latest[1],
        items,
        subtotal: Number(latest[7]) || 0,
        total: Number(latest[9]) || 0
      },
      previousOrderCount: matches.length
    });
  } catch (e) {
    console.error('Reorder lookup error:', e.message);
    res.json({ success: true, found: false }); // soft-fail — এটা একটা nice-to-have feature, error দেখিয়ে customer experience নষ্ট করার দরকার নেই
  }
});

// ─── FEEDBACK / RATING ───────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { orderId, tableNumber, guestName, rating, comment } = req.body;
  const ratingNum = parseInt(rating);
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'rating must be between 1 and 5' });
  }

  const entry = {
    orderId: orderId || null,
    tableNumber: tableNumber || null,
    guestName: guestName || 'Guest',
    rating: ratingNum,
    comment: comment || '',
    time: new Date().toISOString()
  };
  feedbackList.unshift(entry);
  if (feedbackList.length > 200) feedbackList.length = 200;

  const stars = '⭐'.repeat(ratingNum) + '☆'.repeat(5 - ratingNum);
  const istTime = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: true,
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });

  await sendTelegram(
    `⭐ <b>New Feedback!</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📋 Order ID: <b>${orderId || 'N/A'}</b>\n` +
    `🪑 Table: <b>${tableNumber || '—'}</b>\n` +
    `👤 Name: <b>${guestName || 'Guest'}</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `${stars} (${ratingNum}/5)\n` +
    `💬 Comment: ${comment ? comment : '—'}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `⏰ ${istTime} IST`
  );

  res.json({ success: true, message: 'Feedback received, thank you!' });
});

// Public ratings — About page-এ দেখানোর জন্য (no auth needed)
app.get('/api/public/ratings', (req, res) => {
  const avg = feedbackList.length
    ? Math.round((feedbackList.reduce((s, f) => s + f.rating, 0) / feedbackList.length) * 10) / 10
    : 0;
  const recent = feedbackList
    .filter(f => f.comment || f.rating >= 4) // শুধু comment আছে বা ৪+ star গুলো দেখাও
    .slice(0, 5);
  res.json({ success: true, avgRating: avg, totalReviews: feedbackList.length, recent });
});

// ════════════════════════════════════════════════════════════
// ADMIN DASHBOARD API — সব route x-admin-key header দিয়ে protected
// ════════════════════════════════════════════════════════════

// Login check (frontend দিয়ে password verify করতে ব্যবহার হয়)
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ success: false, error: 'ADMIN_PASSWORD not set in Railway variables' });
  }
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, error: 'Wrong password' });
});

// সব order দেখাও (newest first)
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const list = Object.entries(orders)
    .map(([orderId, o]) => ({ orderId, ...o }))
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json({ success: true, orders: list });
});

// Kitchen status update (pending → preparing → ready → served)
app.post('/api/admin/order-status', requireAdmin, async (req, res) => {
  const { orderId, kitchenStatus } = req.body;
  const valid = ['pending', 'preparing', 'ready', 'served'];
  if (!orderId || !valid.includes(kitchenStatus)) {
    return res.status(400).json({ error: 'orderId and valid kitchenStatus required' });
  }
  if (!orders[orderId]) {
    return res.status(404).json({ error: 'Order not found' });
  }
  orders[orderId].kitchenStatus = kitchenStatus;

  if (kitchenStatus === 'ready') {
    const istTime = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', hour12: true,
      hour: '2-digit', minute: '2-digit'
    });
    await sendTelegram(
      `🍽️ <b>Order Ready!</b>\n📋 ${orderId} — Table ${orders[orderId].tableNumber}\n⏰ ${istTime} IST`
    );
  }

  res.json({ success: true, message: `Order ${orderId} marked as ${kitchenStatus}` });
});

// Menu with sold-out state (for admin management screen)
app.get('/api/admin/menu', requireAdmin, (req, res) => {
  const menuWithState = {};
  Object.entries(MENU).forEach(([cat, items]) => {
    menuWithState[cat] = items.map(i => ({ ...i, soldOut: soldOutItems.has(i.id) }));
  });
  res.json({ success: true, menu: menuWithState });
});

// Sold-out toggle
app.post('/api/admin/sold-out', requireAdmin, (req, res) => {
  const { itemId, soldOut } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });

  const item = ALL_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (soldOut) soldOutItems.add(itemId);
  else soldOutItems.delete(itemId);

  res.json({ success: true, itemId, soldOut: !!soldOut, name: item.name });
});

// Apply discount to an order
app.post('/api/admin/discount', requireAdmin, async (req, res) => {
  const { orderId, type, value } = req.body; // type: 'percent' | 'flat'
  if (!orderId || !orders[orderId]) return res.status(404).json({ error: 'Order not found' });
  if (!['percent', 'flat'].includes(type) || typeof value !== 'number' || value <= 0) {
    return res.status(400).json({ error: 'Invalid discount type/value' });
  }

  const order = orders[orderId];
  const baseTotal = order.subtotal + order.gst;
  const discountAmount = type === 'percent'
    ? Math.round(baseTotal * (value / 100))
    : Math.round(value);

  const newTotal = Math.max(0, baseTotal - discountAmount);
  order.discount = { type, value, amount: discountAmount };
  order.total = newTotal;

  await sendTelegram(
    `🏷️ <b>Discount Applied</b>\n📋 ${orderId}\n💸 ${type === 'percent' ? value + '%' : '₹' + value} off (₹${discountAmount})\n💰 New Total: ₹${newTotal}`
  );

  res.json({ success: true, orderId, newTotal, discountAmount });
});

// Today's sales stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

  const todaysOrders = Object.values(orders).filter(o => {
    const orderDateStr = new Date(o.time).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    return orderDateStr === todayStr && o.status === 'confirmed';
  });

  const totalRevenue = todaysOrders.reduce((s, o) => s + (o.total || 0), 0);
  const totalOrders  = todaysOrders.length;

  // Top items today
  const itemCounts = {};
  todaysOrders.forEach(o => {
    (o.items || []).forEach(i => {
      itemCounts[i.name] = (itemCounts[i.name] || 0) + (i.qty || 1);
    });
  });
  const topItems = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  res.json({
    success: true,
    date: todayStr,
    totalOrders,
    totalRevenue,
    avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
    topItems
  });
});

// Full feedback list (admin)
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const avg = feedbackList.length
    ? Math.round((feedbackList.reduce((s, f) => s + f.rating, 0) / feedbackList.length) * 10) / 10
    : 0;
  res.json({ success: true, avgRating: avg, totalReviews: feedbackList.length, feedback: feedbackList });
});

// Live "who asked what" activity feed (admin)
app.get('/api/admin/activity', requireAdmin, (req, res) => {
  res.json({ success: true, activity: activityLog.slice(0, 60) });
});

// ─── CUSTOMER: Request human assistant ───────────────────
// index.html chatbot থেকে call হয় — no auth needed
app.post('/api/assist-request', (req, res) => {
  const { tableNumber, guestName, guestPhone, guestCount, message, sessionId } = req.body;
  if (!tableNumber) return res.status(400).json({ error: 'tableNumber required' });

  const entry = {
    id: 'AR-' + Date.now(),
    time: new Date().toISOString(),
    tableNumber,
    guestName: guestName || 'Guest',
    guestPhone: guestPhone || '',
    guestCount: guestCount || 1,
    message: message || 'Needs assistance',
    sessionId: sessionId || '',
    resolved: false
  };

  assistRequests.unshift(entry);
  if (assistRequests.length > MAX_ASSIST) assistRequests.length = MAX_ASSIST;

  // Telegram notification
  const istTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: '2-digit', minute: '2-digit' });
  sendTelegram(
    `🙋 <b>Customer Needs Help!</b>\n` +
    `🪑 Table ${tableNumber} — ${entry.guestName}${entry.guestPhone ? ` (${entry.guestPhone})` : ''}\n` +
    `💬 "${entry.message}"\n` +
    `⏰ ${istTime} IST`
  );

  res.json({ success: true, message: 'Your request has been sent. A staff member will assist you shortly!' });
});

// ADMIN: Get assist requests
app.get('/api/admin/assist-requests', requireAdmin, (req, res) => {
  res.json({ success: true, requests: assistRequests });
});

// ADMIN: Mark request resolved
app.post('/api/admin/assist-resolve', requireAdmin, (req, res) => {
  const { id } = req.body;
  const req_ = assistRequests.find(r => r.id === id);
  if (!req_) return res.status(404).json({ error: 'Request not found' });
  req_.resolved = true;
  res.json({ success: true });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── GLOBAL ERROR ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`☕ Café Fams Backend running on port ${PORT}`);
  console.log(`🤖 Groq:        ${GROQ_API_KEY       ? '✅ configured' : '❌ MISSING'}`);
  console.log(`🔁 OpenRouter:  ${OPENROUTER_API_KEY  ? '✅ configured' : '⚠️  missing (fallback only)'}`);
  console.log(`📱 Telegram:    ${TELEGRAM_BOT_TOKEN  ? '✅ configured' : '❌ MISSING'}`);
  console.log(`💳 Razorpay:    ${RAZORPAY_KEY_ID     ? '✅ configured' : '⚠️  missing (payment disabled)'}`);
  console.log(`🔐 Admin Panel: ${ADMIN_PASSWORD      ? '✅ configured' : '⚠️  missing (dashboard disabled)'}`);
});
