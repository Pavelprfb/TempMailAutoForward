import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';

const MAILTM_BASE = process.env.MAILTM_BASE || 'https://api.mail.tm';
const FORWARD_TO = process.env.FORWARD_TO;
const POLL_INTERVAL_MS = 5000; // inbox check every 5 sec
const CREATE_INTERVAL_MS = 10000; // create new mail every 10 sec

// Gmail SMTP config
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// Load or init mail.json
let mailData = [];
if (fs.existsSync('mail.json')) {
  mailData = JSON.parse(fs.readFileSync('mail.json', 'utf8') || '[]');
} else {
  fs.writeFileSync('mail.json', '[]');
}

// Create new temp mail
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
    fs.writeFileSync('mail.json', JSON.stringify(mailData, null, 2));

    console.log(`[NEW MAIL] ${address}`);
    pollInbox(record);
  } catch (err) {
    console.error(`[CREATE ERROR] ${err.message}`);
  }
}

// Poll inbox for new messages
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
        fs.writeFileSync('mail.json', JSON.stringify(mailData, null, 2));
      }
    }
  } catch (err) {
    console.error(`[ERROR] ${info.address}: ${err.message}`);
  } finally {
    setTimeout(() => pollInbox(info), POLL_INTERVAL_MS);
  }
}

// Forward email via Gmail
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
// Express app to view emails in HTML list with numbering & responsive design
const app = express();
app.get('/', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Temp Mails</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        margin: 20px;
        background: #f9f9f9;
      }
      h1 {
        color: #333;
        text-align: center;
      }
      .mail-list {
        max-width: 600px;
        margin: auto;
        background: #fff;
        padding: 15px;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      }
      .mail-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px;
        border-bottom: 1px solid #ddd;
      }
      .mail-item:last-child {
        border-bottom: none;
      }
      .mail-address {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 10px;
        word-break: break-all;
      }
      .mail-number {
        font-weight: bold;
        color: #555;
      }
      button {
        padding: 5px 10px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
      }
      button:hover {
        background: #45a049;
      }
      @media (max-width: 480px) {
        .mail-item {
          flex-direction: column;
          align-items: flex-start;
        }
        button {
          margin-top: 5px;
        }
      }
    </style>
  </head>
  <body>
    <h1>📧 Temp Mail List</h1>
    <div class="mail-list">
      ${mailData.map((m, index) => `
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


// Start script
(async () => {
  // Load old mails
  if (mailData.length > 0) {
    console.log(`[LOADED] ${mailData.length} old mails`);
    for (const m of mailData) pollInbox(m);
  }

  // Create a new mail immediately
  await createTempMail();

  // Create a new mail every 10 seconds
  setInterval(createTempMail, CREATE_INTERVAL_MS);

  // Start Express server
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[SERVER] Running at http://localhost:${port}`);
  });
})();