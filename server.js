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

// Логирование всех запросов с телом
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.method === 'POST' || req.method === 'PUT') {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// ==================== API ====================

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products');
    res.json(result.rows);
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

// Обработчик отмены заказа
app.put('/api/order/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const { status } = req.body;

  console.log(`[CANCEL] Received PUT /api/order/${orderId} with status: ${status}`);

  const allowed = ['Активный', 'Завершен', 'Отменен'];
  if (!allowed.includes(status)) {
    console.log(`[CANCEL] Invalid status: ${status}`);
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    // Получаем текущий заказ
    const order = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (order.rows.length === 0) {
      console.log(`[CANCEL] Order ${orderId} not found`);
      return res.status(404).json({ error: 'Order not found' });
    }

    const currentStatus = order.rows[0].status;
    console.log(`[CANCEL] Current status: ${currentStatus}`);

    // Проверяем, можно ли изменить
    if (currentStatus !== 'Активный' && status !== currentStatus) {
      console.log(`[CANCEL] Cannot change non-active order ${orderId} from ${currentStatus} to ${status}`);
      return res.status(400).json({ error: 'Cannot change non-active order' });
    }

    // Обновляем статус и получаем количество затронутых строк
    const updateResult = await pool.query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING id', [status, orderId]);
    console.log(`[CANCEL] Updated rows: ${updateResult.rowCount}`);

    if (updateResult.rowCount === 1) {
      console.log(`[CANCEL] Order ${orderId} updated to ${status}`);
      res.json({ success: true });
    } else {
      console.error(`[CANCEL] Unexpected row count: ${updateResult.rowCount}`);
      res.status(500).json({ error: 'Update failed' });
    }
  } catch (err) {
    console.error(`[CANCEL] Error:`, err);
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

    console.log('Новый заказ:', { id: orderId, userId: numUserId, items: orderItems, total, contact });

    // Отправка заказа в бота
    if (process.env.BOT_URL) {
      const botOrderData = {
        userId: numUserId,
        name: contact.name,
        items: orderItems,
        total: total,
        address: contact.address,
        paymentMethod: contact.paymentMethod,
        deliveryType: contact.deliveryType,
        contact: contact
      };

      fetch(`${process.env.BOT_URL}/api/new-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botOrderData)
      })
      .then(response => response.json())
      .then(data => console.log('✅ Заказ отправлен в бота:', data))
      .catch(err => console.error('❌ Ошибка отправки в бота:', err));
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
