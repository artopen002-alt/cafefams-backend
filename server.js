// ============================================================
// CAFÉ FAMS — Backend Server (Node 20, Express)
// Railway deploy করবে এখানে
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Razorpay = require('razorpay');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS FIX ─────────────────────────────────────────────
// এটাই সবচেয়ে গুরুত্বপূর্ণ — Netlify থেকে request allow করে
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors()); // preflight requests handle

app.use(express.json({ limit: '10mb' }));

// ─── ENV CHECK ────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// ─── IN-MEMORY ORDER STORE ────────────────────────────────
// Railway restart হলে reset হয় — production-এ Firebase লাগাবে
const orders = {};

// ─── MENU DATA ────────────────────────────────────────────
const MENU = {
  coffee_tea: [
    { id: 'CT01', name: 'Espresso', price: 80, time: '3 min', category: 'Coffee & Tea', emoji: '☕', ingredients: 'Arabica beans, hot water' },
    { id: 'CT02', name: 'Café Latte', price: 120, time: '5 min', category: 'Coffee & Tea', emoji: '🥛', ingredients: 'Espresso, steamed milk, foam' },
    { id: 'CT03', name: 'Cappuccino', price: 110, time: '5 min', category: 'Coffee & Tea', emoji: '☕', ingredients: 'Espresso, steamed milk, dry foam' },
    { id: 'CT04', name: 'Cold Coffee', price: 130, time: '5 min', category: 'Coffee & Tea', emoji: '🧊', ingredients: 'Coffee, milk, ice, sugar' },
    { id: 'CT05', name: 'Masala Chai', price: 40, time: '4 min', category: 'Coffee & Tea', emoji: '🍵', ingredients: 'Tea, milk, ginger, cardamom, spices' },
    { id: 'CT06', name: 'Green Tea', price: 60, time: '3 min', category: 'Coffee & Tea', emoji: '🍵', ingredients: 'Green tea leaves, hot water, lemon' },
    { id: 'CT07', name: 'Mango Smoothie', price: 150, time: '5 min', category: 'Coffee & Tea', emoji: '🥭', ingredients: 'Fresh mango, milk, ice, sugar' },
    { id: 'CT08', name: 'Strawberry Shake', price: 160, time: '5 min', category: 'Coffee & Tea', emoji: '🍓', ingredients: 'Strawberry, milk, ice cream, sugar' }
  ],
  indian: [
    { id: 'IN01', name: 'Paneer Butter Masala', price: 220, time: '15 min', category: 'Indian', emoji: '🧆', ingredients: 'Paneer, tomato, butter, cream, spices' },
    { id: 'IN02', name: 'Dal Tadka', price: 130, time: '12 min', category: 'Indian', emoji: '🍲', ingredients: 'Yellow dal, ghee, cumin, garlic, spices' },
    { id: 'IN03', name: 'Chicken Curry', price: 260, time: '20 min', category: 'Indian', emoji: '🍛', ingredients: 'Chicken, onion, tomato, garam masala' },
    { id: 'IN04', name: 'Biryani (Veg)', price: 200, time: '20 min', category: 'Indian', emoji: '🍚', ingredients: 'Basmati rice, vegetables, saffron, spices' },
    { id: 'IN05', name: 'Biryani (Chicken)', price: 280, time: '25 min', category: 'Indian', emoji: '🍗', ingredients: 'Basmati rice, chicken, dum spices' },
    { id: 'IN06', name: 'Aloo Paratha', price: 100, time: '10 min', category: 'Indian', emoji: '🫓', ingredients: 'Wheat flour, potato, spices, butter' },
    { id: 'IN07', name: 'Samosa (2 pcs)', price: 50, time: '5 min', category: 'Indian', emoji: '🥟', ingredients: 'Maida, potato, peas, spices' },
    { id: 'IN08', name: 'Pav Bhaji', price: 140, time: '12 min', category: 'Indian', emoji: '🍞', ingredients: 'Mixed veg, butter, pav bread, spices' }
  ],
  italian: [
    { id: 'IT01', name: 'Margherita Pizza', price: 280, time: '20 min', category: 'Italian', emoji: '🍕', ingredients: 'Pizza dough, tomato sauce, mozzarella, basil' },
    { id: 'IT02', name: 'Pepperoni Pizza', price: 350, time: '20 min', category: 'Italian', emoji: '🍕', ingredients: 'Pizza dough, pepperoni, mozzarella, sauce' },
    { id: 'IT03', name: 'Pasta Arrabbiata', price: 220, time: '15 min', category: 'Italian', emoji: '🍝', ingredients: 'Penne, tomato, garlic, chili, parsley' },
    { id: 'IT04', name: 'Pasta Alfredo', price: 240, time: '15 min', category: 'Italian', emoji: '🍝', ingredients: 'Fettuccine, cream, parmesan, butter' },
    { id: 'IT05', name: 'Chicken Lasagna', price: 320, time: '25 min', category: 'Italian', emoji: '🥘', ingredients: 'Lasagna sheets, chicken, béchamel, cheese' },
    { id: 'IT06', name: 'Bruschetta', price: 150, time: '8 min', category: 'Italian', emoji: '🍞', ingredients: 'Ciabatta, tomato, garlic, olive oil, basil' },
    { id: 'IT07', name: 'Tiramisu', price: 180, time: '5 min', category: 'Italian', emoji: '🍰', ingredients: 'Mascarpone, coffee, ladyfingers, cocoa' }
  ],
  arabian: [
    { id: 'AR01', name: 'Shawarma (Chicken)', price: 180, time: '10 min', category: 'Arabian', emoji: '🌯', ingredients: 'Chicken, pita, garlic sauce, vegetables' },
    { id: 'AR02', name: 'Shawarma (Beef)', price: 220, time: '10 min', category: 'Arabian', emoji: '🌯', ingredients: 'Beef, pita, tahini, pickles, onion' },
    { id: 'AR03', name: 'Falafel Wrap', price: 150, time: '10 min', category: 'Arabian', emoji: '🧆', ingredients: 'Falafel, hummus, pita, tomato, cucumber' },
    { id: 'AR04', name: 'Hummus Platter', price: 140, time: '5 min', category: 'Arabian', emoji: '🫙', ingredients: 'Chickpeas, tahini, lemon, olive oil, pita' },
    { id: 'AR05', name: 'Lamb Kebab', price: 320, time: '20 min', category: 'Arabian', emoji: '🍢', ingredients: 'Minced lamb, spices, onion, herbs' },
    { id: 'AR06', name: 'Arabic Coffee', price: 90, time: '5 min', category: 'Arabian', emoji: '☕', ingredients: 'Arabic coffee, cardamom, saffron' }
  ],
  european: [
    { id: 'EU01', name: 'Club Sandwich', price: 200, time: '10 min', category: 'European', emoji: '🥪', ingredients: 'Bread, chicken, egg, lettuce, mayo, tomato' },
    { id: 'EU02', name: 'Grilled Chicken', price: 300, time: '20 min', category: 'European', emoji: '🍗', ingredients: 'Chicken breast, herbs, lemon, garlic butter' },
    { id: 'EU03', name: 'Fish & Chips', price: 280, time: '18 min', category: 'European', emoji: '🐟', ingredients: 'Battered fish, potato fries, tartar sauce' },
    { id: 'EU04', name: 'Mushroom Soup', price: 130, time: '10 min', category: 'European', emoji: '🍲', ingredients: 'Mushroom, cream, garlic, thyme, bread' },
    { id: 'EU05', name: 'Caesar Salad', price: 160, time: '8 min', category: 'European', emoji: '🥗', ingredients: 'Romaine, croutons, parmesan, caesar dressing' },
    { id: 'EU06', name: 'Beef Burger', price: 260, time: '15 min', category: 'European', emoji: '🍔', ingredients: 'Beef patty, brioche bun, cheese, lettuce, sauce' },
    { id: 'EU07', name: 'Chocolate Brownie', price: 120, time: '5 min', category: 'European', emoji: '🍫', ingredients: 'Dark chocolate, butter, flour, eggs, vanilla' },
    { id: 'EU08', name: 'Cheesecake', price: 160, time: '5 min', category: 'European', emoji: '🍰', ingredients: 'Cream cheese, graham cracker, sugar, vanilla' }
  ]
};

