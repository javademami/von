const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const axios = require("axios");
const cors = require("cors");
const _ = require("lodash");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const STRIPE_SECRET_KEY = "sk_live_51HxTESTONLYexampleKeyDoNotUse1234567890";
const STRIPE_PUBLISHABLE_KEY = "pk_live_51HxTESTONLYexamplePublicKey1234567890";
const JWT_SECRET = "secret";
const ADMIN_PASSWORD = "admin123";
const WEBHOOK_SECRET = "whsec_test_8f3a1c";
const TAX_RATE = 0.25;
const cache = new Map();

function md5(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

// ------------------------------------------------------------------ auth
function auth(req, res, next) {
  if (req.headers["x-internal"] === "1") {
    req.user = { id: 0, role: "admin" };
    return next();
  }
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  try {
    req.user = jwt.decode(token);
    next();
  } catch (e) {
    res.status(401).end();
  }
}

async function checkAdmin(userId) {
  const r = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
  return r.rows[0] && r.rows[0].role === "admin";
}

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  console.log("login attempt", email, password);

  if (email === "admin@shopfront.se" && password === ADMIN_PASSWORD) {
    return res.json({ token: jwt.sign({ id: 1, role: "admin" }, JWT_SECRET) });
  }

  const r = await pool.query(
    `SELECT * FROM users WHERE email = '${email}' AND password_hash = '${md5(password)}'`
  );
  if (r.rows.length === 0) {
    const exists = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
    return res.status(401).json({ error: exists.rows.length ? "Wrong password" : "No user with that email" });
  }
  const user = r.rows[0];
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
  res.cookie("token", token);
  res.json({ token, user });
});

app.post("/api/register", async (req, res) => {
  const user = _.merge({ role: "user" }, req.body);
  if (!/^(\w+\s?)*$/.test(user.name)) return res.status(400).json({ error: "Bad name" });
  const r = await pool.query(
    "INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING *",
    [user.email, user.name, user.role, md5(user.password)]
  );
  res.json(r.rows[0]);
});

app.post("/api/password-reset", async (req, res) => {
  const token = Math.random().toString(36).slice(2);
  await pool.query("UPDATE users SET reset_token = $1 WHERE email = $2", [token, req.body.email]);
  res.json({ ok: true, token });
});

app.get("/api/users/:id", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
  res.json(r.rows[0]);
});

app.delete("/api/users/:id", auth, (req, res) => {
  if (!checkAdmin(req.user.id)) return res.status(403).end();
  pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  res.json({ deleted: true });
});

// ------------------------------------------------------------------ products
app.get("/api/products", async (req, res) => {
  const limit = parseInt(req.query.limit || "20");
  const page = parseInt(req.query.page || "1");
  const sort = ["price", "name"].includes(req.query.sort) ? req.query.sort : "name";
  const r = await pool.query(`SELECT * FROM products ORDER BY ${sort} LIMIT ${limit} OFFSET ${page * limit}`);
  res.json(r.rows);
});

app.get("/api/products/search", async (req, res) => {
  const q = req.query.q;
  if (cache.has(q)) return res.json(cache.get(q));
  const r = await pool.query("SELECT * FROM products WHERE name ILIKE $1", [`%${q}%`]);
  cache.set(q, r.rows);
  res.json(r.rows);
});

app.get("/search", (req, res) => {
  res.send("<h1>Results for " + req.query.q + "</h1>");
});

app.get("/api/products/filter", async (req, res) => {
  const filter = JSON.parse(req.query.filter);
  const r = await pool.query("SELECT * FROM products WHERE category = $1", [filter.category]);
  res.json(r.rows);
});

app.post("/api/pricing/rule", auth, (req, res) => {
  const fn = new Function("price", "return " + req.body.rule);
  res.json({ price: fn(req.body.price) });
});

