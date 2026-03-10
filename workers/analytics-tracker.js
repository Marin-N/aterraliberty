/**
 * A Terra Liberty — Cloudflare Worker: Analytics Tracker
 * ────────────────────────────────────────────────────────
 * Route: POST /track
 *
 * Accepts event payloads from the site's tracking snippet and
 * aggregates them into daily KV records.
 *
 * KV Namespace binding: ATL_ANALYTICS
 * KV key format: "stats:YYYY-MM-DD"
 *
 * Daily record structure:
 * {
 *   "visitors": 47,
 *   "pageViews": { "index": 23, "journal": 15, "about": 9 },
 *   "postClicks": { "why-we-left-portugal": 23 },
 *   "youtubeClicks": 8,
 *   "subscribeClicks": 5,
 *   "newSubscribers": 3,
 *   "contactSent": 1,
 *   "sources": { "google": 45, "youtube": 30, "direct": 25 },
 *   "countries": { "PT": 20, "GB": 15, "US": 12 },
 *   "devices": { "mobile": 28, "desktop": 19 },
 *   "totalSeconds": 18420
 * }
 */

export default {
  async fetch(request, env) {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // GET /stats?date=YYYY-MM-DD — used by aterraliberty_bot.py
    if (request.method === 'GET' && url.pathname === '/stats') {
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const day  = await env.ATL_ANALYTICS.get(`stats:${date}`, { type: 'json' }) || emptyDay();
      return new Response(JSON.stringify(day), {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('ok', { status: 200, headers: CORS }); // silent no-op
    }

    try {
      const body = await request.json();
      await processEvent(body, request, env);
    } catch {
      // Silent failure — analytics should never break the site
    }

    return new Response('ok', { status: 200, headers: CORS });
  },
};

async function processEvent(body, request, env) {
  const { event, page, source, device } = body;

  // Today's date as KV key
  const today   = new Date().toISOString().slice(0, 10); // "2026-03-10"
  const dayKey  = `stats:${today}`;
  const country = request.headers.get('CF-IPCountry') || 'unknown';

  // Load today's record (or create fresh one)
  const day = await env.ATL_ANALYTICS.get(dayKey, { type: 'json' }) || emptyDay();

  switch (event) {

    case 'pageview': {
      day.visitors += 1;
      day.pageViews[page || 'unknown'] = (day.pageViews[page || 'unknown'] || 0) + 1;
      day.sources[source || 'direct']  = (day.sources[source || 'direct']  || 0) + 1;
      day.countries[country]           = (day.countries[country]           || 0) + 1;
      if (device) day.devices[device]  = (day.devices[device]              || 0) + 1;
      break;
    }

    case 'click': {
      const type = body.type || '';
      if (type === 'youtube') {
        day.youtubeClicks += 1;
      } else if (type === 'post' && body.slug) {
        day.postClicks[body.slug] = (day.postClicks[body.slug] || 0) + 1;
      } else if (type === 'subscribe') {
        day.subscribeClicks += 1;
      } else if (type === 'subscribe_success') {
        day.newSubscribers += 1;
      } else if (type === 'contact_sent') {
        day.contactSent += 1;
      }
      break;
    }

    case 'time': {
      const s = parseInt(body.seconds, 10) || 0;
      // Cap at 30 minutes to ignore open tabs
      day.totalSeconds += Math.min(s, 1800);
      break;
    }

    // Unknown events are silently ignored
  }

  // Save with 90-day TTL
  await env.ATL_ANALYTICS.put(dayKey, JSON.stringify(day), {
    expirationTtl: 7_776_000,
  });
}

function emptyDay() {
  return {
    visitors: 0,
    pageViews: {},
    postClicks: {},
    youtubeClicks: 0,
    subscribeClicks: 0,
    newSubscribers: 0,
    contactSent: 0,
    sources: {},
    countries: {},
    devices: { mobile: 0, desktop: 0 },
    totalSeconds: 0,
  };
}
