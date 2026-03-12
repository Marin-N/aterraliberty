"""
A Terra Liberty — @aterraliberty_bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Elena's personal website analytics + business strategy bot.
Reads live data via Cloudflare Worker endpoints (no direct KV API needed).
Uses Groq for insights and newsletter drafting.

Run: python aterraliberty_bot.py
"""

import asyncio
import datetime
import json
import logging
import os
import re
import requests
import zoneinfo
from dotenv import load_dotenv
from groq import Groq

load_dotenv()
from telegram import Update
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    filters, ContextTypes,
)

# ── Credentials ───────────────────────────────────────────────────────────────
BOT_TOKEN     = os.environ.get("TELEGRAM_BOT_TOKEN")
CHAT_ID       = "569994286"
ELENA_CHAT_ID = int(os.environ.get("ELENA_CHAT_ID"))
GROQ_API_KEY  = os.environ.get("GROQ_API_KEY")
GROQ_MODEL    = "llama-3.3-70b-versatile"
ADMIN_KEY     = os.environ.get("ADMIN_KEY")

# ── Worker URLs (data is read via these, no direct CF API token needed) ────────
ANALYTICS_WORKER = os.environ.get("ANALYTICS_WORKER")
FORM_WORKER      = os.environ.get("FORM_WORKER")
JOURNAL_URL      = "https://raw.githubusercontent.com/Marin-N/aterraliberty/main/journal.html"

PORTUGAL_TZ = zoneinfo.ZoneInfo("Europe/Lisbon")

# ── Newsletter session state (in-memory only, never written to disk) ──────────
# Structure: { chat_id_str: { "step": int, "answers": list[str],
#               "draft": str, "subject": str, "awaiting_confirm": bool } }
_newsletter_sessions: dict = {}

# Fallback questions used only if Groq question generation fails
_FALLBACK_QUESTIONS = [
    "What's the main thing you want to share this month?",
    "Any specific moment or story from your life recently?",
    "What's one thing you learned or noticed about slow living?",
    "Any health or food insight worth sharing?",
    "What do you want readers to feel after reading?",
]

NEWSLETTER_SYSTEM_PROMPT = """\
You are Elena's writing assistant for A Terra Liberty,
a slow living blog from central Portugal.
Elena's voice is: warm, honest, thoughtful, never preachy.
She writes like a letter to a friend on a Sunday morning.
She talks about: daily life in Portugal, food, health,
nature, simplicity, intentional living.
She NEVER uses: buzzwords, marketing language,
fake enthusiasm, or AI-sounding phrases.
"""

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)

# ── Groq client ───────────────────────────────────────────────────────────────
groq = Groq(api_key=GROQ_API_KEY)

SYSTEM_PROMPT = """\
You are Elena's personal business strategist for A Terra Liberty, a slow living Portugal brand.

CONTEXT:
- Elena writes about slow living, food & health, Portugal life, and longevity
- Primary goal: grow newsletter subscriber list and YouTube channel
- Secondary goal: monetise sustainably without selling out

MONETISATION ROADMAP (always base advice on real current numbers):
  0–100 subs    → focus on content only, build trust
  100–500 subs  → launch paid newsletter tier at €5/month
  500–1,000 subs → sell first PDF guide at €15–25
  1,000+ subs   → run online workshops at €97–197
  YouTube: 1,000 subs + 4,000 watch hours → ad revenue unlocked

WHAT YOU KNOW ABOUT PERFORMANCE:
- Food & health posts convert subscribers 4× better than other categories
- Portugal life posts get the most shares
- Slow living posts have highest time-on-page

YOUR JOB:
- Read the numbers and tell Elena exactly what they mean for her business
- After every report, suggest ONE specific action for this week
- Always flag the current monetisation opportunity based on real subscriber count
- Be warm, direct, specific — not a brochure, not vague motivational fluff
- Give real suggestions with real numbers, real titles, real prices
- If data is missing or zero, say so honestly and explain what to do to fix it
"""


# ── Data helpers — reads via Worker GET endpoints ─────────────────────────────

def _today_str() -> str:
    return datetime.datetime.now(PORTUGAL_TZ).strftime("%Y-%m-%d")


def _day_str(offset: int) -> str:
    d = datetime.datetime.now(PORTUGAL_TZ) - datetime.timedelta(days=offset)
    return d.strftime("%Y-%m-%d")