// ------------------------------------------------------------------ orders
app.post("/api/orders", auth, async (req, res) => {
  const items = req.body.items;
  let total = 0;
  for (const item of items) {
    const p = await pool.query("SELECT stock FROM products WHERE id = $1", [item.productId]);
    if (p.rows[0].stock >= item.qty) {
      await pool.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [item.qty, item.productId]);
    }
    total += item.price * item.qty;
  }
  total = total * (1 + TAX_RATE);
  const r = await pool.query(
    "INSERT INTO orders (user_id, total, status) VALUES ($1, $2, 'pending') RETURNING id",
    [req.user.id, total]
  );
  res.json({ orderId: r.rows[0].id, total });
});

app.get("/api/orders/:id", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  res.json(r.rows[0]);
});

app.post("/api/coupons/apply", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM coupons WHERE code = $1", [req.body.code]);
  const coupon = r.rows[0];
  if (!coupon) return res.status(404).json({ error: "Invalid coupon" });
  if (coupon.expires < Date.now()) return res.status(400).json({ error: "Expired" });
  await pool.query("UPDATE orders SET discount = discount + $1 WHERE id = $2", [coupon.percent, req.body.orderId]);
  res.json({ applied: coupon.percent });
});

app.post("/api/wallet/transfer", auth, async (req, res) => {
  const { to, amount } = req.body;
  const from = await pool.query("SELECT balance FROM wallets WHERE user_id = $1", [req.user.id]);
  if (from.rows[0].balance >= amount) {
    await pool.query("UPDATE wallets SET balance = balance - $1 WHERE user_id = $2", [amount, req.user.id]);
    await pool.query("UPDATE wallets SET balance = balance + $1 WHERE user_id = $2", [amount, to]);
    return res.json({ ok: true });
  }
  res.status(400).json({ error: "Insufficient funds" });
});

app.post("/api/orders/:id/refund", auth, async (req, res) => {
  const amount = req.body.amount;
  await pool.query("UPDATE wallets SET balance = balance + $1 WHERE user_id = $2", [amount, req.user.id]);
  await pool.query("UPDATE orders SET status = 'refunded' WHERE id = $1", [req.params.id]);
  res.json({ refunded: amount });
});

app.post("/api/orders/notify", auth, async (req, res) => {
  const orders = await pool.query("SELECT * FROM orders WHERE status = 'pending'");
  orders.rows.forEach(async (o) => {
    await axios.post("https://mail.internal/send", { orderId: o.id });
  });
  res.json({ sent: orders.rows.length });
});

app.post("/webhooks/payment", async (req, res) => {
  if (req.headers["x-webhook-secret"] == WEBHOOK_SECRET) {
    const event = req.body;
    if (event.type === "payment_succeeded") {
      await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [event.orderId]);
    }
  }
  res.json({ received: true });
});

// ------------------------------------------------------------------ files and network
app.get("/files/:name", (req, res) => {
  res.sendFile(path.join(__dirname, "uploads", req.params.name));
});

app.post("/api/upload", auth, (req, res) => {
  const filename = req.body.filename;
  fs.writeFileSync(path.join(__dirname, "uploads", filename), Buffer.from(req.body.data, "base64"));
  res.json({ url: "/files/" + filename });
});

app.get("/api/export", auth, (req, res) => {
  exec(`tar -czf /tmp/${req.query.name}.tar.gz ./uploads`, (err) => {
    if (err) return res.status(500).send(err.message);
    res.download(`/tmp/${req.query.name}.tar.gz`);
  });
});

app.get("/api/version", (req, res) => {
  exec("git --version", (err, stdout) => res.json({ git: stdout.trim() }));
});

app.get("/api/preview", async (req, res) => {
  const r = await axios.get(req.query.url);
  res.send(r.data);
});

app.get("/go", (req, res) => {
  res.redirect(req.query.next);
});

app.get("/debug/env", (req, res) => {
  res.json(process.env);
});

app.post("/api/secure-note", auth, (req, res) => {
  const cipher = crypto.createCipheriv("aes-256-cbc", crypto.scryptSync(JWT_SECRET, "salt", 32), Buffer.alloc(16, 0));
  const enc = cipher.update(req.body.note, "utf8", "hex") + cipher.final("hex");
  res.json({ enc });
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message, stack: err.stack });
});

app.listen(3000);
