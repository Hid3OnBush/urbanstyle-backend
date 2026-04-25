import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "./db.js";
import Stripe from "stripe";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.send("UrbanStyle backend funcionando");
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const [existing] = await db.query("SELECT id FROM users WHERE email = ?", [
      email,
    ]);

    if (existing.length > 0) {
      return res.status(400).json({ message: "Ese correo ya está registrado" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'customer')",
      [name, email, hashedPassword]
    );

    res.json({
      id: result.insertId,
      name,
      email,
      role: "customer",
    });
  } catch (error) {
    console.error("Error registro:", error);
    res.status(500).json({
      message: "Error al registrar usuario",
      error: error.message,
      code: error.code,
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (users.length === 0) {
      return res.status(400).json({ message: "Credenciales incorrectas" });
    }

    const user = users[0];

    let validPassword = false;

    if (user.role === "admin" && user.password === password) {
      validPassword = true;
    } else {
      validPassword = await bcrypt.compare(password, user.password);
    }

    if (!validPassword) {
      return res.status(400).json({ message: "Credenciales incorrectas" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
      },
      process.env.JWT_SECRET || "urbanstyle_secret",
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        address: user.address,
        city: user.city,
        phone: user.phone,
      },
    });
  } catch (error) {
    console.error("Error login:", error);
    res.status(500).json({
      message: "Error al iniciar sesión",
      error: error.message,
      code: error.code,
    });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const [products] = await db.query("SELECT * FROM products ORDER BY id DESC");
    res.json(products);
  } catch (error) {
    console.error("ERROR REAL /api/products:", error);
    res.status(500).json({
      message: "Error obteniendo productos",
      error: error.message,
      code: error.code,
    });
  }
});

app.post("/api/products", async (req, res) => {
  try {
    const { name, price, image, category, description } = req.body;

    const [result] = await db.query(
      "INSERT INTO products (name, price, image, category, description) VALUES (?, ?, ?, ?, ?)",
      [name, price, image, category, description]
    );

    res.json({ id: result.insertId, name, price, image, category, description });
  } catch (error) {
    console.error("Error crear producto:", error);
    res.status(500).json({
      message: "Error al crear producto",
      error: error.message,
      code: error.code,
    });
  }
});

app.put("/api/products/:id", async (req, res) => {
  try {
    const { name, price, image, category, description } = req.body;

    await db.query(
      "UPDATE products SET name=?, price=?, image=?, category=?, description=? WHERE id=?",
      [name, price, image, category, description, req.params.id]
    );

    res.json({ message: "Producto actualizado" });
  } catch (error) {
    console.error("Error actualizar producto:", error);
    res.status(500).json({
      message: "Error al actualizar producto",
      error: error.message,
      code: error.code,
    });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM products WHERE id=?", [req.params.id]);
    res.json({ message: "Producto eliminado" });
  } catch (error) {
    console.error("Error eliminar producto:", error);
    res.status(500).json({
      message: "Error al eliminar producto",
      error: error.message,
      code: error.code,
    });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const {
      userId,
      customerName,
      customerEmail,
      address,
      city,
      shippingAddress,
      shippingMethod,
      paymentMethod,
      trackingNumber,
      carrier,
      notes,
      estimatedDelivery,
      status,
      total,
      items,
    } = req.body;

    if (!customerName || !customerEmail || !address || !city || !total) {
      return res.status(400).json({
        message: "Faltan datos obligatorios del pedido",
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "El pedido debe tener al menos un producto",
      });
    }

    if (trackingNumber) {
      const [existingOrder] = await db.query(
        "SELECT id FROM orders WHERE tracking_number = ? LIMIT 1",
        [trackingNumber]
      );

      if (existingOrder.length > 0) {
        return res.json({
          message: "El pedido ya existe",
          orderId: existingOrder[0].id,
          duplicated: true,
        });
      }
    }

    const [result] = await db.query(
      `INSERT INTO orders
      (user_id, customer_name, customer_email, address, city, shipping_address, shipping_method, payment_method, tracking_number, carrier, notes, estimated_delivery, status, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId || null,
        customerName,
        customerEmail,
        address,
        city,
        shippingAddress || `${address}, ${city}`,
        shippingMethod,
        paymentMethod,
        trackingNumber || null,
        carrier || null,
        notes || null,
        estimatedDelivery || null,
        status || "Pendiente",
        total,
      ]
    );

    const orderId = result.insertId;

    for (const item of items) {
      await db.query(
        `INSERT INTO order_items 
        (order_id, product_id, name, price, image, quantity)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.id || null,
          item.name,
          item.price,
          item.image,
          item.quantity,
        ]
      );
    }

    res.json({
      message: "Pedido creado correctamente",
      orderId,
      duplicated: false,
    });
  } catch (error) {
    console.error("Error creando pedido:", error);
    res.status(500).json({
      message: "Error creando pedido",
      error: error.message,
      code: error.code,
    });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const [orders] = await db.query("SELECT * FROM orders ORDER BY id DESC");

    const ordersWithItems = await Promise.all(
      orders.map(async (order) => {
        const [items] = await db.query(
          "SELECT * FROM order_items WHERE order_id = ?",
          [order.id]
        );

        return {
          ...order,
          items,
        };
      })
    );

    res.json(ordersWithItems);
  } catch (error) {
    console.error("Error obteniendo pedidos:", error);
    res.status(500).json({
      message: "Error obteniendo pedidos",
      error: error.message,
      code: error.code,
    });
  }
});