const ALL_MENU_ITEMS = Object.values(MENU).flat();

// ─── MENU TEXT FOR AI ─────────────────────────────────────
const MENU_TEXT = ALL_MENU_ITEMS.map(item =>
  `[${item.id}] ${item.emoji} ${item.name} — ₹${item.price} (${item.time}) — ${item.category}`
).join('\n');

// ─── SYSTEM PROMPT ────────────────────────────────────────
const SYSTEM_PROMPT = `তুমি Café Fams-এর AI assistant। তোমার নাম "Fams"।
তুমি বাংলা এবং English দুটোতেই কথা বলতে পারো। Customer যেভাবে কথা বলে সেভাবেই reply করো।

তোমার কাজ:
1. Customer-কে menu দেখাও এবং order নিতে সাহায্য করো
2. Order confirm করো এবং cooking time জানাও
3. Order cancel করতে সাহায্য করো (5 মিনিটের মধ্যে)
4. Bill দেখাও (GST 5% সহ)
5. Payment-এর ব্যবস্থা করো

MENU:
${MENU_TEXT}

Rules:
- সবসময় friendly এবং helpful থাকো
- Order নেওয়ার সময় quantity confirm করো
- Bill-এ 5% GST যোগ করো
- Order ID format: CF-XXXX
- Table number সবসময় মনে রাখো
- যদি কিছু বুঝতে না পারো, "আমি বুঝিনি, একটু আবার বলুন" বলো

Order নেওয়ার পর এই format-এ summary দাও:
✅ Order Confirmed!
Table: [number]
Items: [list]
Total: ₹[amount] + GST
Cooking Time: [time]
Order ID: [CF-XXXX]`;

