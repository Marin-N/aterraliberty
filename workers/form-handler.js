/**
 * A Terra Liberty — Cloudflare Worker: Form Handler
 * ──────────────────────────────────────────────────
 * Routes:
 *   POST /subscribe         → saves email to KV, sends email + Telegram
 *   POST /contact           → saves message to KV, sends email + Telegram
 *   POST /send-newsletter   → sends newsletter to subscribers (adminKey required)
 *   GET  /subscribers/count → returns total subscriber count
 *   GET  /subscribers/list  → returns all subscribers (x-admin-key required)
 *   OPTIONS *               → CORS preflight
 *
 * KV Namespace binding: ATL_DATA
 * Secrets (set via: wrangler secret put NAME):
 *   TELEGRAM_BOT_TOKEN
 *   RESEND_API_KEY
 * Vars (set in wrangler.toml):
 *   TELEGRAM_CHAT_ID
 */

const ALLOWED_ORIGIN = 'https://aterraliberty.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Max-Age': '86400',
};

// Admin GET routes also allow null origin (file:// local admin panel)
function adminCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = (origin === 'null' || origin === ALLOWED_ORIGIN)
    ? origin
    : ALLOWED_ORIGIN;
  return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': allowedOrigin };
}

const ADMIN_KEY = 'aterra2026';

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: adminCorsHeaders(request) });
    }

    const url = new URL(request.url);

    // GET /subscribers/count — used by aterraliberty_bot.py
    if (request.method === 'GET' && url.pathname === '/subscribers/count') {
      const raw   = await env.ATL_DATA.get('stats:subscriber_count') || '0';
      const count = parseInt(raw, 10) || 0;
      return new Response(JSON.stringify({ ok: true, count }), {
        status: 200,
        headers: { ...adminCorsHeaders(request), 'Content-Type': 'application/json' },
      });
    }

    // GET /subscribers/list — returns all subscribers (admin only)
    if (request.method === 'GET' && url.pathname === '/subscribers/list') {
      const adminKey = request.headers.get('x-admin-key');
      if (!adminKey || adminKey !== ADMIN_KEY) {
        return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
      }
      const raw   = await env.ATL_DATA.get('stats:subscriber_count') || '0';
      const count = parseInt(raw, 10) || 0;
      const index = await env.ATL_DATA.get('subscribers:index');
      const emails = index ? JSON.parse(index) : [];
      const subscribers = await Promise.all(
        emails.map(async (email) => {
          const data = await env.ATL_DATA.get(`subscriber:${email}`);
          if (!data) return null;
          const parsed = JSON.parse(data);
          return {
            email: parsed.email,
            source: parsed.source || 'website',
            date: (parsed.subscribed_at || '').slice(0, 10),
            interests: parsed.interests || [],
          };
        })
      );
      return new Response(JSON.stringify({ ok: true, count, subscribers: subscribers.filter(Boolean) }), {
        status: 200,
        headers: { ...adminCorsHeaders(request), 'Content-Type': 'application/json' },
      });
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
      if (url.pathname === '/send-newsletter') {
        return await handleSendNewsletter(body, env, request);
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
  console.log('SUBSCRIBE HIT:', body.email, new Date().toISOString());

  const email     = (body.email || '').toLowerCase().trim();
  const name      = (body.name  || body.firstName || '').trim();
  const interests = Array.isArray(body.interests) ? body.interests : [];

  if (!email || !email.includes('@') || !email.includes('.')) {
    return jsonResponse({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  const kvKey = `subscriber:${email}`;
  const existing = await env.ATL_DATA.get(kvKey);

  const now = new Date().toISOString();
  const source = body.source || 'website';
  let newCount;

  if (!existing) {
    // New subscriber — save to KV
    await env.ATL_DATA.put(kvKey, JSON.stringify({
      email,
      name,
      subscribed_at: now,
      source,
      interests,
    }));

    // Update subscriber index for /subscribers/list
    const indexRaw = await env.ATL_DATA.get('subscribers:index');
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    if (!index.includes(email)) index.push(email);
    await env.ATL_DATA.put('subscribers:index', JSON.stringify(index));

    // Increment total subscriber counter
    const countRaw = await env.ATL_DATA.get('stats:subscriber_count') || '0';
    newCount = parseInt(countRaw, 10) + 1;
    await env.ATL_DATA.put('stats:subscriber_count', String(newCount));
  } else {
    console.log('SUBSCRIBE: existing subscriber, re-sending notification:', email);
    const countRaw = await env.ATL_DATA.get('stats:subscriber_count') || '0';
    newCount = parseInt(countRaw, 10);
  }

  {

    // Email 1 — owner notification (with interests)
    const interestsDisplay = interests.length
      ? interests.map(function(i) {
          return { journal: 'Journal Posts', health: 'Health Notes', portugal: 'Portugal Life', shop: 'Shop Updates' }[i] || i;
        }).join(', ')
      : 'None selected';
    await sendEmail(env, {
      replyTo: null,
      subject: `🌿 New subscriber: ${email}`,
      html: `
        <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e8e0d5;border-radius:6px;overflow:hidden">
          <div style="background:#2c2416;padding:24px 32px">
            <h1 style="margin:0;color:#f5efe6;font-size:20px;letter-spacing:0.5px">A Terra Liberty</h1>
            <p style="margin:4px 0 0;color:#a89880;font-size:13px">New Subscriber</p>
          </div>
          <div style="padding:32px">
            <table style="width:100%;border-collapse:collapse;font-size:15px;color:#2c2416">
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;color:#6b5c47;width:140px">Email</td><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;font-weight:bold">${email}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;color:#6b5c47">Interests</td><td style="padding:10px 0;border-bottom:1px solid #f0ebe4">${interestsDisplay}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;color:#6b5c47">Source page</td><td style="padding:10px 0;border-bottom:1px solid #f0ebe4">${source}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;color:#6b5c47">Time (UTC)</td><td style="padding:10px 0;border-bottom:1px solid #f0ebe4">${now}</td></tr>
              <tr><td style="padding:10px 0;color:#6b5c47">Total subscribers</td><td style="padding:10px 0;font-weight:bold">${newCount}</td></tr>
            </table>
            <div style="margin-top:24px">
              <a href="https://atl-form-handler.coddinging.workers.dev/subscribers/list" style="display:inline-block;background:#2c2416;color:#f5efe6;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:14px">View all subscribers</a>
            </div>
          </div>
          <div style="background:#f9f6f2;padding:16px 32px;text-align:center;font-size:12px;color:#a89880;border-top:1px solid #e8e0d5">
            <a href="https://aterraliberty.com" style="color:#a89880;text-decoration:none">aterraliberty.com</a>
          </div>
        </div>
      `,
    });

    // Email 2 — personalised welcome to subscriber
    const interestLines = [];
    if (interests.includes('journal'))  interestLines.push('I\'ll make sure you never miss a new journal post.');
    if (interests.includes('health'))   interestLines.push('Health notes land in your inbox as soon as they\'re written.');
    if (interests.includes('portugal')) interestLines.push('Life updates from central Portugal coming your way.');
    if (interests.includes('shop'))     interestLines.push('You\'ll be first to know when new things arrive in the shop.');
    const interestsPara = interestLines.length
      ? `<p style="color:#4a3f35;font-size:15px;line-height:1.8;">${interestLines.join(' ')}</p>`
      : `<p style="color:#4a3f35;font-size:15px;line-height:1.8;">You'll receive letters whenever there's something worth sharing.</p>`;
    const greeting = name ? `<p style="color:#2c2416;font-size:17px;line-height:1.7;margin-top:0;">Thank you, ${name}.</p>` : `<p style="color:#2c2416;font-size:17px;line-height:1.7;margin-top:0;">Thank you for subscribing.</p>`;

    await sendEmail(env, {
      to: email,
      from: 'Elena at A Terra Liberty <hello@aterraliberty.com>',
      replyTo: 'hello@aterraliberty.com',
      subject: 'Welcome to Letters from Portugal 🌿',
      html: `<!DOCTYPE html>
<html>
<body style="font-family:Georgia,serif;background:#f5f0eb;margin:0;padding:40px 20px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:40px;">
    <h1 style="color:#2c2416;font-size:28px;margin-bottom:4px;">A Terra Liberty</h1>
    <p style="color:#8a7a6a;font-size:13px;letter-spacing:2px;text-transform:uppercase;margin-top:0;">Letters from Portugal</p>
    <hr style="border:none;border-top:1px solid #e8e0d5;margin:24px 0;">
    ${greeting}
    <p style="color:#4a3f35;font-size:15px;line-height:1.8;">I'm Elena — writing from Central Portugal about slow living, real food, and building a quieter life on purpose. No sponsors, no affiliate links. Just honest letters.</p>
    ${interestsPara}
    <p style="color:#4a3f35;font-size:15px;line-height:1.8;">In the meantime, feel free to explore:</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 24px;">
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0ebe4;"><a href="https://aterraliberty.com/journal.html" style="color:#2c2416;text-decoration:none;font-size:14px;">→ Journal &amp; Videos</a></td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0ebe4;"><a href="https://aterraliberty.com/healthnotes.html" style="color:#2c2416;text-decoration:none;font-size:14px;">→ Health Notes</a></td></tr>
      <tr><td style="padding:8px 0;"><a href="https://aterraliberty.com/about.html" style="color:#2c2416;text-decoration:none;font-size:14px;">→ About</a></td></tr>
    </table>
    <p style="color:#4a3f35;font-size:15px;line-height:1.8;margin-bottom:4px;">With warmth,</p>
    <p style="color:#2c2416;font-size:16px;font-style:italic;margin-top:4px;">Elena</p>
    <hr style="border:none;border-top:1px solid #e8e0d5;margin:32px 0 20px;">
    <p style="color:#a89880;font-size:12px;margin:0;">You're receiving this because you subscribed at <a href="https://aterraliberty.com" style="color:#a89880;">aterraliberty.com</a>. Reply to this email to unsubscribe.</p>
  </div>
</body>
</html>`,
    });

    // Telegram notification
    const msg = name
      ? `📧 New subscriber: ${name} (${email})\nTotal: ${newCount}`
      : `📧 New subscriber: ${email}\nTotal: ${newCount}`;
    await sendTelegram(env, msg);
  }

  return jsonResponse({ ok: true, new: !existing });
}

// ─── Contact Handler ──────────────────────────────────────────────────────────

async function handleContact(body, env) {
  const firstName = (body.firstName || body.first_name || body.name || '').trim();
  const lastName  = (body.lastName  || body.last_name  || '').trim();
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

  const now = new Date().toISOString();

  // Email 1 — notification to Elena
  await sendEmail(env, {
    replyTo: email,
    subject: `💬 New message from ${name}: ${subject}`,
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e8e0d5;border-radius:6px;overflow:hidden">
        <div style="background:#2c2416;padding:24px 32px">
          <h1 style="margin:0;color:#f5efe6;font-size:20px;letter-spacing:0.5px">A Terra Liberty</h1>
          <p style="margin:4px 0 0;color:#a89880;font-size:13px">New Contact Message</p>
        </div>
        <div style="padding:32px">
          <table style="width:100%;border-collapse:collapse;font-size:15px;color:#2c2416">
            <tr><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;color:#6b5c47;width:140px">Name</td><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;font-weight:bold">${name}</td></tr>
            <tr><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;color:#6b5c47">Email</td><td style="padding:10px 0;border-bottom:1px solid #f0ebe4">${email}</td></tr>
            <tr><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;color:#6b5c47">Subject</td><td style="padding:10px 0;border-bottom:1px solid #f0ebe4">${subject}</td></tr>
            <tr><td style="padding:10px 0;border-bottom:1px solid #f0ebe4;color:#6b5c47">Time (UTC)</td><td style="padding:10px 0;border-bottom:1px solid #f0ebe4">${now}</td></tr>
          </table>
          <div style="margin-top:24px;padding:20px;background:#f9f6f2;border-radius:4px;border-left:3px solid #2c2416">
            <p style="margin:0 0 8px;font-size:12px;color:#6b5c47;text-transform:uppercase;letter-spacing:0.5px">Message</p>
            <p style="margin:0;font-size:15px;color:#2c2416;line-height:1.6;white-space:pre-wrap">${message}</p>
          </div>
          <div style="margin-top:24px">
            <a href="mailto:${email}" style="display:inline-block;background:#2c2416;color:#f5efe6;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:14px">Reply to ${email}</a>
          </div>
        </div>
        <div style="background:#f9f6f2;padding:16px 32px;text-align:center;font-size:12px;color:#a89880;border-top:1px solid #e8e0d5">
          <a href="https://aterraliberty.com" style="color:#a89880;text-decoration:none">aterraliberty.com</a>
        </div>
      </div>
    `,
  });

  // Email 2 — confirmation to the sender
  const greeting = firstName || name.split(' ')[0] || 'there';
  await sendEmail(env, {
    to: email,
    from: 'Elena at A Terra Liberty <hello@aterraliberty.com>',
    replyTo: 'hello@aterraliberty.com',
    subject: 'I received your message 🌿',
    html: `<!DOCTYPE html>
<html>
<body style="font-family:Georgia,serif;background:#f5f0eb;margin:0;padding:40px 20px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:40px;">
    <h1 style="color:#2c2416;font-size:28px;margin-bottom:4px;">A Terra Liberty</h1>
    <p style="color:#8a7a6a;font-size:13px;letter-spacing:2px;text-transform:uppercase;margin-top:0;">Letters from Portugal</p>
    <hr style="border:none;border-top:1px solid #e8e0d5;margin:24px 0;">
    <p style="color:#2c2416;font-size:16px;line-height:1.8;">Olá ${greeting},</p>
    <p style="color:#2c2416;font-size:16px;line-height:1.8;">Thank you for reaching out. I have received your message about <strong>"${subject}"</strong> and will get back to you personally as soon as I can.</p>
    <p style="color:#2c2416;font-size:16px;line-height:1.8;">Life here moves slowly and intentionally — and so does my inbox. But I do read every message and I will reply.</p>
    <p style="color:#2c2416;font-size:16px;line-height:1.8;">Com carinho,<br><strong>Elena</strong></p>
    <hr style="border:none;border-top:1px solid #e8e0d5;margin:24px 0;">
    <p style="color:#8a7a6a;font-size:12px;text-align:center;">A Terra Liberty · <a href="https://aterraliberty.com" style="color:#8a7a6a;">aterraliberty.com</a></p>
  </div>
</body>
</html>`,
  });

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

// ─── Send Newsletter Handler ──────────────────────────────────────────────────

async function handleSendNewsletter(body, env, request) {
  // 1. Verify adminKey
  if (!body.adminKey || body.adminKey !== ADMIN_KEY) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  const subject     = (body.subject     || '').trim();
  const previewText = (body.previewText || '').trim();
  const rawBody     = (body.body        || '').trim();
  const interests   = Array.isArray(body.interests) && body.interests.length > 0
    ? body.interests
    : null;

  if (!subject || !rawBody) {
    return jsonResponse({ ok: false, error: 'subject and body are required.' }, 400);
  }

  // 1b. Test mode — send only to owner, skip all subscribers
  if (body.testMode === true) {
    const safeBody = sanitizeHtml(rawBody);
    const html = buildNewsletterHtml(safeBody, previewText, 'coddinging@gmail.com');
    await sendEmail(env, {
      to: 'coddinging@gmail.com',
      from: 'Elena at A Terra Liberty <hello@aterraliberty.com>',
      replyTo: 'hello@aterraliberty.com',
      subject: '[TEST] ' + subject,
      html,
    });
    return jsonResponse({ ok: true, sent: 1, failed: 0, test: true });
  }

  // 2. Rate limit — max 1 send per hour per IP (stored in KV with 1-hour TTL)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitKey = `ratelimit:newsletter:${ip}`;
  const lastSend = await env.ATL_DATA.get(rateLimitKey);
  if (lastSend) {
    return jsonResponse({ ok: false, error: 'Rate limit exceeded. Max 1 newsletter per hour.' }, 429);
  }

  // 3. Fetch subscriber index
  const indexRaw = await env.ATL_DATA.get('subscribers:index');
  const allEmails = indexRaw ? JSON.parse(indexRaw) : [];

  if (allEmails.length === 0) {
    return jsonResponse({ ok: false, error: 'No subscribers found.' }, 400);
  }

  // 4. Load full subscriber records
  const subscribers = (await Promise.all(
    allEmails.map(async (email) => {
      const data = await env.ATL_DATA.get(`subscriber:${email}`);
      if (!data) return null;
      return JSON.parse(data);
    })
  )).filter(Boolean);

  // 5. Filter by interests if provided
  let targets = subscribers;
  if (interests) {
    targets = subscribers.filter((sub) => {
      const subInterests = Array.isArray(sub.interests) ? sub.interests : [];
      return interests.some((i) => subInterests.includes(i));
    });
  }

  if (targets.length === 0) {
    return jsonResponse({ ok: false, error: 'No subscribers match the given interests filter.' }, 400);
  }

  // 6. Sanitize HTML body
  const safeBody = sanitizeHtml(rawBody);

  // 7. Send individual emails — never expose other subscribers' addresses
  let sent = 0;
  let failed = 0;
  const now = new Date().toISOString();

  for (const sub of targets) {
    const html = buildNewsletterHtml(safeBody, previewText, sub.email);
    try {
      await sendEmail(env, {
        to: sub.email,
        from: 'Elena at A Terra Liberty <hello@aterraliberty.com>',
        replyTo: 'hello@aterraliberty.com',
        subject,
        html,
      });
      sent++;
    } catch (err) {
      console.error('Newsletter send failed for', sub.email, ':', err.message);
      failed++;
    }
  }

  // 8. Log send attempt to KV
  const logKey = `newsletter:log:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await env.ATL_DATA.put(logKey, JSON.stringify({
    timestamp: now,
    subject,
    ip,
    interests: interests || 'all',
    sent,
    failed,
    total: targets.length,
  }));

  // 9. Set rate limit TTL — expires in 1 hour
  await env.ATL_DATA.put(rateLimitKey, now, { expirationTtl: 3600 });

  await sendTelegram(env,
    `📰 Newsletter sent\nSubject: ${subject}\nSent: ${sent} · Failed: ${failed}`
  );

  return jsonResponse({ ok: true, sent, failed });
}

// ─── Newsletter HTML Template ─────────────────────────────────────────────────

function buildNewsletterHtml(body, previewText, email) {
  const unsubLink =
    `mailto:hello@aterraliberty.com?subject=Unsubscribe&body=Please%20unsubscribe%20${encodeURIComponent(email)}`;

  const preview = previewText
    ? `<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${previewText}</span>`
    : '';

  return `<!DOCTYPE html>
<html>
<body style="font-family: Georgia, serif; background: #f5f0eb; margin: 0; padding: 40px 20px;">
  ${preview}
  <div style="max-width: 600px; margin: 0 auto; background: white; padding: 48px;">
    <h1 style="color: #2c2416; font-size: 24px; margin-bottom: 4px;">A Terra Liberty</h1>
    <p style="color: #8a7a6a; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; margin-top: 0;">Letters from Portugal</p>
    <hr style="border: none; border-top: 1px solid #e8e0d5; margin: 24px 0;">
    ${body}
    <hr style="border: none; border-top: 1px solid #e8e0d5; margin: 24px 0;">
    <p style="color: #8a7a6a; font-size: 12px; text-align: center;">
      You're receiving this because you subscribed at
      <a href="https://aterraliberty.com" style="color: #8a7a6a;">aterraliberty.com</a>.
      &nbsp;·&nbsp;
      <a href="${unsubLink}" style="color: #8a7a6a;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`;
}

// ─── HTML Sanitizer ───────────────────────────────────────────────────────────

function sanitizeHtml(html) {
  // Remove <script> blocks and content
  let safe = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Remove <iframe> blocks
  safe = safe.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  // Remove dangerous tags (self-closing or paired)
  safe = safe.replace(/<\s*(object|embed|form|input|button|meta|link|base)\b[^>]*\/?>/gi, '');
  // Strip inline event handlers (onclick, onerror, onload, …)
  safe = safe.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  // Neutralise javascript: URIs in href / src / action attributes
  safe = safe.replace(
    /(href|src|action)\s*=\s*["']?\s*javascript:[^"'\s>]*/gi,
    '$1="#"'
  );
  // Remove CSS expression() (IE exploit)
  safe = safe.replace(/expression\s*\([^)]*\)/gi, '');
  return safe;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendEmail(env, { to = 'coddinging@gmail.com', from = 'A Terra Liberty <hello@aterraliberty.com>', replyTo, subject, html }) {
  try {
    const payload = {
      from,
      to,
      subject,
      html,
    };
    if (replyTo) {
      payload.reply_to = replyTo;
    }
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const resendJson = await resendRes.json();
    console.error('RESEND STATUS:', resendRes.status);
    console.error('RESEND BODY:', JSON.stringify(resendJson));
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

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
