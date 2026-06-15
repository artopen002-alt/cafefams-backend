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
  allowedHeaders: ['Content-Type', 'Authorization']
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

// ─── EXTRACT ORDER DATA ──────────────────────────────────────
function extractOrderData(reply) {
  const match = reply.match(/\[ORDER_DATA\]\s*(\{.*?\})\s*\[\/ORDER_DATA\]/s);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && parsed.confirmed && typeof parsed.subtotal === 'number' && parsed.subtotal > 0) {
      return { subtotal: Math.round(parsed.subtotal), raw: match[0] };
    }
  } catch (e) {
    console.error('ORDER_DATA parse error:', e.message);
  }
  return null;
}

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
    timestamp: new Date().toISOString()
  });
});

// Menu
app.get('/api/menu', (req, res) => {
  res.json({ success: true, menu: MENU, total: ALL_ITEMS.length });
});

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
        content: SYSTEM_PROMPT +
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
        status: 'confirmed'
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
        'confirmed'
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

      return res.json({
        success: true, reply, orderId,
        orderSubtotal: subtotal, orderGst: gst, orderTotal: total
      });
    }

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
  const { razorpay_payment_id, razorpay_order_id, tableNumber } = req.body;
  await sendTelegram(
    `💰 <b>Payment Received!</b>\n` +
    `🪑 Table: ${tableNumber}\n` +
    `💳 Payment ID: ${razorpay_payment_id}\n` +
    `📋 Order ID: ${razorpay_order_id}`
  );
  res.json({ success: true, message: 'Payment verified!' });
});

// ─── 404 ─────────────────────────────────────────────────────
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
});
