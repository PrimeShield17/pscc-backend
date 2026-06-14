 // ═══════════════════════════════════════════════════════════════
// PrimeShield PSCC — Backend Server
// Express + Stripe + Nodemailer
//
// Handles:
//  1. POST /book-pay-later    → booking emails (client + PSCC)
//  2. POST /create-checkout-session → Stripe pay-now session
//  3. POST /webhook           → fires after Stripe payment:
//       a. Records payment in payments.json
//       b. Sends booking emails (client + PSCC)
//       c. Sends payment confirmation emails (client + PSCC)
// ═══════════════════════════════════════════════════════════════

const express    = require("express");
const stripe     = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cors       = require("cors");
const nodemailer = require("nodemailer");
const fs         = require("fs");
const path       = require("path");

const app = express();

// Webhook must receive raw body — register BEFORE express.json()
app.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);

app.use(cors());
app.use(express.json());

// ── Payment log file ─────────────────────────────────────────
const PAYMENTS_FILE = path.join(__dirname, "payments.json");
function loadPayments() {
  try { return JSON.parse(fs.readFileSync(PAYMENTS_FILE, "utf8")); }
  catch { return []; }
}
function savePayment(record) {
  const payments = loadPayments();
  payments.unshift(record); // newest first
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
  console.log(`💾 Payment recorded: ${record.id}`);
}

// ── Zoho transporter ────────────────────────────────────────
// Env vars needed: ZOHO_USER, ZOHO_PASSWORD
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com.au",
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_PASSWORD,
  },
});

// ── Email helpers ────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return "To be confirmed";
  return new Date(d).toLocaleDateString("en-AU", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}
function fmtMoney(cents) {
  return `$${(cents / 100).toFixed(2)} AUD`;
}

// Shared header/footer HTML for emails
function emailWrap(headerBg, headerContent, bodyContent) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:30px 0;">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1);">
  <!-- NAV HEADER -->
  <tr><td style="background:#0b1f3a;padding:26px 36px;text-align:center;">
    <div style="font-size:26px;margin-bottom:6px;">🛡️</div>
    <div style="font-family:Georgia,serif;font-size:20px;font-weight:bold;color:#fff;">PrimeShield PSCC</div>
    <div style="font-size:11px;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:1px;margin-top:3px;">Commercial Cleaning · Gold Coast</div>
  </td></tr>
  <!-- COLOUR BAND -->
  <tr><td style="background:${headerBg};padding:20px 36px;text-align:center;">
    ${headerContent}
  </td></tr>
  <!-- BODY -->
  <tr><td style="padding:30px 36px;">${bodyContent}</td></tr>
  <!-- FOOTER -->
  <tr><td style="background:#f9f7f3;padding:16px 36px;text-align:center;border-top:1px solid #e8e2d8;">
    <div style="font-size:11px;color:#9aa3b0;line-height:1.7;">
      © 2026 PrimeShield Commercial Cleaning (PSCC) · Gold Coast, QLD<br>
      Fully Insured · Police Checked · No Lock-In Contracts<br>
      📞 0414 928 997 · 📧 info@pshield.com.au
    </div>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

function detailTable(rows) {
  return `<table width="100%" cellpadding="7" cellspacing="0"
    style="background:#f9f7f3;border-radius:8px;border:1px solid #e8e2d8;margin-bottom:20px;">
    ${rows.map(([label, value, big]) => `<tr>
      <td style="font-size:13px;color:#9aa3b0;width:38%;">${label}</td>
      <td style="font-size:${big ? "17px" : "13px"};color:#1c1c2e;font-weight:${big ? "bold" : "600"};">${value}</td>
    </tr>`).join("")}
  </table>`;
}

function contactBox() {
  return `<table width="100%" cellpadding="0" cellspacing="0"
    style="background:#0b1f3a;border-radius:10px;margin-top:20px;">
    <tr><td style="padding:18px 22px;">
      <div style="font-size:11px;font-weight:bold;color:#c8983a;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">📞 Contact Us</div>
      <div style="font-size:13px;color:rgba(255,255,255,.7);line-height:2.1;">
        📞 0414 928 997<br>📧 info@pshield.com.au<br>
        📍 All Gold Coast Suburbs, QLD<br>🕐 Mon–Sun · 5am – 10pm
      </div>
    </td></tr>
  </table>`;
}