def get_day_stats(date_str: str) -> dict:
    """GET /stats?date=YYYY-MM-DD from the analytics worker."""
    try:
        r = requests.get(
            f"{ANALYTICS_WORKER}/stats",
            params={"date": date_str},
            timeout=10,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("get_day_stats failed for %s: %s", date_str, e)
        return {}


def get_subscriber_count() -> int:
    """GET /subscribers/count from the form handler worker."""
    try:
        r = requests.get(f"{FORM_WORKER}/subscribers/count", timeout=10)
        r.raise_for_status()
        return int(r.json().get("count", 0))
    except Exception as e:
        log.warning("get_subscriber_count failed: %s", e)
        return 0


def get_week_stats() -> dict:
    """Aggregate last 7 days into one dict.
    KV field names (from analytics-tracker.js):
      visitors, pageViews, postClicks, youtubeClicks,
      newSubscribers, contactSent, sources, countries, devices
    """
    totals = {
        "visitors": 0, "new_subscribers": 0,
        "youtube_clicks": 0, "contact_sent": 0,
        "post_clicks": {}, "countries": {},
        "devices": {"mobile": 0, "desktop": 0},
    }
    for i in range(7):
        d = get_day_stats(_day_str(i))
        if not d:
            continue
        totals["visitors"]        += d.get("visitors", 0)
        totals["new_subscribers"] += d.get("newSubscribers", 0)
        totals["youtube_clicks"]  += d.get("youtubeClicks", 0)
        totals["contact_sent"]    += d.get("contactSent", 0)
        for slug, count in d.get("postClicks", {}).items():
            totals["post_clicks"][slug] = totals["post_clicks"].get(slug, 0) + count
        for country, count in d.get("countries", {}).items():
            totals["countries"][country] = totals["countries"].get(country, 0) + count
        devices = d.get("devices", {})
        totals["devices"]["mobile"]  += devices.get("mobile", 0)
        totals["devices"]["desktop"] += devices.get("desktop", 0)
    return totals


def top_post(post_clicks: dict) -> tuple[str, int]:
    if not post_clicks:
        return ("none", 0)
    return max(post_clicks.items(), key=lambda x: x[1])


def top_country(countries: dict) -> str:
    if not countries:
        return "unknown"
    return max(countries.items(), key=lambda x: x[1])[0]


def fetch_recent_posts() -> list[str]:
    """Fetch journal.html from GitHub and extract post titles."""
    try:
        r = requests.get(JOURNAL_URL, timeout=10)
        r.raise_for_status()
        html = r.text
        # Try class-based titles first (most reliable)
        class_titles = re.findall(
            r'class="[^"]*(?:post-title|entry-title|article-title|card-title)[^"]*"[^>]*>([^<]{10,})<',
            html, re.IGNORECASE,
        )
        # Fallback to heading tags
        heading_titles = re.findall(r'<h[23][^>]*>([^<]{10,})</h[23]>', html, re.IGNORECASE)
        all_titles = list(dict.fromkeys(class_titles + heading_titles))
        filtered = [t.strip() for t in all_titles if len(t.strip()) > 10][:10]
        return filtered if filtered else ["(no posts parsed)"]
    except Exception as e:
        log.warning("fetch_recent_posts failed: %s", e)
        return ["(could not fetch journal)"]


def get_subscriber_interests() -> dict:
    """Fetch subscriber list and count declared interests."""
    try:
        r = requests.get(
            f"{FORM_WORKER}/subscribers/list",
            headers={"x-admin-key": ADMIN_KEY},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        subscribers = data if isinstance(data, list) else data.get("subscribers", [])
        counts: dict = {}
        for sub in subscribers:
            interests = sub.get("interests", [])
            if isinstance(interests, str):
                interests = [interests]
            for interest in interests:
                counts[interest] = counts.get(interest, 0) + 1
        return counts
    except Exception as e:
        log.warning("get_subscriber_interests failed: %s", e)
        return {}


def gather_newsletter_context() -> dict:
    """Collect recent posts, subscriber interests, and weekly analytics."""
    week         = get_week_stats()
    slug, count  = top_post(week["post_clicks"])
    recent_posts = fetch_recent_posts()
    interests    = get_subscriber_interests()
    return {
        "recent_posts":    recent_posts,
        "interests":       interests,
        "top_post":        f"{slug} ({count} clicks)" if slug != "none" else "none this week",
        "week_visitors":   week["visitors"],
        "week_new_subs":   week["new_subscribers"],
        "all_post_clicks": week["post_clicks"],
    }


def monetisation_status(subs: int) -> str:
    if subs < 100:
        return (
            f"📍 Stage 1: Build content ({subs}/100 subs). "
            f"{100 - subs} more until paid newsletter tier is viable."
        )
    elif subs < 500:
        return (
            f"💌 Stage 2: Ready for paid newsletter tier at €5/month! "
            f"({subs} subs — {500 - subs} until PDF guide stage)"
        )
    elif subs < 1000:
        return (
            f"📄 Stage 3: Launch a PDF guide at €15–25 now! "
            f"({subs} subs — {1000 - subs} until workshop stage)"
        )
    else:
        return (
            f"🎓 Stage 4: Run online workshops at €97–197. "
            f"({subs} subs — you're in full monetisation territory)"
        )


# ── Groq AI helper ────────────────────────────────────────────────────────────

def ask_groq(user_message: str, data_context: str = "") -> str:
    """One-shot Groq call — no persistent history, clean every time."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if data_context:
        messages.append({
            "role": "user",
            "content": f"Here is the current data:\n\n{data_context}\n\n{user_message}",
        })
    else:
        messages.append({"role": "user", "content": user_message})
    try:
        resp = groq.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            max_tokens=400,
            temperature=0.7,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        log.error("Groq error: %s", e)
        return "⚠️ AI unavailable right now. Data above is still accurate."


def ask_groq_newsletter(user_message: str, history: list[dict] | None = None) -> str:
    """Groq call using the newsletter writing system prompt, with optional history."""
    messages = [{"role": "system", "content": NEWSLETTER_SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_message})
    try:
        resp = groq.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            max_tokens=700,
            temperature=0.8,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        log.error("Groq newsletter error: %s", e)
        return "⚠️ AI unavailable right now. Please try again in a moment."


def generate_newsletter_questions(ctx: dict) -> list[str]:
    """Ask Groq to produce fresh, data-driven questions for this session."""
    posts_str     = ", ".join(ctx.get("recent_posts", [])[:6]) or "(no recent posts)"
    interests_str = ", ".join(
        f"{k}: {v}" for k, v in ctx.get("interests", {}).items()
    ) or "(no interest data)"
    top_content = ctx.get("top_post", "none")

    prompt = (
        "You are a creative editorial assistant for Elena,\n"
        "who runs A Terra Liberty - a slow living blog in Portugal.\n\n"
        "Here is the current data about her website:\n"
        f"- Recent posts: {posts_str}\n"
        f"- Subscriber interests breakdown: {interests_str}\n"
        f"- Top performing content this week: {top_content}\n\n"
        "Based on this real data, generate 4-5 UNIQUE questions\n"
        "to help Elena write her next newsletter.\n\n"
        "Rules for questions:\n"
        "- Never ask the same question twice across sessions\n"
        "- Questions must reference her ACTUAL recent content\n"
        "  e.g. 'Your post about [actual post title] got a lot\n"
        "  of attention - what inspired that moment?'\n"
        "- Questions should feel like a conversation with\n"
        "  a curious friend, not a form\n"
        "- Mix question types: one reflective, one sensory/moment,\n"
        "  one practical insight, one forward-looking\n"
        "- Reference what subscribers are most interested in\n"
        "- If health notes are trending, lean that way\n"
        "- If Portugal Life is popular, ask about daily life\n"
        "- Keep each question under 15 words\n"
        "- Warm, curious, human tone\n\n"
        "Return ONLY a JSON array of question strings.\n"
        "No explanation. No numbering. Just the array."
    )
    try:
        resp = groq.chat.completions.create(
            model=GROQ_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=400,
            temperature=0.9,
        )
        raw   = resp.choices[0].message.content.strip()
        match = re.search(r'\[.*\]', raw, re.DOTALL)
        if match:
            questions = json.loads(match.group())
            if isinstance(questions, list) and len(questions) >= 3:
                return [str(q) for q in questions[:5]]
    except Exception as e:
        log.error("generate_newsletter_questions failed: %s", e)
    return _FALLBACK_QUESTIONS


def _build_newsletter_write_prompt(questions: list, answers: list, ctx: dict) -> str:
    """Build the full user message for newsletter generation with all context."""
    posts_str = ", ".join(ctx.get("recent_posts", [])[:6]) or "(no recent posts)"
    interests_str = (
        "\n".join(f"  {k}: {v}" for k, v in ctx.get("interests", {}).items())
        or "  (no data)"
    )
    top_content = ctx.get("top_post", "none")
    qa_lines = "\n".join(
        f"[{q}]: {a}" for q, a in zip(questions, answers)
    )
    return (
        f"Here is context about Elena's current website:\n"
        f"Recent posts: {posts_str}\n"
        f"What subscribers care about most:\n{interests_str}\n"
        f"Top content this week: {top_content}\n\n"
        f"Here are Elena's answers to today's questions:\n{qa_lines}\n\n"
        "Write a 300-400 word newsletter that:\n"
        "- Opens with a personal moment or observation\n"
        "- Weaves in the insights from her answers naturally\n"
        "- References her recent content where relevant\n"
        "- Closes with warmth and a gentle invitation\n"
        "- Feels like it was handwritten, not AI-generated\n\n"
        "At the very end, on a new line, write exactly:\n"
        "Subject: [a short compelling subject line for this newsletter]"
    )


def _is_elena(update: Update) -> bool:
    """Return True only if the message comes from Elena's chat."""
    return update.effective_chat.id == ELENA_CHAT_ID


def _session(chat_id: str) -> dict:
    """Return (or create) the newsletter session dict for a chat."""
    if chat_id not in _newsletter_sessions:
        _newsletter_sessions[chat_id] = {
            "step": 0, "questions": [], "answers": [],
            "context": {}, "draft": "", "subject": "", "awaiting_confirm": False,
        }
    return _newsletter_sessions[chat_id]


def _reset_session(chat_id: str) -> None:
    _newsletter_sessions[chat_id] = {
        "step": 0, "questions": [], "answers": [],
        "context": {}, "draft": "", "subject": "", "awaiting_confirm": False,
    }


# ── Report builders ───────────────────────────────────────────────────────────

def build_daily_report() -> str:
    today = _today_str()
    d = get_day_stats(today)
    subs = get_subscriber_count()

    if not d:
        header = (
            f"📊 *Daily Report — {today}*\n\n"
            f"No tracking data yet for today.\n\n"
            f"👥 Total subscribers: *{subs}*\n"
            f"{monetisation_status(subs)}"
        )
        insight = ask_groq(
            "No site visits tracked today yet. Give Elena a short motivational push "
            "and the single most important thing she should do today.",
            f"Subscribers: {subs}",
        )
        return f"{header}\n\n💡 {insight}"

    views    = d.get("visitors", 0)
    new_subs = d.get("newSubscribers", 0)
    yt       = d.get("youtubeClicks", 0)
    post_slug, post_count = top_post(d.get("postClicks", {}))
    country  = top_country(d.get("countries", {}))

    header = (
        f"📊 *Daily Report — {today}*\n\n"
        f"👁 Visitors: *{views}*\n"
        f"📧 New subscribers: *{new_subs}*\n"
        f"👥 Total subscribers: *{subs}*\n"
        f"▶️ YouTube clicks: *{yt}*\n"
        f"🔥 Top post: `{post_slug}` ({post_count} clicks)\n"
        f"🌍 Top country: {country}\n\n"
        f"{monetisation_status(subs)}"
    )
    data_ctx = (
        f"Date: {today}\nVisitors: {views}\nNew subscribers: {new_subs}\n"
        f"Total subscribers: {subs}\nYouTube clicks: {yt}\n"
        f"Top post: {post_slug} ({post_count} clicks)\nTop country: {country}"
    )
    insight = ask_groq(
        "Give a short analysis of today's performance and ONE specific action for this week.",
        data_ctx,
    )
    return f"{header}\n\n💡 {insight}"


def build_weekly_report() -> str:
    w    = get_week_stats()
    subs = get_subscriber_count()
    post_slug, post_count = top_post(w["post_clicks"])
    country = top_country(w["countries"])
    total   = w["devices"]["mobile"] + w["devices"]["desktop"]
    mob_pct = int(w["devices"]["mobile"] / total * 100) if total else 0

    header = (
        f"📈 *Weekly Report — Last 7 Days*\n\n"
        f"👁 Total visitors: *{w['visitors']}*\n"
        f"📧 New subscribers: *{w['new_subscribers']}*\n"
        f"👥 Total subscribers: *{subs}*\n"
        f"▶️ YouTube clicks: *{w['youtube_clicks']}*\n"
        f"🔥 Best post: `{post_slug}` ({post_count} clicks)\n"
        f"📱 Mobile traffic: {mob_pct}%\n"
        f"🌍 Top country: {country}\n\n"
        f"{monetisation_status(subs)}"
    )
    data_ctx = (
        f"Weekly totals:\nVisitors: {w['visitors']}\nNew subs: {w['new_subscribers']}\n"
        f"Total subs: {subs}\nYouTube clicks: {w['youtube_clicks']}\n"
        f"Best post: {post_slug} ({post_count} clicks)\nMobile: {mob_pct}%\nTop country: {country}"
    )
    insight = ask_groq(
        "Give a strategic weekly review: what worked, what to double down on, "
        "and the single most important move for next week.",
        data_ctx,
    )
    return f"{header}\n\n💡 {insight}"


# ── Scheduled job callbacks ────────────────────────────────────────────────────

async def send_daily_report(context: ContextTypes.DEFAULT_TYPE):
    text = build_daily_report()
    await context.bot.send_message(chat_id=CHAT_ID, text=text, parse_mode="Markdown")


async def send_weekly_report(context: ContextTypes.DEFAULT_TYPE):
    text = build_weekly_report()
    await context.bot.send_message(chat_id=CHAT_ID, text=text, parse_mode="Markdown")


# ── Command handlers ──────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    print(f"CHAT ID: {chat_id}")
    log.info("CHAT ID: %s", chat_id)
    await update.message.reply_text(
        f"✅ YOUR CHAT ID IS: {chat_id} — save this!\n\n"
        "👋 Olá! I'm your A Terra Liberty strategy bot.\n\n"
        "📊 Analytics:\n"
        "/today — today's stats + AI insight\n"
        "/week — weekly report + strategy\n"
        "/subscribers — subscriber count + monetisation stage\n"
        "/best — best performing post this week\n"
        "/suggest — 3 content ideas based on your data\n"
        "/monetise — what to sell RIGHT NOW\n"
        "/strategy — full 30-day growth plan\n\n"
        "✍️ Newsletter:\n"
        "/newsletter — start drafting (AI questions based on your real data)\n"
        "/draft — show current draft\n"
        "/editdraft — request changes to the draft\n"
        "/send_newsletter — send to all subscribers\n"
        "/topics — subscriber interests, top posts & content gaps\n\n"
        "Or just chat — ask me anything about growing A Terra Liberty."
    )


async def cmd_today(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Fetching today's data…")
    text = build_daily_report()
    await update.message.reply_text(text, parse_mode="Markdown")


async def cmd_week(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Building weekly report…")
    text = build_weekly_report()
    await update.message.reply_text(text, parse_mode="Markdown")


async def cmd_subscribers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    subs = get_subscriber_count()
    week = get_week_stats()
    new_this_week = week["new_subscribers"]
    status = monetisation_status(subs)
    data_ctx = f"Total subscribers: {subs}\nNew this week: {new_this_week}"
    advice = ask_groq(
        "Based on Elena's current subscriber count, tell her exactly which monetisation "
        "stage she's in, what that means, and the single most valuable thing she can do "
        "this week to move to the next stage.",
        data_ctx,
    )
    await update.message.reply_text(
        f"👥 *Subscribers*\n\n"
        f"Total: *{subs}*\n"
        f"New this week: *{new_this_week}*\n\n"
        f"{status}\n\n"
        f"💡 {advice}",
        parse_mode="Markdown",
    )


async def cmd_best(update: Update, context: ContextTypes.DEFAULT_TYPE):
    week = get_week_stats()
    slug, count = top_post(week["post_clicks"])
    if slug == "none":
        await update.message.reply_text(
            "No post click data yet this week. Make sure the analytics worker is "
            "deployed and tracking is live on your pages."
        )
        return
    data_ctx = f"Best post this week: {slug} with {count} clicks\nAll post clicks: {week['post_clicks']}"
    advice = ask_groq(
        "Tell Elena why this post is her best performer this week, what it tells her "
        "about her audience, and give one specific follow-up content idea that builds on it.",
        data_ctx,
    )
    await update.message.reply_text(
        f"🔥 *Best Post This Week*\n\nPost: `{slug}`\nClicks: *{count}*\n\n💡 {advice}",
        parse_mode="Markdown",
    )


async def cmd_suggest(update: Update, context: ContextTypes.DEFAULT_TYPE):
    week = get_week_stats()
    subs = get_subscriber_count()
    slug, count = top_post(week["post_clicks"])
    data_ctx = (
        f"Subscribers: {subs}\nVisitors this week: {week['visitors']}\n"
        f"Best post: {slug} ({count} clicks)\nAll clicks: {week['post_clicks']}\n"
        f"YouTube clicks: {week['youtube_clicks']}"
    )
    ideas = ask_groq(
        "Give Elena exactly 3 specific content ideas for next week. "
        "Each idea must have: a specific title, the category (slow living / food & health / "
        "portugal life / longevity), and one sentence on why it will perform well based on her data. "
        "Number them 1, 2, 3.",
        data_ctx,
    )
    await update.message.reply_text(
        f"✍️ *3 Content Ideas for This Week*\n\n{ideas}",
        parse_mode="Markdown",
    )


async def cmd_monetise(update: Update, context: ContextTypes.DEFAULT_TYPE):
    subs = get_subscriber_count()
    week = get_week_stats()
    slug, count = top_post(week["post_clicks"])
    data_ctx = (
        f"Subscribers: {subs}\nBest content: {slug}\n"
        f"Weekly visitors: {week['visitors']}\nYouTube clicks: {week['youtube_clicks']}"
    )
    advice = ask_groq(
        "Tell Elena exactly what she can sell RIGHT NOW given her current subscriber count. "
        "Be specific: product name, price in euros, how to create it, where to sell it, "
        "how many sales she needs to hit €500/month. Don't hedge — give real numbers.",
        data_ctx,
    )
    await update.message.reply_text(
        f"💶 *Monetisation — Right Now*\n\n{advice}",
        parse_mode="Markdown",
    )


async def cmd_strategy(update: Update, context: ContextTypes.DEFAULT_TYPE):
    subs = get_subscriber_count()
    week = get_week_stats()
    data_ctx = (
        f"Subscribers: {subs}\nWeekly visitors: {week['visitors']}\n"
        f"New subs this week: {week['new_subscribers']}\nYouTube clicks: {week['youtube_clicks']}\n"
        f"Top post: {top_post(week['post_clicks'])}"
    )
    plan = ask_groq(
        "Create a specific 30-day growth plan for A Terra Liberty. "
        "Week 1, Week 2, Week 3, Week 4 — each with: one content piece to publish, "
        "one growth action (newsletter CTA, cross-post, collab idea etc), and one "
        "monetisation step. Base it on the real numbers. Be concrete, not generic.",
        data_ctx,
    )
    await update.message.reply_text(
        f"🗓 *30-Day Growth Plan*\n\n{plan}",
        parse_mode="Markdown",
    )


async def cmd_newsletter(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Start a newsletter drafting session with dynamic data-driven questions."""
    cid = str(update.effective_chat.id)
    _reset_session(cid)
    sess = _session(cid)

    await update.message.reply_text("🔍 Gathering your website data to write smart questions…")

    loop = asyncio.get_event_loop()
    ctx       = await loop.run_in_executor(None, gather_newsletter_context)
    questions = await loop.run_in_executor(None, generate_newsletter_questions, ctx)

    sess["questions"] = questions
    sess["context"]   = ctx
    sess["step"]      = 1
    total = len(questions)

    await update.message.reply_text(
        f"✍️ *Newsletter drafting — {total} questions*\n\n"
        f"Question 1 of {total}:\n{questions[0]}",
        parse_mode="Markdown",
    )


async def cmd_draft(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show the last generated newsletter draft."""
    cid = str(update.effective_chat.id)
    sess = _session(cid)
    if not sess["draft"]:
        await update.message.reply_text(
            "No draft yet. Use /newsletter to start drafting."
        )
        return
    subject_line = f"📌 *Subject:* {sess['subject']}\n\n" if sess["subject"] else ""
    await update.message.reply_text(
        f"{subject_line}📄 *Current Draft:*\n\n{sess['draft']}",
        parse_mode="Markdown",
    )


async def cmd_editdraft(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Enter edit mode — next free-text message describes what to change."""
    cid = str(update.effective_chat.id)
    sess = _session(cid)
    if not sess["draft"]:
        await update.message.reply_text(
            "No draft to edit yet. Use /newsletter to create one first."
        )
        return
    sess["step"] = 10  # edit-mode sentinel
    await update.message.reply_text(
        "Tell me what to change — e.g. \"make it shorter\", \"add more about the food\", "
        "\"change the opening to be warmer\"."
    )


async def cmd_send_newsletter(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Confirm and send newsletter to all subscribers."""
    cid = str(update.effective_chat.id)
    sess = _session(cid)
    if not sess["draft"]:
        await update.message.reply_text(
            "No draft ready. Use /newsletter to write one first."
        )
        return
    try:
        subs = get_subscriber_count()
    except Exception:
        subs = "?"
    subject = sess["subject"] or "(no subject)"
    sess["awaiting_confirm"] = True
    await update.message.reply_text(
        f"📬 About to send to *{subs}* subscribers.\n"
        f"Subject: _{subject}_\n\n"
        "Reply *CONFIRM SEND* to proceed.",
        parse_mode="Markdown",
    )


async def cmd_topics(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show subscriber interests, top posts, and content gap suggestions."""
    await update.message.reply_text("📊 Analysing your content landscape…")

    week         = get_week_stats()
    interests    = get_subscriber_interests()
    recent_posts = fetch_recent_posts()
    subs         = get_subscriber_count()
    slug, count  = top_post(week["post_clicks"])

    interests_lines = (
        "\n".join(
            f"  • {k}: {v} subscribers"
            for k, v in sorted(interests.items(), key=lambda x: x[1], reverse=True)
        ) if interests else "  • No interest data yet"
    )
    top_posts_lines = (
        "\n".join(
            f"  • {s}: {c} clicks"
            for s, c in sorted(week["post_clicks"].items(), key=lambda x: x[1], reverse=True)[:5]
        ) if week["post_clicks"] else "  • No click data this week"
    )
    data_ctx = (
        f"Recent posts on site: {', '.join(recent_posts[:6])}\n"
        f"Most clicked this week: {slug} ({count} clicks)\n"
        f"All post clicks: {week['post_clicks']}\n"
        f"Subscriber interests: {interests}\n"
        f"Total subscribers: {subs}"
    )
    gaps = ask_groq(
        "Look at Elena's recent posts and subscriber interests. "
        "Identify 3 content gaps — topics her subscribers care about that she hasn't "
        "written about recently. For each gap: topic name + one specific post title idea. "
        "Be concrete, not generic.",
        data_ctx,
    )
    recent_posts_lines = "\n".join(f"  • {p}" for p in recent_posts[:6])
    await update.message.reply_text(
        f"📊 *Content Landscape*\n\n"
        f"👥 *What subscribers care about:*\n{interests_lines}\n\n"
        f"🔥 *Top posts this week:*\n{top_posts_lines}\n\n"
        f"📝 *Recent posts on site:*\n{recent_posts_lines}\n\n"
        f"💡 *3 Content Gaps:*\n{gaps}",
        parse_mode="Markdown",
    )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Free-text chat handler — newsletter Q&A, confirm-send, edit, or general chat."""
    text = update.message.text.strip()
    cid  = str(update.effective_chat.id)
    sess = _session(cid)

    # ── CONFIRM SEND flow ──────────────────────────────────────────────────────
    if sess["awaiting_confirm"]:
        if text == "CONFIRM SEND":
            sess["awaiting_confirm"] = False
            await update.message.reply_text("📤 Sending newsletter…")
            try:
                payload = {
                    "adminKey": ADMIN_KEY,
                    "subject": sess["subject"] or "A Terra Liberty Newsletter",
                    "body": sess["draft"],
                }
                r = requests.post(
                    f"{FORM_WORKER}/send-newsletter",
                    json=payload,
                    headers={"x-admin-key": ADMIN_KEY},
                    timeout=30,
                )
                r.raise_for_status()
                data = r.json()
                sent = data.get("sent", data.get("count", "?"))
                await update.message.reply_text(
                    f"✅ Sent to {sent} subscribers successfully."
                )
            except Exception as e:
                log.error("send-newsletter error: %s", e)
                await update.message.reply_text(
                    f"⚠️ Send failed: {e}\nCheck the Worker and try again."
                )
        else:
            sess["awaiting_confirm"] = False
            await update.message.reply_text(
                "Send cancelled. Use /send_newsletter again when ready."
            )
        return

    # ── Newsletter Q&A flow ────────────────────────────────────────────────────
    questions = sess.get("questions") or _FALLBACK_QUESTIONS
    total_q   = len(questions)
    if 1 <= sess["step"] <= total_q:
        sess["answers"].append(text)
        if sess["step"] < total_q:
            sess["step"] += 1
            q = questions[sess["step"] - 1]
            await update.message.reply_text(
                f"Question {sess['step']} of {total_q}:\n{q}"
            )
        else:
            # All answers collected — generate draft
            sess["step"] = 6
            await update.message.reply_text("✨ Writing your newsletter…")
            prompt    = _build_newsletter_write_prompt(questions, sess["answers"], sess.get("context", {}))
            draft_raw = ask_groq_newsletter(prompt)
            # Extract subject line if present
            subject = ""
            draft_lines = draft_raw.splitlines()
            body_lines = []
            for line in draft_lines:
                if line.strip().startswith("Subject:"):
                    subject = line.strip()[len("Subject:"):].strip()
                else:
                    body_lines.append(line)
            sess["draft"]   = "\n".join(body_lines).strip()
            sess["subject"] = subject

            subject_display = f"📌 *Subject:* {subject}\n\n" if subject else ""
            await update.message.reply_text(
                f"{subject_display}📄 *Your newsletter draft:*\n\n{sess['draft']}\n\n"
                "Use /editdraft to refine, or /send_newsletter when ready.",
                parse_mode="Markdown",
            )
        return

    # ── Edit-draft mode (step 10) ──────────────────────────────────────────────
    if sess["step"] == 10:
        sess["step"] = 6
        await update.message.reply_text("✏️ Updating draft…")
        prompt = (
            f"Here is the current newsletter draft:\n\n{sess['draft']}\n\n"
            f"Please apply this change: {text}\n\n"
            "Return the full updated newsletter. Keep Elena's voice."
        )
        updated_raw = ask_groq_newsletter(prompt)
        subject = sess["subject"]
        body_lines = []
        for line in updated_raw.splitlines():
            if line.strip().startswith("Subject:"):
                subject = line.strip()[len("Subject:"):].strip()
            else:
                body_lines.append(line)
        sess["draft"]   = "\n".join(body_lines).strip()
        sess["subject"] = subject

        subject_display = f"📌 *Subject:* {subject}\n\n" if subject else ""
        await update.message.reply_text(
            f"{subject_display}📄 *Updated draft:*\n\n{sess['draft']}\n\n"
            "Use /editdraft to refine more, or /send_newsletter when ready.",
            parse_mode="Markdown",
        )
        return

    # ── General chat ───────────────────────────────────────────────────────────
    subs  = get_subscriber_count()
    reply = ask_groq(text, f"Current subscribers: {subs}")
    await update.message.reply_text(reply)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    app = Application.builder().token(BOT_TOKEN).build()

    # elena_filter temporarily removed — respond to any chat to find correct ID
    app.add_handler(CommandHandler("start",            cmd_start))
    app.add_handler(CommandHandler("today",            cmd_today))
    app.add_handler(CommandHandler("week",             cmd_week))
    app.add_handler(CommandHandler("subscribers",      cmd_subscribers))
    app.add_handler(CommandHandler("best",             cmd_best))
    app.add_handler(CommandHandler("suggest",          cmd_suggest))
    app.add_handler(CommandHandler("monetise",         cmd_monetise))
    app.add_handler(CommandHandler("strategy",         cmd_strategy))
    app.add_handler(CommandHandler("newsletter",       cmd_newsletter))
    app.add_handler(CommandHandler("draft",            cmd_draft))
    app.add_handler(CommandHandler("editdraft",        cmd_editdraft))
    app.add_handler(CommandHandler("send_newsletter",  cmd_send_newsletter))
    app.add_handler(CommandHandler("topics",           cmd_topics))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Daily report at 08:00 Portugal time
    job_queue = app.job_queue
    report_time = datetime.time(hour=8, minute=0, tzinfo=PORTUGAL_TZ)
    job_queue.run_daily(send_daily_report, time=report_time, name="atl_daily")
    # Weekly report on Monday (day 0) at 08:00
    job_queue.run_daily(send_weekly_report, time=report_time, days=(0,), name="atl_weekly")

    log.info("aterraliberty_bot started — polling…")
    app.run_polling()


if __name__ == "__main__":
    main()
