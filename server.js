// ============================================================
// CAFÉ FAMS — Backend Server
// Node 20 | Railway Deploy
// AI: Groq (primary) → OpenRouter (fallback)
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
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
const GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY_RAW.replace(/\\n/g, '\n');

async function appendToSheet(rowData) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.log('Google Sheets: env vars missing, skipping.');
    return;
  }
  try {
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_EMAIL, null, GOOGLE_PRIVATE_KEY,
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
async function getOrdersByPhoneFromSheet(phone) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_EMAIL || !GOOGLE_PRIVATE_KEY) return [];
  try {
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_EMAIL, null, GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A:L'
    });
    const rows = result.data.values || [];
    const cleanPhone = phone.replace(/\D/g, '').slice(-10);
    if (!cleanPhone) return [];
    const matches = rows.filter(row => {
      const orderId  = row[0] || '';
      const rowPhone = (row[3] || '').replace(/\D/g, '');
      const status   = row[10] || '';
      return orderId.startsWith('CF-') && rowPhone && rowPhone.endsWith(cleanPhone) && status === 'confirmed';
    });
    return matches.reverse();
  } catch (e) {
    console.error('Google Sheets read error:', e.message);
    return [];
  }
}

function parseItemsFromRow(row) {
  const itemsJsonRaw = row[11];
  if (itemsJsonRaw) {
    try {
      const parsed = JSON.parse(itemsJsonRaw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {}
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
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it'
];

const OR_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-2-9b-it:free'
];

// ─── IN-MEMORY STORE ─────────────────────────────────────────
const orders = {};
const feedbackList = [];
const activityLog  = [];
const MAX_ACTIVITY = 200;
const MAX_FEEDBACK = 200;

// ─── MENU ────────────────────────────────────────────────────
const MENU = {
  coffee_tea: [
    { id:'CT01', name:'Espresso',        price:80,  time:'3 min',  emoji:'☕', img:'https://images.unsplash.com/photo-1510707577719-ae7c14805e3a?w=200&q=70', ingredients:'Arabica beans, hot water' },
    { id:'CT02', name:'Café Latte',      price:120, time:'5 min',  emoji:'🥛', img:'https://images.unsplash.com/photo-1561882468-9110e03e0f78?w=200&q=70', ingredients:'Espresso, steamed milk, foam' },
    { id:'CT03', name:'Cappuccino',      price:110, time:'5 min',  emoji:'☕', img:'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=200&q=70', ingredients:'Espresso, steamed milk, dry foam' },
    { id:'CT04', name:'Cold Coffee',     price:130, time:'5 min',  emoji:'🧊', img:'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=200&q=70', ingredients:'Coffee, milk, ice, sugar' },
    { id:'CT05', name:'Masala Chai',     price:40,  time:'4 min',  emoji:'🍵', img:'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=200&q=70', ingredients:'Tea, milk, ginger, cardamom, spices' },
    { id:'CT06', name:'Green Tea',       price:60,  time:'3 min',  emoji:'🍵', img:'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=200&q=70', ingredients:'Green tea leaves, hot water, lemon' },
    { id:'CT07', name:'Mango Smoothie',  price:150, time:'5 min',  emoji:'🥭', img:'https://images.unsplash.com/photo-1542444459-b6f7c2b37c5e?w=200&q=70', ingredients:'Fresh mango, milk, ice, sugar' },
    { id:'CT08', name:'Strawberry Shake',price:160, time:'5 min',  emoji:'🍓', img:'https://images.unsplash.com/photo-1553530666-ba11a90a3db5?w=200&q=70', ingredients:'Strawberry, milk, ice cream, sugar' },
  ],
  indian: [
    { id:'IN01', name:'Paneer Butter Masala', price:220, time:'15 min', emoji:'🧆', img:'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=200&q=70', ingredients:'Paneer, tomato, butter, cream, spices' },
    { id:'IN02', name:'Dal Tadka',            price:130, time:'12 min', emoji:'🍲', img:'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=200&q=70', ingredients:'Yellow dal, ghee, cumin, garlic, spices' },
    { id:'IN03', name:'Chicken Curry',        price:260, time:'20 min', emoji:'🍛', img:'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=200&q=70', ingredients:'Chicken, onion, tomato, garam masala' },
    { id:'IN04', name:'Veg Biryani',          price:200, time:'20 min', emoji:'🍚', img:'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=200&q=70', ingredients:'Basmati rice, vegetables, saffron, spices' },
    { id:'IN05', name:'Chicken Biryani',      price:280, time:'25 min', emoji:'🍗', img:'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=200&q=70', ingredients:'Basmati rice, chicken, dum spices' },
    { id:'IN06', name:'Aloo Paratha',         price:100, time:'10 min', emoji:'🫓', img:'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=200&q=70', ingredients:'Wheat flour, potato, spices, butter' },
    { id:'IN07', name:'Samosa (2 pcs)',       price:50,  time:'5 min',  emoji:'🥟', img:'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=200&q=70', ingredients:'Maida, potato, peas, spices' },
    { id:'IN08', name:'Pav Bhaji',            price:140, time:'12 min', emoji:'🍞', img:'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=200&q=70', ingredients:'Mixed veg, butter, pav bread, spices' },
  ],
  italian: [
    { id:'IT01', name:'Margherita Pizza',  price:280, time:'20 min', emoji:'🍕', img:'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=200&q=70', ingredients:'Pizza dough, tomato sauce, mozzarella, basil' },
    { id:'IT02', name:'Chicken Pizza',    price:340, time:'20 min', emoji:'🍕', img:'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=200&q=70', ingredients:'Pizza dough, chicken, mozzarella, sauce, bell peppers' },
    { id:'IT03', name:'Pasta Arrabbiata', price:220, time:'15 min', emoji:'🍝', img:'https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?w=200&q=70', ingredients:'Penne, tomato, garlic, chili, parsley' },
    { id:'IT04', name:'Pasta Alfredo',    price:240, time:'15 min', emoji:'🍝', img:'https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?w=200&q=70', ingredients:'Fettuccine, cream, parmesan, butter' },
    { id:'IT05', name:'Chicken Lasagna',  price:320, time:'25 min', emoji:'🥘', img:'https://images.unsplash.com/photo-1574894709920-11b28e7367e3?w=200&q=70', ingredients:'Lasagna sheets, chicken, béchamel, cheese' },
    { id:'IT06', name:'Bruschetta',       price:150, time:'8 min',  emoji:'🍞', img:'https://images.unsplash.com/photo-1572695157366-5e585ab2b69f?w=200&q=70', ingredients:'Ciabatta, tomato, garlic, olive oil, basil' },
    { id:'IT07', name:'Tiramisu',         price:180, time:'5 min',  emoji:'🍰', img:'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=200&q=70', ingredients:'Mascarpone, coffee, ladyfingers, cocoa' },
  ],
  arabian: [
    { id:'AR01', name:'Chicken Shawarma', price:180, time:'10 min', emoji:'🌯', img:'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?w=200&q=70', ingredients:'Chicken, pita, garlic sauce, vegetables' },
    { id:'AR02', name:'Veg Shawarma',     price:150, time:'10 min', emoji:'🌯', img:'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?w=200&q=70', ingredients:'Mixed veg, pita, tahini, pickles, onion' },
    { id:'AR03', name:'Falafel Wrap',     price:150, time:'10 min', emoji:'🧆', img:'https://images.unsplash.com/photo-1554998171-89445e31c52a?w=200&q=70', ingredients:'Falafel, hummus, pita, tomato, cucumber' },
    { id:'AR04', name:'Hummus Platter',   price:140, time:'5 min',  emoji:'🫙', img:'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=200&q=70', ingredients:'Chickpeas, tahini, lemon, olive oil, pita' },
    { id:'AR05', name:'Chicken Kebab',    price:280, time:'20 min', emoji:'🍢', img:'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=200&q=70', ingredients:'Minced chicken, spices, onion, herbs' },
    { id:'AR06', name:'Arabic Coffee',    price:90,  time:'5 min',  emoji:'☕', img:'https://images.unsplash.com/photo-1510707577719-ae7c14805e3a?w=200&q=70', ingredients:'Arabic coffee, cardamom, saffron' },
  ],
  european: [
    { id:'EU01', name:'Club Sandwich',    price:200, time:'10 min', emoji:'🥪', img:'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=200&q=70', ingredients:'Bread, chicken, egg, lettuce, mayo, tomato' },
    { id:'EU02', name:'Grilled Chicken',  price:300, time:'20 min', emoji:'🍗', img:'https://images.unsplash.com/photo-1432139509613-5c4255815697?w=200&q=70', ingredients:'Chicken breast, herbs, lemon, garlic butter' },
    { id:'EU03', name:'Fish & Chips',     price:280, time:'18 min', emoji:'🐟', img:'https://images.unsplash.com/photo-1519984388953-d2406bc725e1?w=200&q=70', ingredients:'Battered fish, potato fries, tartar sauce' },
    { id:'EU04', name:'Mushroom Soup',    price:130, time:'10 min', emoji:'🍲', img:'https://images.unsplash.com/photo-1547592180-85f173990554?w=200&q=70', ingredients:'Mushroom, cream, garlic, thyme, bread' },
    { id:'EU05', name:'Caesar Salad',     price:160, time:'8 min',  emoji:'🥗', img:'https://images.unsplash.com/photo-1546793665-c74683f339c1?w=200&q=70', ingredients:'Romaine, croutons, parmesan, caesar dressing' },
    { id:'EU06', name:'Chicken Burger',   price:250, time:'15 min', emoji:'🍔', img:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=200&q=70', ingredients:'Chicken patty, brioche bun, cheese, lettuce, sauce' },
    { id:'EU07', name:'Chocolate Brownie',price:120, time:'5 min',  emoji:'🍫', img:'https://images.unsplash.com/photo-1564355808539-22fda35bed7e?w=200&q=70', ingredients:'Dark chocolate, butter, flour, eggs, vanilla' },
    { id:'EU08', name:'Cheesecake',       price:160, time:'5 min',  emoji:'🍰', img:'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=200&q=70', ingredients:'Cream cheese, graham cracker, sugar, vanilla' },
  ]
};

const ALL_ITEMS = Object.values(MENU).flat();
const MENU_TEXT = ALL_ITEMS.map(i =>
  `[${i.id}] ${i.emoji} ${i.name} — ₹${i.price} (${i.time})`
).join('\n');

// ─── SOLD OUT TRACKING ────────────────────────────────────────
const soldOutItems = new Set();

function getUnavailableNote() {
  if (soldOutItems.size === 0) return '';
  const names = ALL_ITEMS.filter(i => soldOutItems.has(i.id)).map(i => i.name);
  if (names.length === 0) return '';
  return `\n\nCURRENTLY SOLD OUT TODAY (do NOT offer or accept orders for these — say it's sold out and suggest a similar alternative): ${names.join(', ')}`;
}

// ─── ADMIN AUTH MIDDLEWARE ────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not set' });
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are "Fams", the AI assistant for Café Fams restaurant in Dhupguri, West Bengal.

LANGUAGE RULE — HIGHEST PRIORITY:
- If [LANG:en] → reply ONLY in English.
- If [LANG:bn] → reply ONLY in Bengali.
- NEVER use "আসসালামু আলাইকুম" or any religious greeting.
- Cool, friendly greetings only: "Hey!", "Hi!", "Great choice!", "Sure thing!" etc.

GREETING RULE:
- You already know the customer's name. Use it naturally.
- Never ask for name/phone/guests — already provided.

Your job:
1. Help customers browse menu and place orders
2. Walk through order confirmation properly
3. Help cancel orders (only within 5 minutes)
4. Show bill with 5% GST when asked
5. Be cool, friendly and professional

NO BEEF RULE: This restaurant does NOT serve beef. If asked, say not available and suggest chicken.

FULL MENU:
${MENU_TEXT}

ORDER FLOW — FOLLOW EXACTLY:
Step 1: Customer asks for item → ask how many plates/cups
Step 2: Customer gives quantity → show confirmation summary:
  "Got it! Just to confirm:
  • [Item Name] x[qty] — ₹[price each] × [qty] = ₹[total]
  Ready to place this order? Reply Yes to confirm."
Step 3: Customer says Yes/Confirm → THEN place the order.

ORDER RULES:
- NEVER place order without customer confirmation
- Always show item name + quantity + per-item price + line total in confirmation
- Add 5% GST on subtotal when showing bill
- Never make up dishes not in menu

⚠️ CRITICAL FORMATTING RULE — MUST FOLLOW ALWAYS:
When listing ANY menu items (2 or more), ALWAYS display them like this:

🖼️ **Café Latte** — ₹120 _(5 min)_
[img:CT02]

🖼️ **Cappuccino** — ₹110 _(5 min)_
[img:CT03]

🖼️ **Cold Coffee** — ₹130 _(5 min)_
[img:CT04]

Rules:
- ONE item per line, NEVER run them together in a sentence
- Each item MUST be **bold**
- Each item MUST have [img:ITEM_ID] tag on the next line (use the ID from the menu above e.g. CT02, IN05 etc.)
- Never write "We have Café Latte, Cappuccino and Cold Coffee" — that is WRONG
- Even for 2 items, use the line-by-line format

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
After EVERY confirmed order, add at the very end:
[ORDER_DATA]{"confirmed":true,"subtotal":SUBTOTAL,"items":[{"name":"Item Name","qty":1,"price":280}]}[/ORDER_DATA]

Add ONLY when placing confirmed order. Never show this tag to customer.`;

// ─── TELEGRAM ────────────────────────────────────────────────
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

// ─── ACTIVITY LOG ─────────────────────────────────────────────
function logActivity(tableNumber, guestName, message, reply, isOrder) {
  activityLog.unshift({
    tableNumber, guestName: guestName || 'Guest',
    message: (message || '').slice(0, 200),
    reply: (reply || '').slice(0, 200),
    isOrder: !!isOrder,
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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1024 })
      });
      if (!res.ok) { console.error(`Groq ${model} failed:`, await res.text()); continue; }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) { console.log(`✅ Groq: ${model}`); return content; }
    } catch (e) { console.error(`Groq ${model}:`, e.message); }
  }
  return null;
}

// ─── OPENROUTER CALL ─────────────────────────────────────────
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
        body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 1024 })
      });
      if (!res.ok) { console.error(`OR ${model} failed:`, await res.text()); continue; }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) { console.log(`✅ OpenRouter fallback: ${model}`); return content; }
    } catch (e) { console.error(`OR ${model}:`, e.message); }
  }
  return null;
}

// ─── ROUTES ──────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'OK', message: 'Café Fams Backend Running ☕',
    node: process.version,
    groq: GROQ_API_KEY ? 'configured' : 'missing',
    openrouter: OPENROUTER_API_KEY ? 'configured' : 'missing',
    telegram: TELEGRAM_BOT_TOKEN ? 'configured' : 'missing',
    admin: ADMIN_PASSWORD ? 'configured' : 'missing',
    timestamp: new Date().toISOString()
  });
});

// Menu (public) — includes images + availability
app.get('/api/menu', (req, res) => {
  const menuWithAvailability = {};
  Object.entries(MENU).forEach(([cat, items]) => {
    menuWithAvailability[cat] = items.map(i => ({ ...i, available: !soldOutItems.has(i.id) }));
  });
  res.json({ success: true, menu: menuWithAvailability, total: ALL_ITEMS.length });
});

// ─── REORDER LOOKUP ──────────────────────────────────────────
app.get('/api/reorder-lookup', async (req, res) => {
  const phone = (req.query.phone || '').toString().trim();
  if (!phone || phone.replace(/\D/g, '').length < 6) return res.json({ success: true, found: false });
  try {
    const matches = await getOrdersByPhoneFromSheet(phone);
    if (matches.length === 0) return res.json({ success: true, found: false });
    const latest = matches[0];
    const items = parseItemsFromRow(latest);
    if (items.length === 0) return res.json({ success: true, found: false });
    res.json({
      success: true, found: true,
      order: { orderId: latest[0], time: latest[1], items, subtotal: Number(latest[7]) || 0, total: Number(latest[9]) || 0 },
      previousOrderCount: matches.length
    });
  } catch (e) {
    console.error('Reorder lookup error:', e.message);
    res.json({ success: true, found: false });
  }
});

// ─── FEEDBACK / RATING (single, clean route) ─────────────────
app.post('/api/feedback', async (req, res) => {
  const { orderId, tableNumber, guestName, rating, comment } = req.body;
  const r = parseInt(rating);
  if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });

  const entry = {
    orderId: orderId || null,
    tableNumber: tableNumber || null,
    guestName: guestName || 'Guest',
    rating: r,
    comment: (comment || '').slice(0, 300),
    time: new Date().toISOString()
  };
  feedbackList.unshift(entry);
  if (feedbackList.length > MAX_FEEDBACK) feedbackList.length = MAX_FEEDBACK;

  const stars = '⭐'.repeat(r) + '☆'.repeat(5 - r);
  const istTime = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: true,
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  });

  await sendTelegram(
    `⭐ <b>New Feedback!</b>\n━━━━━━━━━━━━━━━\n` +
    `📋 Order: <b>${orderId || 'N/A'}</b>\n` +
    `🪑 Table: <b>${tableNumber || '—'}</b>\n` +
    `👤 Name: <b>${entry.guestName}</b>\n━━━━━━━━━━━━━━━\n` +
    `${stars} (${r}/5)\n` +
    `💬 ${entry.comment || '—'}\n━━━━━━━━━━━━━━━\n⏰ ${istTime} IST`
  );

  res.json({ success: true, message: 'Feedback received, thank you!' });
});

// Public ratings — About page + chatbot
app.get('/api/public/ratings', (req, res) => {
  const avg = feedbackList.length
    ? Math.round((feedbackList.reduce((s, f) => s + f.rating, 0) / feedbackList.length) * 10) / 10
    : 0;
  const recent = feedbackList
    .filter(f => f.comment || f.rating >= 4)
    .slice(0, 5);
  res.json({ success: true, avgRating: avg, totalReviews: feedbackList.length, recent });
});

// Also keep /api/feedback/public as alias
app.get('/api/feedback/public', (req, res) => {
  const avg = feedbackList.length
    ? Math.round((feedbackList.reduce((s, f) => s + f.rating, 0) / feedbackList.length) * 10) / 10
    : 0;
  const recent = feedbackList.slice(0, 8).map(f => ({
    guestName: f.guestName, rating: f.rating, comment: f.comment, time: f.time
  }));
  res.json({ success: true, avgRating: avg, totalReviews: feedbackList.length, recent });
});

// ─── MAIN CHAT ───────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const {
    message, history = [], tableNumber = 1, sessionId,
    lang = 'en', guestName = 'Guest', guestCount = 1, guestPhone = ''
  } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!GROQ_API_KEY && !OPENROUTER_API_KEY) return res.status(500).json({ error: 'No AI API key configured' });

  try {
    const taggedMessage = `[LANG:${lang}] ${message}`;
    const messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT + getUnavailableNote() +
          `\n\nCUSTOMER INFO (already collected, do not ask again):\n` +
          `Name: ${guestName}\nGuests: ${guestCount}\nPhone: ${guestPhone || 'not provided'}\nTable: ${tableNumber}`
      },
      ...history.map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.content })),
      { role: 'user', content: taggedMessage }
    ];

    let rawReply = await callGroq(messages);
    if (!rawReply) rawReply = await callOpenRouter(messages);
    if (!rawReply) return res.status(503).json({ error: 'All AI models temporarily busy. Please try again.' });

    // Extract ORDER_DATA
    const tagMatch = rawReply.match(/\[ORDER_DATA\]\s*(\{.*?\})\s*\[\/ORDER_DATA\]/s);
    let orderData = null;
    if (tagMatch) {
      try {
        const parsed = JSON.parse(tagMatch[1]);
        if (parsed && parsed.confirmed && typeof parsed.subtotal === 'number' && parsed.subtotal > 0) {
          orderData = parsed;
        }
      } catch (e) { console.error('ORDER_DATA parse error:', e.message); }
    }

    // Remove tag from customer-facing reply, also process [img:ID] tags
    let reply = rawReply.replace(/\[ORDER_DATA\].*?\[\/ORDER_DATA\]/s, '').trim();

    // Process [img:ID] tags — replace with actual image URLs for the frontend
    reply = reply.replace(/\[img:([A-Z0-9]+)\]/g, (match, id) => {
      const item = ALL_ITEMS.find(i => i.id === id);
      return item ? `[IMG_URL:${item.img}|${item.name}]` : '';
    });

    if (orderData) {
      const subtotal = Math.round(orderData.subtotal);
      const gst      = Math.round(subtotal * 0.05);
      const total    = subtotal + gst;
      const orderId  = 'CF-' + Math.floor(1000 + Math.random() * 9000);
      const items    = Array.isArray(orderData.items) ? orderData.items : [];

      const itemsText = items.length > 0
        ? items.map(i => `  • ${i.name} × ${i.qty} — ₹${i.price * i.qty}`).join('\n')
        : `  • ${message}`;

      const istTime = new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', hour12: true,
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      orders[orderId] = {
        sessionId, tableNumber, message,
        subtotal, gst, total, items,
        guestName, guestCount, guestPhone,
        time: new Date().toISOString(),
        status: 'confirmed',
        kitchenStatus: 'pending'
      };

      const itemsSummary = items.length > 0 ? items.map(i => `${i.name} x${i.qty}`).join(', ') : message;
      await appendToSheet([
        orderId,
        new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        guestName, guestPhone || '', String(tableNumber), String(guestCount),
        itemsSummary, subtotal, gst, total, 'confirmed', JSON.stringify(items)
      ]);

      reply = reply.replace(/CF-[A-Za-z0-9]{4,6}/g, orderId);
      if (!reply.includes(orderId)) reply += `\n\nOrder ID: ${orderId}`;

      await sendTelegram(
        `🆕 <b>New Order!</b>\n━━━━━━━━━━━━━━━\n` +
        `📋 Order ID: <b>${orderId}</b>\n` +
        `🪑 Table: <b>${tableNumber}</b>\n` +
        `👤 Name: <b>${guestName}</b>\n` +
        `👥 Guests: ${guestCount}\n` +
        `📱 Phone: ${guestPhone || 'not provided'}\n━━━━━━━━━━━━━━━\n` +
        `🍽️ <b>Items:</b>\n${itemsText}\n━━━━━━━━━━━━━━━\n` +
        `💵 Subtotal: ₹${subtotal}\n🧾 GST (5%): ₹${gst}\n💰 <b>Total: ₹${total}</b>\n━━━━━━━━━━━━━━━\n` +
        `⏰ ${istTime} IST`
      );

      logActivity(tableNumber, guestName, message, reply, true);
      return res.json({
        success: true, reply, orderId,
        orderSubtotal: subtotal, orderGst: gst, orderTotal: total
      });
    }

    logActivity(tableNumber, guestName, message, reply, false);
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
  if (!order) return res.json({ success: false, message: `Order ${orderId} not found.` });
  const diffMinutes = (Date.now() - new Date(order.time)) / 60000;
  if (diffMinutes > 5) return res.json({ success: false, message: 'More than 5 minutes passed. Cannot cancel. Please ask staff.' });
  orders[orderId].status = 'cancelled';
  await sendTelegram(`❌ <b>Order Cancelled</b>\n📋 ${orderId}\n🪑 Table: ${tableNumber}`);
  res.json({ success: true, message: `Order ${orderId} has been cancelled.` });
});

// ─── ORDER NOTE ──────────────────────────────────────────────
app.post('/api/note', async (req, res) => {
  const { orderId, tableNumber, guestName, note } = req.body;
  if (!orderId || !note) return res.status(400).json({ error: 'orderId and note required' });
  if (orders[orderId]) orders[orderId].note = note;
  const istTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  await sendTelegram(`📝 <b>Special Note</b>\n📋 ${orderId}\n🪑 Table: <b>${tableNumber}</b>\n👤 ${guestName}\n💬 <b>${note}</b>\n⏰ ${istTime} IST`);
  res.json({ success: true, message: 'Note sent!' });
});

// ─── CALL WAITER ─────────────────────────────────────────────
app.post('/api/call-waiter', async (req, res) => {
  const { tableNumber, guestName, reason, sessionId } = req.body;
  if (!tableNumber) return res.status(400).json({ error: 'tableNumber required' });
  const istTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  await sendTelegram(`🛎️ <b>Waiter Called!</b>\n━━━━━━━━━━━━━━━\n🪑 Table: <b>${tableNumber}</b>\n👤 ${guestName || 'Guest'}\n📋 Need: <b>${reason || 'Assistance'}</b>\n⏰ ${istTime} IST`);
  res.json({ success: true, message: 'Waiter has been notified!' });
});

// ─── BILL ────────────────────────────────────────────────────
app.post('/api/bill', async (req, res) => {
  const { items = [], tableNumber } = req.body;
  const subtotal = items.reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);
  const gst = Math.round(subtotal * 0.05);
  const total = subtotal + gst;
  res.json({ success: true, bill: { tableNumber, items, subtotal, gst, gstPercent: 5, total, billId: 'BILL-' + Date.now() } });
});

// ─── PAYMENT ─────────────────────────────────────────────────
app.post('/api/payment/create', async (req, res) => {
  const { amount, tableNumber, orderId } = req.body;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return res.status(500).json({ error: 'Razorpay keys missing' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
    const order = await razorpay.orders.create({
      amount: Math.round(amount) * 100, currency: 'INR',
      receipt: `cafefam_t${tableNumber}_${Date.now()}`,
      notes: { tableNumber, orderId }
    });
    res.json({ success: true, order, key: RAZORPAY_KEY_ID });
  } catch (e) { res.status(500).json({ error: 'Payment creation failed', detail: e.message }); }
});

app.post('/api/payment/verify', async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, tableNumber } = req.body;
  await sendTelegram(`💰 <b>Payment Received!</b>\n🪑 Table: ${tableNumber}\n💳 ${razorpay_payment_id}`);
  res.json({ success: true, message: 'Payment verified!' });
});

// ─── ADMIN ROUTES ────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(500).json({ success: false, error: 'ADMIN_PASSWORD not set' });
  if (password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ success: false, error: 'Wrong password' });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const list = Object.entries(orders)
    .map(([orderId, o]) => ({ orderId, ...o }))
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json({ success: true, orders: list });
});

app.post('/api/admin/order-status', requireAdmin, async (req, res) => {
  const { orderId, kitchenStatus } = req.body;
  const valid = ['pending', 'preparing', 'ready', 'served'];
  if (!orderId || !valid.includes(kitchenStatus)) return res.status(400).json({ error: 'Invalid params' });
  if (!orders[orderId]) return res.status(404).json({ error: 'Order not found' });
  orders[orderId].kitchenStatus = kitchenStatus;
  if (kitchenStatus === 'ready') {
    const istTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: '2-digit', minute: '2-digit' });
    await sendTelegram(`🍽️ <b>Order Ready!</b>\n📋 ${orderId} — Table ${orders[orderId].tableNumber}\n⏰ ${istTime} IST`);
  }
  res.json({ success: true, message: `${orderId} → ${kitchenStatus}` });
});

app.get('/api/admin/menu', requireAdmin, (req, res) => {
  const menuWithState = {};
  Object.entries(MENU).forEach(([cat, items]) => {
    menuWithState[cat] = items.map(i => ({ ...i, soldOut: soldOutItems.has(i.id) }));
  });
  res.json({ success: true, menu: menuWithState });
});

app.post('/api/admin/sold-out', requireAdmin, (req, res) => {
  const { itemId, soldOut } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  const item = ALL_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (soldOut) soldOutItems.add(itemId); else soldOutItems.delete(itemId);
  res.json({ success: true, itemId, soldOut: !!soldOut, name: item.name });
});

app.post('/api/admin/discount', requireAdmin, async (req, res) => {
  const { orderId, type, value } = req.body;
  if (!orderId || !orders[orderId]) return res.status(404).json({ error: 'Order not found' });
  if (!['percent', 'flat'].includes(type) || typeof value !== 'number' || value <= 0) return res.status(400).json({ error: 'Invalid discount' });
  const order = orders[orderId];
  const baseTotal = order.subtotal + order.gst;
  const discountAmount = type === 'percent' ? Math.round(baseTotal * (value / 100)) : Math.round(value);
  const newTotal = Math.max(0, baseTotal - discountAmount);
  order.discount = { type, value, amount: discountAmount };
  order.total = newTotal;
  await sendTelegram(`🏷️ <b>Discount Applied</b>\n📋 ${orderId}\n💸 ${type === 'percent' ? value + '%' : '₹' + value} off (₹${discountAmount})\n💰 New Total: ₹${newTotal}`);
  res.json({ success: true, orderId, newTotal, discountAmount });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  const todaysOrders = Object.values(orders).filter(o => {
    const d = new Date(o.time).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    return d === todayStr && o.status === 'confirmed';
  });
  const totalRevenue = todaysOrders.reduce((s, o) => s + (o.total || 0), 0);
  const totalOrders = todaysOrders.length;
  const itemCounts = {};
  todaysOrders.forEach(o => (o.items || []).forEach(i => { itemCounts[i.name] = (itemCounts[i.name] || 0) + (i.qty || 1); }));
  const topItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty }));
  res.json({ success: true, date: todayStr, totalOrders, totalRevenue, avgOrderValue: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0, topItems });
});

// ─── ADMIN FEEDBACK (full list) ───────────────────────────────
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const avg = feedbackList.length
    ? Math.round((feedbackList.reduce((s, f) => s + f.rating, 0) / feedbackList.length) * 10) / 10
    : 0;
  res.json({ success: true, avgRating: avg, totalReviews: feedbackList.length, feedback: feedbackList });
});

// ─── ADMIN ACTIVITY ───────────────────────────────────────────
app.get('/api/admin/activity', requireAdmin, (req, res) => {
  res.json({ success: true, activity: activityLog.slice(0, 60) });
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { console.error('Unhandled error:', err); res.status(500).json({ error: 'Internal server error' }); });

app.listen(PORT, () => {
  console.log(`☕ Café Fams Backend running on port ${PORT}`);
  console.log(`🤖 Groq:        ${GROQ_API_KEY       ? '✅ configured' : '❌ MISSING'}`);
  console.log(`🔁 OpenRouter:  ${OPENROUTER_API_KEY  ? '✅ configured' : '⚠️  missing'}`);
  console.log(`📱 Telegram:    ${TELEGRAM_BOT_TOKEN  ? '✅ configured' : '❌ MISSING'}`);
  console.log(`💳 Razorpay:    ${RAZORPAY_KEY_ID     ? '✅ configured' : '⚠️  missing'}`);
  console.log(`🔐 Admin Panel: ${ADMIN_PASSWORD      ? '✅ configured' : '⚠️  missing'}`);
});
