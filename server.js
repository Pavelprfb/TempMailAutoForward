import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import mongoose from 'mongoose';

// ================== MongoDB Connect ==================
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('[MONGO] Connected'));

// ================== Schema ==================
const mailSchema = new mongoose.Schema({
  address: String,
  password: String,
  token: String,
  seen: [String],
  createdAt: { type: Date, default: Date.now }
});
const Mail = mongoose.model('Mail', mailSchema);

// ======================================================
const MAILTM_BASE = process.env.MAILTM_BASE || 'https://api.mail.tm';
const FORWARD_TO = process.env.FORWARD_TO;
const POLL_INTERVAL_MS = 5000; 
const CREATE_INTERVAL_MS = 60000; // প্রতি ১ মিনিটে নতুন মেইল

// Gmail SMTP config
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// Local array রাখবো (memory তে)
let mailData = [];

// Load from Mongo instead of JSON
async function loadMails() {
  const mails = await Mail.find({});
  mailData = mails.map(m => m.toObject());
  console.log(`[LOADED] ${mailData.length} mails from MongoDB`);
  for (const m of mailData) pollInbox(m);
}

// Save single mail to Mongo
async function saveMail(record) {
  const mail = new Mail(record);
  await mail.save();
}

// Update seen messages in Mongo
async function updateSeen(address, seen) {
  await Mail.updateOne({ address }, { $set: { seen } });
}

// ================== Create new temp mail ==================
async function createTempMail() {
  try {
    const rnd = uuidv4().slice(0, 8);
    const password = uuidv4() + 'Aa1!';

    const { data: domains } = await axios.get(`${MAILTM_BASE}/domains`);
    const domain = domains['hydra:member'][0].domain;
    const address = `${rnd}@${domain}`;

    await axios.post(`${MAILTM_BASE}/accounts`, { address, password });
    const { data: tokenData } = await axios.post(`${MAILTM_BASE}/token`, { address, password });

    const record = {
      address,
      password,
      token: tokenData.token,
      seen: [],
      createdAt: new Date().toISOString(),
    };
    mailData.push(record);
    await saveMail(record);

    console.log(`[NEW MAIL] ${address}`);
    pollInbox(record);
  } catch (err) {
    console.error(`[CREATE ERROR] ${err.message}`);
  }
}

// ================== Poll inbox ==================
async function pollInbox(info) {
  try {
    const { data } = await axios.get(`${MAILTM_BASE}/messages`, {
      headers: { Authorization: `Bearer ${info.token}` }
    });

    const messages = data['hydra:member'] || [];
    for (const m of messages) {
      if (!info.seen.includes(m.id)) {
        const { data: full } = await axios.get(`${MAILTM_BASE}/messages/${m.id}`, {
          headers: { Authorization: `Bearer ${info.token}` }
        });
        await forwardMessage(full);
        info.seen.push(m.id);
        await updateSeen(info.address, info.seen);
      }
    }
  } catch (err) {
    console.error(`[ERROR] ${info.address}: ${err.message}`);
  } finally {
    setTimeout(() => pollInbox(info), POLL_INTERVAL_MS);
  }
}

// ================== Forward email ==================
async function forwardMessage(msg) {
  try {
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: FORWARD_TO,
      subject: `[TEMP] ${msg.subject || '(no subject)'}`,
      text: msg.text || '(no text)',
      html: Array.isArray(msg.html) ? msg.html.join('\n') : msg.html || '',
    };
    await transporter.sendMail(mailOptions);
    console.log(`[FORWARDED] ${msg.subject || '(no subject)'}`);
  } catch (err) {
    console.error(`[FORWARD ERROR] ${err.message}`);
  }
}

// ================== Express UI ==================
const app = express();
app.get('/', async (req, res) => {
  const mails = await Mail.find({});
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="shortcut icon" href="https://res.cloudinary.com/dkyrj65dl/image/upload/v1755963630/uploads/db5wgv55zlixi9luonge.png" type="image/x-icon" />
    <title>Temp Mails Auto Forward</title>
    <style>
      body { font-family: Arial; margin: 20px; background: #f9f9f9; }
      h1 { text-align: center; }
      .mail-list { max-width: 600px; margin: auto; background: #fff; padding: 15px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
      .mail-item { display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid #ddd; }
      .mail-item:last-child { border-bottom: none; }
      .mail-number { font-weight: bold; color: #555; }
      button { padding: 5px 10px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; }
      button:hover { background: #45a049; }
    </style>
  </head>
  <body>
    <h1>📧 Temp Mail List</h1>
    <div class="mail-list">
      ${mails.map((m, index) => `
        <div class="mail-item">
          <div class="mail-address">
            <span class="mail-number">${index + 1}.</span>
            <span>${m.address}</span>
          </div>
          <button onclick="copyToClipboard('${m.address}')">Copy</button>
        </div>
      `).join('')}
    </div>
    <script>
      function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
          alert('Copied: ' + text);
        });
      }
    </script>
  </body>
  </html>
  `;
  res.send(html);
});

// ================== Start ==================
(async () => {
  await loadMails();
  await createTempMail();
  setInterval(createTempMail, CREATE_INTERVAL_MS);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[SERVER] Running at http://localhost:${port}`));
})();