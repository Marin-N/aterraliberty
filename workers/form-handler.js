/**
 * A Terra Liberty — Cloudflare Worker: Form Handler
 * ──────────────────────────────────────────────────
 * Routes:
 *   POST /subscribe  → saves email to KV, sends Telegram notification
 *   POST /contact    → saves message to KV, sends Telegram notification
 *   OPTIONS *        → CORS preflight
 *
 * KV Namespace binding: ATL_DATA
 * Secrets (set via: wrangler secret put NAME):
 *   TELEGRAM_BOT_TOKEN
 * Vars (set in wrangler.toml):
 *   TELEGRAM_CHAT_ID
 */

const ALLOWED_ORIGIN = 'https://aterraliberty.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // GET /subscribers/count — used by aterraliberty_bot.py
    if (request.method === 'GET' && url.pathname === '/subscribers/count') {
      const raw   = await env.ATL_DATA.get('stats:subscriber_count') || '0';
      const count = parseInt(raw, 10) || 0;
      return jsonResponse({ ok: true, count });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    try {
      if (url.pathname === '/subscribe') {
        return await handleSubscribe(body, env);
      }
      if (url.pathname === '/contact') {
        return await handleContact(body, env);
      }
      return jsonResponse({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      // Never expose raw errors to visitors
      console.error('Form handler error:', err.message);
      return jsonResponse({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
    }
  },
};

// ─── Subscribe Handler ────────────────────────────────────────────────────────

async function handleSubscribe(body, env) {
  const email = (body.email || '').toLowerCase().trim();
  const name  = (body.name  || '').trim();

  if (!email || !email.includes('@') || !email.includes('.')) {
    return jsonResponse({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  const kvKey = `subscriber:${email}`;
  const existing = await env.ATL_DATA.get(kvKey);

  if (!existing) {
    // New subscriber — save to KV
    await env.ATL_DATA.put(kvKey, JSON.stringify({
      email,
      name,
      subscribed_at: new Date().toISOString(),
      source: body.source || 'website',
    }));

    // Increment total subscriber counter
    const countRaw = await env.ATL_DATA.get('stats:subscriber_count') || '0';
    const newCount = parseInt(countRaw, 10) + 1;
    await env.ATL_DATA.put('stats:subscriber_count', String(newCount));

    // Telegram notification
    const msg = name
      ? `📧 New subscriber: ${name} (${email})\nTotal: ${newCount}`
      : `📧 New subscriber: ${email}\nTotal: ${newCount}`;
    await sendTelegram(env, msg);
  }
  // If already subscribed, silently succeed (no double-count)

  return jsonResponse({ ok: true });
}

// ─── Contact Handler ──────────────────────────────────────────────────────────

async function handleContact(body, env) {
  const firstName = (body.first_name || body.name || '').trim();
  const lastName  = (body.last_name  || '').trim();
  const email     = (body.email      || '').toLowerCase().trim();
  const subject   = (body.subject    || 'no subject').trim();
  const message   = (body.message    || '').trim();

  if (!email || !message) {
    return jsonResponse({ ok: false, error: 'Email and message are required.' }, 400);
  }

  const name = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
  const key  = `contact:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  await env.ATL_DATA.put(key, JSON.stringify({
    name,
    email,
    subject,
    message,
    received_at: new Date().toISOString(),
  }));

  // Telegram notification
  const preview = message.length > 80 ? message.slice(0, 80) + '…' : message;
  await sendTelegram(env,
    `💬 New message from ${name}\n` +
    `📧 ${email}\n` +
    `📌 Subject: ${subject}\n` +
    `───────────────\n${preview}`
  );

  return jsonResponse({ ok: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendTelegram(env, text) {
  try {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
        }),
      }
    );
  } catch (err) {
    // Telegram failure is non-fatal — form submission still succeeds
    console.error('Telegram notification failed:', err.message);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    },
  });
}