app.get("/api/orders/user/:email", async (req, res) => {
  try {
    const [orders] = await db.query(
      "SELECT * FROM orders WHERE customer_email = ? ORDER BY id DESC",
      [req.params.email]
    );

    const ordersWithItems = await Promise.all(
      orders.map(async (order) => {
        const [items] = await db.query(
          "SELECT * FROM order_items WHERE order_id = ?",
          [order.id]
        );

        return {
          ...order,
          items,
        };
      })
    );

    res.json(ordersWithItems);
  } catch (error) {
    console.error("Error obteniendo pedidos del usuario:", error);
    res.status(500).json({
      message: "Error obteniendo pedidos del usuario",
      error: error.message,
      code: error.code,
    });
  }
});

app.put("/api/orders/:id", async (req, res) => {
  try {
    const { status, trackingNumber, carrier, notes, estimatedDelivery } =
      req.body;

    await db.query(
      `UPDATE orders
       SET status = ?, tracking_number = ?, carrier = ?, notes = ?, estimated_delivery = ?
       WHERE id = ?`,
      [
        status,
        trackingNumber || null,
        carrier || null,
        notes || null,
        estimatedDelivery || null,
        req.params.id,
      ]
    );

    res.json({ message: "Pedido actualizado correctamente" });
  } catch (error) {
    console.error("Error actualizando pedido:", error);
    res.status(500).json({
      message: "Error actualizando pedido",
      error: error.message,
      code: error.code,
    });
  }
});

app.post("/api/payments/stripe", async (req, res) => {
  try {
    const { items } = req.body;

    const frontendUrl =
      process.env.FRONTEND_URL || "http://localhost:5173";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: items.map((item) => ({
        price_data: {
          currency: "mxn",
          product_data: {
            name: item.name,
          },
          unit_amount: Math.round(Number(item.price) * 100),
        },
        quantity: Number(item.quantity),
      })),
      success_url: `${frontendUrl}/payment/success?payment_id={CHECKOUT_SESSION_ID}&status=approved&provider=stripe`,
      cancel_url: `${frontendUrl}/payment/failure?provider=stripe`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Error Stripe:", error);
    res.status(500).json({
      message: "Error creando pago con Stripe",
      error: error.message,
    });
  }
});

app.get("/api/payments/stripe/session/:id", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);

    res.json({
      status: session.payment_status,
    });
  } catch (error) {
    console.error("Error verificando Stripe:", error);
    res.status(500).json({
      message: "Error verificando Stripe",
      error: error.message,
    });
  }
});

const PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";

async function getPayPalAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error_description || "Error obteniendo token de PayPal");
  }

  return data.access_token;
}

app.post("/api/payments/paypal", async (req, res) => {
  try {
    const { total } = req.body;

    if (!total || Number(total) <= 0) {
      return res.status(400).json({
        message: "Total inválido para PayPal",
      });
    }

    const frontendUrl =
      process.env.FRONTEND_URL || "http://localhost:5173";

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: "MXN",
              value: Number(total).toFixed(2),
            },
          },
        ],
        application_context: {
          return_url: `${frontendUrl}/payment/success?provider=paypal`,
          cancel_url: `${frontendUrl}/payment/failure?provider=paypal`,
          user_action: "PAY_NOW",
        },
      }),
    });

    const order = await response.json();

    if (!response.ok) {
      console.error("Error PayPal:", order);
      return res.status(500).json({
        message: "Error creando orden de PayPal",
        details: order,
      });
    }

    const approvalLink = order.links?.find((link) => link.rel === "approve");

    if (!approvalLink) {
      return res.status(500).json({
        message: "No se encontró el link de aprobación de PayPal",
        details: order,
      });
    }

    res.json({
      id: order.id,
      url: approvalLink.href,
    });
  } catch (error) {
    console.error("Error PayPal:", error);
    res.status(500).json({
      message: "Error creando pago con PayPal",
      error: error.message,
    });
  }
});

app.post("/api/payments/paypal/capture", async (req, res) => {
  try {
    const { orderId } = req.body;

    const accessToken = await getPayPalAccessToken();

    const response = await fetch(
      `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        message: "Error capturando pago PayPal",
        details: data,
      });
    }

    res.json({
      status: data.status,
      id: data.id,
      raw: data,
    });
  } catch (error) {
    console.error("Error capturando PayPal:", error);
    res.status(500).json({
      message: "Error capturando PayPal",
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`UrbanStyle backend en http://localhost:${PORT}`);
});