// ─── TELEGRAM HELPER ──────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

// ─── ROUTES ───────────────────────────────────────────────

// Health check — Railway alive কিনা দেখতে
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Café Fams Backend Running ☕',
    node: process.version,
    timestamp: new Date().toISOString()
  });
});

// Menu
app.get('/api/menu', (req, res) => {
  res.json({ success: true, menu: MENU, total: ALL_MENU_ITEMS.length });
});

// AI Chat
app.post('/api/chat', async (req, res) => {
  const { message, history = [], tableNumber = 1, sessionId } = req.body;

  if (!message) return res.status(400).json({ error: 'message required' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'OpenRouter API key missing in Railway variables' });

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.content })),
      { role: 'user', content: `Table ${tableNumber}: ${message}` }
    ];

    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://cafefams.netlify.app',
          'X-Title': 'Cafe Fams'
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 1024
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('OpenRouter error:', err);
      return res.status(500).json({ error: 'AI service error', detail: err });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'দুঃখিত, একটু পরে আবার চেষ্টা করুন।';

    // Order detect করলে Telegram notify
    if (reply.includes('Order Confirmed') || reply.includes('✅')) {
      const orderId = 'CF-' + Math.floor(1000 + Math.random() * 9000);
      orders[orderId] = { sessionId, tableNumber, message, time: new Date().toISOString(), status: 'confirmed' };

      await sendTelegram(
        `🆕 <b>নতুন Order!</b>\n` +
        `📋 Order ID: ${orderId}\n` +
        `🪑 Table: ${tableNumber}\n` +
        `💬 Customer: ${message}\n` +
        `⏰ Time: ${new Date().toLocaleTimeString('bn-BD')}`
      );

      return res.json({ success: true, reply: reply.replace('CF-XXXX', orderId), orderId });
    }

    res.json({ success: true, reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// Cancel Order
app.post('/api/cancel', async (req, res) => {
  const { orderId, tableNumber } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  if (orders[orderId]) {
    const orderTime = new Date(orders[orderId].time);
    const diffMinutes = (Date.now() - orderTime) / 60000;

    if (diffMinutes > 5) {
      return res.json({ success: false, message: '5 মিনিটের বেশি হয়ে গেছে, cancel করা যাবে না। Staff-কে ডাকুন।' });
    }

    orders[orderId].status = 'cancelled';
    await sendTelegram(`❌ <b>Order Cancelled!</b>\n📋 Order ID: ${orderId}\n🪑 Table: ${tableNumber}`);
    res.json({ success: true, message: `Order ${orderId} cancel হয়েছে।` });
  } else {
    res.json({ success: false, message: 'Order ID পাওয়া যায়নি।' });
  }
});

// Bill Generate
app.post('/api/bill', async (req, res) => {
  const { items, tableNumber } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items required' });

  const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const gst = Math.round(subtotal * 0.05);
  const total = subtotal + gst;

  res.json({
    success: true,
    bill: {
      tableNumber,
      items,
      subtotal,
      gst,
      gstPercent: 5,
      total,
      billId: 'BILL-' + Date.now(),
      timestamp: new Date().toISOString()
    }
  });
});

// Razorpay — Create Order
app.post('/api/payment/create', async (req, res) => {
  const { amount, tableNumber, orderId } = req.body;

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Razorpay keys missing in Railway variables' });
  }

  try {
    const razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    });

    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: 'INR',
      receipt: `cafefam_${tableNumber}_${Date.now()}`,
      notes: { tableNumber, orderId }
    });

    res.json({ success: true, order, key: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay error:', err);
    res.status(500).json({ error: 'Payment creation failed', detail: err.message });
  }
});

// Razorpay — Payment Verify
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

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`☕ Café Fams Backend running on port ${PORT}`);
  console.log(`✅ OPENROUTER_API_KEY: ${OPENROUTER_API_KEY ? 'SET' : '❌ MISSING'}`);
  console.log(`🤖 Model: ${OPENROUTER_MODEL}`);
  console.log(`✅ TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN ? 'SET' : '❌ MISSING'}`);
  console.log(`✅ RAZORPAY: ${RAZORPAY_KEY_ID ? 'SET' : '❌ MISSING'}`);
});
