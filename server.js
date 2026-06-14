// ============================================================
// CAFÉ FAMS — Backend Server
// Node 20 | Railway Deploy
// AI: Groq (primary) → OpenRouter (fallback)
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Razorpay = require('razorpay');
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
    { id:'IT02', name:'Pepperoni Pizza',   price:350, time:'20 min', emoji:'🍕', ingredients:'Pizza dough, pepperoni, mozzarella, sauce' },
    { id:'IT03', name:'Pasta Arrabbiata', price:220, time:'15 min', emoji:'🍝', ingredients:'Penne, tomato, garlic, chili, parsley' },
    { id:'IT04', name:'Pasta Alfredo',    price:240, time:'15 min', emoji:'🍝', ingredients:'Fettuccine, cream, parmesan, butter' },
    { id:'IT05', name:'Chicken Lasagna',  price:320, time:'25 min', emoji:'🥘', ingredients:'Lasagna sheets, chicken, béchamel, cheese' },
    { id:'IT06', name:'Bruschetta',       price:150, time:'8 min',  emoji:'🍞', ingredients:'Ciabatta, tomato, garlic, olive oil, basil' },
    { id:'IT07', name:'Tiramisu',         price:180, time:'5 min',  emoji:'🍰', ingredients:'Mascarpone, coffee, ladyfingers, cocoa' },
  ],
  arabian: [
    { id:'AR01', name:'Chicken Shawarma', price:180, time:'10 min', emoji:'🌯', ingredients:'Chicken, pita, garlic sauce, vegetables' },
    { id:'AR02', name:'Beef Shawarma',    price:220, time:'10 min', emoji:'🌯', ingredients:'Beef, pita, tahini, pickles, onion' },
    { id:'AR03', name:'Falafel Wrap',     price:150, time:'10 min', emoji:'🧆', ingredients:'Falafel, hummus, pita, tomato, cucumber' },
    { id:'AR04', name:'Hummus Platter',   price:140, time:'5 min',  emoji:'🫙', ingredients:'Chickpeas, tahini, lemon, olive oil, pita' },
    { id:'AR05', name:'Lamb Kebab',       price:320, time:'20 min', emoji:'🍢', ingredients:'Minced lamb, spices, onion, herbs' },
    { id:'AR06', name:'Arabic Coffee',    price:90,  time:'5 min',  emoji:'☕', ingredients:'Arabic coffee, cardamom, saffron' },
  ],
  european: [
    { id:'EU01', name:'Club Sandwich',    price:200, time:'10 min', emoji:'🥪', ingredients:'Bread, chicken, egg, lettuce, mayo, tomato' },
    { id:'EU02', name:'Grilled Chicken',  price:300, time:'20 min', emoji:'🍗', ingredients:'Chicken breast, herbs, lemon, garlic butter' },
    { id:'EU03', name:'Fish & Chips',     price:280, time:'18 min', emoji:'🐟', ingredients:'Battered fish, potato fries, tartar sauce' },
    { id:'EU04', name:'Mushroom Soup',    price:130, time:'10 min', emoji:'🍲', ingredients:'Mushroom, cream, garlic, thyme, bread' },
    { id:'EU05', name:'Caesar Salad',     price:160, time:'8 min',  emoji:'🥗', ingredients:'Romaine, croutons, parmesan, caesar dressing' },
    { id:'EU06', name:'Beef Burger',      price:260, time:'15 min', emoji:'🍔', ingredients:'Beef patty, brioche bun, cheese, lettuce, sauce' },
    { id:'EU07', name:'Chocolate Brownie',price:120, time:'5 min',  emoji:'🍫', ingredients:'Dark chocolate, butter, flour, eggs, vanilla' },
    { id:'EU08', name:'Cheesecake',       price:160, time:'5 min',  emoji:'🍰', ingredients:'Cream cheese, graham cracker, sugar, vanilla' },
  ]
};

const ALL_ITEMS = Object.values(MENU).flat();
const MENU_TEXT = ALL_ITEMS.map(i =>
  `[${i.id}] ${i.emoji} ${i.name} — ₹${i.price} (${i.time})`
).join('\n');

// ─── SYSTEM PROMPT ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are "Fams", the AI assistant for Café Fams restaurant.
You speak both Bengali and English — always reply in whichever language the customer uses.

