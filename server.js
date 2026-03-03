require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BOT_URL = process.env.BOT_URL; // URL основного бота

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ==================== API ====================

// Получение товаров с вариантами (ИСПРАВЛЕНО)
app.get('/api/products', async (req, res) => {
  try {
    const products = await pool.query('SELECT * FROM products ORDER BY id');
    const variants = await pool.query('SELECT * FROM product_variants ORDER BY product_id, sort_order');
    
    const variantsByProduct = variants.rows.reduce((acc, v) => {
      if (!acc[v.product_id]) acc[v.product_id] = [];
      acc[v.product_id].push(v);
      return acc;
    }, {});

    const result = products.rows.map(p => ({
      ...p,
      variants: variantsByProduct[p.id] || []
    }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

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

app.put('/api/order/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const { status } = req.body;

  const allowed = ['Активный', 'Завершен', 'Отменен'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const order = await pool.query('SELECT status, seller_id, order_number FROM orders WHERE id = $1', [orderId]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (order.rows[0].status !== 'Активный' && status !== order.rows[0].status) {
      return res.status(400).json({ error: 'Cannot change non-active order' });
    }

    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
    
    // Если заказ отменён, уведомляем основного бота
    if (status === 'Отменен' && BOT_URL) {
      const orderData = order.rows[0];
      try {
        await fetch(`${BOT_URL}/api/order-cancelled`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: orderId,
            orderNumber: orderData.order_number,
            sellerId: orderData.seller_id
          })
        });
        console.log(`Уведомление об отмене заказа ${orderData.order_number} отправлено боту`);
      } catch (err) {
        console.error('Ошибка отправки уведомления боту:', err);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/pickup-locations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT district, address, sort_order FROM pickup_locations ORDER BY district, sort_order'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/order', async (req, res) => {
  const { userId, contact, requestId } = req.body;
  const numUserId = parseInt(userId, 10);
  const address = contact.address;
  const deliveryType = contact.deliveryType;

  if (!requestId) {
    return res.status(400).json({ error: 'Missing requestId' });
  }

  try {
    // Проверка на дубликат
    const existing = await pool.query('SELECT id FROM orders WHERE request_id = $1', [requestId]);
    if (existing.rows.length > 0) {
      console.log(`⚠️ Дублирующийся запрос с requestId ${requestId} отклонён`);
      return res.status(409).json({ error: 'Duplicate order' });
    }

    // Получаем seller_id и address_id, если это самовывоз
    let seller_id = null;
    let address_id = null;
    if (deliveryType === 'pickup') {
      const addrResult = await pool.query('SELECT id, seller_id FROM pickup_locations WHERE address = $1', [address]);
      if (addrResult.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid pickup address' });
      }
      address_id = addrResult.rows[0].id;
      seller_id = addrResult.rows[0].seller_id;
    }

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

    const itemsJson = JSON.stringify(orderItems);
    const contactJson = JSON.stringify(contact);

    // Вставляем заказ
    const insertResult = await pool.query(`
      INSERT INTO orders (user_id, seller_id, address_id, items, total, contact, status, request_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [numUserId, seller_id, address_id, itemsJson, total, contactJson, 'Активный', requestId]);

    const orderId = insertResult.rows[0].id;

    await pool.query('DELETE FROM carts WHERE user_id = $1', [numUserId]);

    console.log('Новый заказ:', { id: orderId, userId: numUserId, items: orderItems, total, contact, seller_id, address_id, requestId });

    // Отправка заказа в бота (синхронно)
    let orderNumberFromBot = null;
    if (process.env.BOT_URL) {
      const botOrderData = {
        userId: numUserId,
        name: contact.name,
        items: orderItems,
        total: total,
        address: address,
        paymentMethod: contact.paymentMethod,
        deliveryType: deliveryType,
        contact: contact,
        requestId: requestId
      };
      try {
        const botResponse = await fetch(`${process.env.BOT_URL}/api/new-order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(botOrderData)
        });
        const botData = await botResponse.json();
        if (botData.orderNumber) {
          orderNumberFromBot = botData.orderNumber;
          // Обновляем запись в базе, добавляя order_number
          await pool.query('UPDATE orders SET order_number = $1 WHERE id = $2', [orderNumberFromBot, orderId]);
        }
        console.log('✅ Заказ отправлен в бота, получен номер:', orderNumberFromBot);
      } catch (err) {
        console.error('❌ Ошибка отправки в бота:', err);
      }
    }

    res.json({ orderId });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
