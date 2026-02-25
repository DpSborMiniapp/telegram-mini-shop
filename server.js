require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Подключение к PostgreSQL (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Логирование запросов
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ==================== API ====================

// Получить все товары
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получить корзину пользователя
app.get('/api/cart/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query(`
      SELECT c.product_id, c.quantity, c.price_at_time, p.name, p.price, p.description, p.image
      FROM carts c
      JOIN products p ON c.product_id = p.id
      WHERE c.user_id = $1
    `, [userId]);

    const items = result.rows.map(row => ({
      productId: row.product_id,
      quantity: row.quantity,
      priceAtTime: row.price_at_time,
      name: row.name,
      price: row.price,
      description: row.description,
      image: row.image
    }));

    res.json({ userId, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Добавить товар в корзину (или увеличить количество)
app.post('/api/cart/add', async (req, res) => {
  const { userId, productId, quantity } = req.body;
  const numUserId = parseInt(userId, 10);
  const numProductId = parseInt(productId, 10);
  const numQuantity = parseInt(quantity, 10);

  try {
    const product = await pool.query('SELECT price FROM products WHERE id = $1', [numProductId]);
    if (product.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const price = product.rows[0].price;

    await pool.query(`
      INSERT INTO carts (user_id, product_id, quantity, price_at_time)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, product_id)
      DO UPDATE SET quantity = carts.quantity + EXCLUDED.quantity
    `, [numUserId, numProductId, numQuantity, price]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Обновить количество товара в корзине (задать конкретное значение)
app.post('/api/cart/update', async (req, res) => {
  const { userId, productId, quantity } = req.body;
  const numUserId = parseInt(userId, 10);
  const numProductId = parseInt(productId, 10);
  const numQuantity = parseInt(quantity, 10);

  if (numQuantity < 0) return res.status(400).json({ error: 'Quantity must be non-negative' });

  try {
    if (numQuantity === 0) {
      await pool.query('DELETE FROM carts WHERE user_id = $1 AND product_id = $2', [numUserId, numProductId]);
    } else {
      await pool.query(`
        UPDATE carts SET quantity = $1
        WHERE user_id = $2 AND product_id = $3
      `, [numQuantity, numUserId, numProductId]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Удалить товар из корзины
app.delete('/api/cart/remove', async (req, res) => {
  const { userId, productId } = req.body;
  try {
    await pool.query('DELETE FROM carts WHERE user_id = $1 AND product_id = $2', [userId, productId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Получить заказы пользователя
app.get('/api/orders/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Обновить статус заказа (например, отмена)
app.put('/api/order/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const { status } = req.body;

  const allowed = ['Активный', 'Завершен', 'Отменен'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const order = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (order.rows[0].status !== 'Активный' && status !== order.rows[0].status) {
      return res.status(400).json({ error: 'Cannot change non-active order' });
    }

    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// --- НОВЫЙ МАРШРУТ: Получить все точки самовывоза ---
app.get('/api/pickup-locations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM pickup_locations ORDER BY district, sort_order'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Функция отправки уведомления в Telegram
async function sendTelegramNotification(order) {
  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHANNEL_ID;
  if (!botToken || !chatId) {
    console.error('Telegram credentials missing');
    return;
  }

  let message = `<b>🆕 Новый заказ #${order.id}</b>\n\n`;
  message += `<b>👤 Клиент:</b> ${order.contact.name}\n`;
  message += `<b>📞 Телефон:</b> ${order.contact.phone}\n`;
  message += `<b>📍 Адрес:</b> ${order.contact.address}\n`;
  message += `<b>💰 Сумма:</b> ${order.total} руб.\n`;

  let deliveryText = '';
  if (order.contact.deliveryType === 'pickup') deliveryText = 'Самовывоз';
  else if (order.contact.deliveryType === 'free') deliveryText = 'Бесплатная доставка от 15 000 руб';
  else if (order.contact.deliveryType === 'courier') deliveryText = 'Доставка курьером';
  message += `<b>🚚 Доставка:</b> ${deliveryText}\n`;

  let paymentText = order.contact.paymentMethod === 'cash' ? 'Наличные' : 'Перевод по номеру';
  message += `<b>💳 Оплата:</b> ${paymentText}\n\n`;

  message += `<b>📦 Товары:</b>\n`;
  order.items.forEach(item => {
    message += `   • ${item.name} x${item.quantity} = ${item.price * item.quantity} руб.\n`;
  });

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
  } catch (err) {
    console.error('Telegram send error:', err);
  }
}

// Оформить заказ
app.post('/api/order', async (req, res) => {
  const { userId, contact } = req.body;
  const numUserId = parseInt(userId, 10);

  try {
    const cartResult = await pool.query(`
      SELECT c.product_id, c.quantity, c.price_at_time, p.name
      FROM carts c
      JOIN products p ON c.product_id = p.id
      WHERE c.user_id = $1
    `, [numUserId]);

    if (cartResult.rows.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    let total = 0;
    const orderItems = cartResult.rows.map(row => {
      const itemTotal = row.price_at_time * row.quantity;
      total += itemTotal;
      return {
        productId: row.product_id,
        name: row.name,
        quantity: row.quantity,
        price: row.price_at_time,
      };
    });

    const insertResult = await pool.query(`
      INSERT INTO orders (user_id, items, total, contact, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [numUserId, JSON.stringify(orderItems), total, JSON.stringify(contact), 'Активный']);

    const orderId = insertResult.rows[0].id;

    await pool.query('DELETE FROM carts WHERE user_id = $1', [numUserId]);

    // Отправляем уведомление (не ждём)
    sendTelegramNotification({
      id: orderId,
      user_id: numUserId,
      items: orderItems,
      total,
      contact,
      status: 'Активный'
    }).catch(e => console.error(e));

    res.json({ orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==================== Запуск сервера ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