// ════════════════════════════════════════════════════════════
//  EMAIL TYPE 1 — BOOKING CONFIRMATION (Pay Later)
//  Sent immediately when client chooses Pay Later
// ════════════════════════════════════════════════════════════
async function sendBookingEmails({ clientName, clientEmail, clientPhone, businessName, packageName, date, total, paymentMethod }) {
  const payLabel = paymentMethod === "now"
    ? "✅ Paid Online — Stripe"
    : "📋 Pay Later — Invoice after service (due 7 days)";

  // ── CLIENT: Booking Confirmation ──
  const clientBody = `
    <p style="font-size:15px;color:#1c1c2e;margin:0 0 8px;">Hi <strong>${clientName}</strong>,</p>
    <p style="font-size:14px;color:#5a6475;line-height:1.75;margin:0 0 22px;">
      Thank you for booking with <strong>PrimeShield PSCC</strong>. Your booking is confirmed and
      we will contact you within <strong>2 hours</strong> to confirm access details and exact timing.
    </p>
    <div style="font-size:11px;font-weight:bold;color:#c8983a;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">📋 Your Booking Details</div>
    ${detailTable([
      ["Business",      businessName],
      ["Package",       packageName],
      ["Preferred Date",fmtDate(date)],
      ["Amount",        total, true],
      ["Payment",       payLabel],
    ])}
    ${paymentMethod === "later" ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;margin-bottom:18px;">
      <tr><td style="padding:13px 17px;font-size:13px;color:#92400e;line-height:1.65;">
        💳 <strong>Pay Later reminder:</strong> A tax invoice will be emailed to you after the service is completed. Payment is due within 7 days via bank transfer or card.
      </td></tr>
    </table>` : ""}
    <p style="font-size:13px;color:#5a6475;line-height:1.7;">
      Need to reschedule? Please contact us at least <strong>24 hours before</strong> your booking date.
    </p>
    ${contactBox()}`;

  await transporter.sendMail({
    from:    `"PrimeShield PSCC" <${process.env.ZOHO_USER}>`,
    to:      clientEmail,
    subject: `✅ Booking Confirmed — PrimeShield PSCC`,
    html:    emailWrap("#c8983a",
      `<div style="font-size:30px;margin-bottom:6px;">✅</div>
       <div style="font-family:Georgia,serif;font-size:19px;font-weight:bold;color:#0b1f3a;">Booking Confirmed!</div>
       <div style="font-size:13px;color:#0b1f3a;opacity:.8;margin-top:3px;">Your clean is locked in — we'll be in touch shortly.</div>`,
      clientBody),
  });

  // ── PSCC: New Booking Alert ──
  const psccBody = `
    <div style="font-size:11px;font-weight:bold;color:#c8983a;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">👤 Client Details</div>
    ${detailTable([
      ["Name",    clientName],
      ["Business",businessName],
      ["Email",   `<a href="mailto:${clientEmail}" style="color:#c8983a;">${clientEmail}</a>`],
      ["Phone",   `<a href="tel:${clientPhone}" style="color:#c8983a;">${clientPhone}</a>`],
    ])}
    <div style="font-size:11px;font-weight:bold;color:#c8983a;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">📋 Booking Details</div>
    ${detailTable([
      ["Package",       packageName],
      ["Preferred Date",fmtDate(date)],
      ["Amount",        total, true],
      ["Payment",       payLabel],
    ])}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
      <tr><td style="padding:13px 17px;font-size:13px;color:#14532d;line-height:1.7;">
        ✅ <strong>Action required:</strong> Contact <strong>${clientName}</strong> at
        <a href="tel:${clientPhone}" style="color:#16a34a;">${clientPhone}</a> or
        <a href="mailto:${clientEmail}" style="color:#16a34a;">${clientEmail}</a>
        within <strong>2 hours</strong> to confirm access details and arrival time.
      </td></tr>
    </table>`;

  await transporter.sendMail({
    from:    `"PSCC Bookings" <${process.env.ZOHO_USER}>`,
    to:      "info@pshield.com.au",
    replyTo: clientEmail,
    subject: `🆕 New Booking — ${clientName} · ${packageName}`,
    html:    emailWrap("#c8983a",
      `<div style="font-size:18px;font-weight:bold;color:#0b1f3a;">🆕 New Booking Received!</div>
       <div style="font-size:13px;color:#0b1f3a;opacity:.75;margin-top:4px;">Action required — confirm with client within 2 hours</div>`,
      psccBody),
  });

  console.log(`📧 Booking emails sent → client: ${clientEmail} | PSCC: info@pshield.com.au`);
}