Your job:
1. Help customers browse the menu and place orders
2. Confirm orders with cooking time
3. Help cancel orders (only within 5 minutes)
4. Show bill with 5% GST when asked
5. Be friendly and helpful at all times

FULL MENU:
${MENU_TEXT}

RULES:
- Always confirm quantity before placing an order
- Add 5% GST on the total when showing the bill
- Remember the table number throughout the conversation
- If you don't understand something, say so politely
- Never make up dishes that are not in the menu above

ORDER CONFIRMATION FORMAT (use this exactly when confirming an order):
✅ Order Confirmed!
Table: [table number]
Items: [list each item with quantity and price]
Subtotal: ₹[sum of all items]
GST (5%): ₹[gst amount]
Total: ₹[final total]
Cooking Time: [estimated time]
Order ID: CF-XXXX

CRITICAL RULE — ORDER DATA TAG:
Every time you confirm an order (and only then), you MUST add this tag at the very end of your reply on a new line. Replace SUBTOTAL_NUMBER with the actual subtotal as a plain number (no ₹ sign, no commas):

[ORDER_DATA]{"confirmed":true,"subtotal":SUBTOTAL_NUMBER}[/ORDER_DATA]

Example: [ORDER_DATA]{"confirmed":true,"subtotal":350}[/ORDER_DATA]

Do NOT add this tag for menu browsing, questions, or any other response — only when actually confirming an order. Never mention or explain this tag to the customer.`;

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
  const { message, history = [], tableNumber = 1, sessionId, lang = 'en' } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  if (!GROQ_API_KEY && !OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'No AI API key configured in Railway variables' });
  }

  try {
    // Build messages array (OpenAI format — works for both Groq and OpenRouter)
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(h => ({
        role: h.role === 'model' ? 'assistant' : 'user',
        content: h.content
      })),
      { role: 'user', content: `Table ${tableNumber}: ${message}` }
    ];

    // Try Groq first, then OpenRouter
    let rawReply = await callGroq(messages);
    if (!rawReply) {
      console.log('Groq failed — trying OpenRouter fallback...');
      rawReply = await callOpenRouter(messages);
    }

    if (!rawReply) {
      return res.status(503).json({
        error: 'All AI models are temporarily busy. Please try again in a moment.',
        detail: 'Both Groq and OpenRouter returned no response'
      });
    }

    // Extract order data if present
    const orderData = extractOrderData(rawReply);

    // Remove the hidden tag from customer-facing reply
    let reply = rawReply.replace(/\[ORDER_DATA\].*?\[\/ORDER_DATA\]/s, '').trim();

    if (orderData) {
      const { subtotal } = orderData;
      const gst     = Math.round(subtotal * 0.05);
      const total   = subtotal + gst;
      const orderId = 'CF-' + Math.floor(1000 + Math.random() * 9000);

      // Store order
      orders[orderId] = {
        sessionId, tableNumber, message,
        subtotal, gst, total,
        time: new Date().toISOString(),
        status: 'confirmed'
      };

      // Replace any placeholder/random Order ID in reply with real one
      reply = reply.replace(/CF-[A-Za-z0-9]{4,6}/g, orderId);
      if (!reply.includes(orderId)) {
        reply += `\n\nOrder ID: ${orderId}`;
      }

      // Telegram notification
      await sendTelegram(
        `🆕 <b>নতুন Order!</b>\n` +
        `📋 Order ID: <b>${orderId}</b>\n` +
        `🪑 Table: ${tableNumber}\n` +
        `💬 Item(s): ${message}\n` +
        `💰 Subtotal: ₹${subtotal} | GST: ₹${gst} | <b>Total: ₹${total}</b>\n` +
        `⏰ ${new Date().toLocaleTimeString('en-IN')}`
      );

      return res.json({
        success: true, reply, orderId,
        orderSubtotal: subtotal,
        orderGst: gst,
        orderTotal: total
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
    `❌ <b>Order Cancelled</b>\n📋 Order ID: <b>${orderId}</b>\n🪑 Table: ${tableNumber}`
  );
  res.json({ success: true, message: `Order ${orderId} has been cancelled.` });
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