// ════════════════════════════════════════════════════════════
//  EMAIL TYPE 2 — PAYMENT CONFIRMATION
//  Sent after Stripe payment is successfully completed
// ════════════════════════════════════════════════════════════
async function sendPaymentEmails({ clientName, clientEmail, clientPhone, businessName, packageName, date, amountPaid, stripeSessionId }) {

  // ── CLIENT: Payment Thank You ──
  const clientBody = `
    <p style="font-size:15px;color:#1c1c2e;margin:0 0 8px;">Hi <strong>${clientName}</strong>,</p>
    <p style="font-size:14px;color:#5a6475;line-height:1.75;margin:0 0 22px;">
      Your payment has been received and processed successfully. Thank you for choosing
      <strong>PrimeShield PSCC</strong> — we look forward to delivering an exceptional clean!
    </p>
    <div style="font-size:11px;font-weight:bold;color:#c8983a;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">💳 Payment Receipt</div>
    ${detailTable([
      ["Business",       businessName],
      ["Package",        packageName],
      ["Preferred Date", fmtDate(date)],
      ["Amount Paid",    amountPaid, true],
      ["Status",         "✅ Payment Successful"],
      ["Reference",      stripeSessionId.slice(-12).toUpperCase()],
    ])}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;margin-bottom:18px;">
      <tr><td style="padding:13px 17px;font-size:13px;color:#14532d;line-height:1.65;">
        🎉 <strong>What's next?</strong> Our team will contact you within <strong>2 hours</strong>
        to confirm your exact arrival time and any access requirements. Please keep your phone handy!
      </td></tr>
    </table>
    <p style="font-size:12px;color:#9aa3b0;">
      Please keep this email as your receipt. If you need to reschedule, contact us at least 24 hours before your booking.
    </p>
    ${contactBox()}`;

  await transporter.sendMail({
    from:    `"PrimeShield PSCC" <${process.env.ZOHO_USER}>`,
    to:      clientEmail,
    subject: `💳 Payment Received — Thank You! PrimeShield PSCC`,
    html:    emailWrap("#16a34a",
      `<div style="font-size:30px;margin-bottom:6px;">💳✅</div>
       <div style="font-family:Georgia,serif;font-size:19px;font-weight:bold;color:#fff;">Payment Successful!</div>
       <div style="font-size:13px;color:rgba(255,255,255,.85);margin-top:3px;">Your booking is fully confirmed and paid.</div>`,
      clientBody),
  });

  // ── PSCC: Payment Notification ──
  const psccBody = `
    <div style="font-size:11px;font-weight:bold;color:#c8983a;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">👤 Client Details</div>
    ${detailTable([
      ["Name",    clientName],
      ["Business",businessName],
      ["Email",   `<a href="mailto:${clientEmail}" style="color:#c8983a;">${clientEmail}</a>`],
      ["Phone",   `<a href="tel:${clientPhone}" style="color:#c8983a;">${clientPhone}</a>`],
    ])}
    <div style="font-size:11px;font-weight:bold;color:#c8983a;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">💳 Payment Details</div>
    ${detailTable([
      ["Package",        packageName],
      ["Preferred Date", fmtDate(date)],
      ["Amount Paid",    amountPaid, true],
      ["Status",         "✅ Stripe Payment Confirmed"],
      ["Stripe Ref",     stripeSessionId.slice(-12).toUpperCase()],
      ["Full Session ID",stripeSessionId],
    ])}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
      <tr><td style="padding:13px 17px;font-size:13px;color:#14532d;line-height:1.7;">
        💰 Payment recorded. Contact <strong>${clientName}</strong> at
        <a href="tel:${clientPhone}" style="color:#16a34a;">${clientPhone}</a>
        within <strong>2 hours</strong> to confirm arrival time.
      </td></tr>
    </table>`;

  await transporter.sendMail({
    from:    `"PSCC Payments" <${process.env.ZOHO_USER}>`,
    to:      "info@pshield.com.au",
    replyTo: clientEmail,
    subject: `💰 Payment Received — ${clientName} · ${amountPaid}`,
    html:    emailWrap("#16a34a",
      `<div style="font-size:18px;font-weight:bold;color:#fff;">💰 Payment Received!</div>
       <div style="font-size:13px;color:rgba(255,255,255,.85);margin-top:4px;">${clientName} · ${amountPaid} · Stripe Confirmed</div>`,
      psccBody),
  });

  console.log(`💰 Payment emails sent → client: ${clientEmail} | PSCC: info@pshield.com.au`);
}

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

// Health check
app.get("/", (req, res) => {
  res.json({ status: "PSCC backend running ✅", time: new Date().toISOString() });
});

// View recorded payments — protected by secret header
app.get("/payments", (req, res) => {
  const secret = process.env.PAYMENTS_SECRET;
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json(loadPayments());
});

// ── Pay Later: instant booking emails ──
app.post("/book-pay-later", async (req, res) => {
  const { clientName, clientEmail, clientPhone, businessName, packageName, date, total } = req.body;
  if (!clientEmail || !clientName) return res.status(400).json({ error: "Missing required fields" });
  try {
    await sendBookingEmails({ clientName, clientEmail, clientPhone, businessName, packageName, date, total, paymentMethod: "later" });
    res.json({ success: true });
  } catch (err) {
    console.error("Booking email error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Create Stripe Checkout Session ──
app.post("/create-checkout-session", async (req, res) => {
  const { items, customer_email, bookingDetails } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ error: "No items provided" });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: items.map(item => ({
        price_data: {
          currency: "aud",
          product_data: { name: item.name, description: "PrimeShield Commercial Cleaning · Gold Coast" },
          unit_amount: item.price,
        },
        quantity: item.quantity || 1,
      })),
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/index.html#booking`,
      billing_address_collection: "required",
      phone_number_collection: { enabled: true },
      customer_email: customer_email || undefined,
      metadata: {
        clientName:   (bookingDetails?.clientName   || "").substring(0, 500),
        clientPhone:  (bookingDetails?.clientPhone  || "").substring(0, 500),
        businessName: (bookingDetails?.businessName || "").substring(0, 500),
        packageName:  (bookingDetails?.packageName  || "").substring(0, 500),
        date:         (bookingDetails?.date         || "").substring(0, 500),
        total:        (bookingDetails?.total        || "").substring(0, 500),
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe Webhook ──
async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta    = session.metadata || {};
    const details = session.customer_details || {};

    const clientName   = meta.clientName   || details.name  || "Valued Client";
    const clientEmail  = details.email     || "";
    const clientPhone  = meta.clientPhone  || details.phone || "Not provided";
    const businessName = meta.businessName || "Not provided";
    const packageName  = meta.packageName  || "Commercial Cleaning Service";
    const date         = meta.date         || "";
    const amountPaid   = meta.total        || fmtMoney(session.amount_total);
    const sessionId    = session.id;
    const paymentIntent = session.payment_intent || "";

    savePayment({
      id:           paymentIntent || sessionId,
      sessionId,
      recordedAt:   new Date().toISOString(),
      clientName,
      clientEmail,
      clientPhone,
      businessName,
      packageName,
      date,
      amountPaid,
      amountCents:  session.amount_total,
      currency:     session.currency?.toUpperCase(),
      status:       "paid",
    });

    try {
      await sendBookingEmails({ clientName, clientEmail, clientPhone, businessName, packageName, date, total: amountPaid, paymentMethod: "now" });
    } catch (err) {
      console.error("Booking email error:", err.message);
    }

    try {
      await sendPaymentEmails({ clientName, clientEmail, clientPhone, businessName, packageName, date, amountPaid, stripeSessionId: sessionId });
    } catch (err) {
      console.error("Payment email error:", err.message);
    }
  }

  res.json({ received: true });
}

// ── Start ──
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`✅ PSCC Server on port ${PORT}`));
