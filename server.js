import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import RSSParser from 'rss-parser';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3457;

// ─── RSS Parser setup ────────────────────────────────────────────────────────

const parser = new RSSParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  },
  customFields: { item: [['content:encoded', 'content:encoded']] },
});

// ─── Utility helpers ─────────────────────────────────────────────────────────

function stripHtml(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
}

function parseDate(str) {
  if (!str) return 0;
  const d = new Date(str);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function timeAgo(dateStr) {
  const ms = Date.now() - parseDate(dateStr);
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// Lenient XML regex fallback for feeds rss-parser can't handle
async function fetchFeedRaw(feedUrl) {
  try {
    const res = await fetchWithTimeout(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 15) {
      const block = match[1];
      const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const link = block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
      const desc = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
      const pubDate = block.match(/<pubDate[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i);
      if (title) {
        items.push({
          title: stripHtml(title[1]),
          link: (link?.[1] || '').trim(),
          description: desc ? desc[1] : '',
          pubDate: pubDate ? pubDate[1].trim() : null,
        });
      }
    }
    return items.length > 0 ? items : null;
  } catch { return null; }
}

async function parseFeedUrl(url) {
  try {
    const feed = await parser.parseURL(url);
    if (feed.items?.length > 0) return feed.items;
  } catch {}
  return await fetchFeedRaw(url);
}

function extractExcerpt(item) {
  const candidates = [
    item['content:encoded'], item.content, item.summary,
    item.description, item.contentSnippet, item['dc:description'],
  ];
  let best = '';
  for (const raw of candidates) {
    if (!raw) continue;
    const cleaned = stripHtml(raw);
    if (cleaned.length > best.length) best = cleaned;
  }
  if (best.length > 300) {
    const trunc = best.substring(0, 300);
    const boundary = Math.max(trunc.lastIndexOf('.'), trunc.lastIndexOf('?'), trunc.lastIndexOf('!'));
    best = boundary > 100 ? trunc.substring(0, boundary + 1) : trunc + '…';
  }
  return best || 'Read the full article for details.';
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = {
  isw:         { data: null, ts: 0 },
  acled:       { data: null, ts: 0 },
  gdelt:       { data: null, ts: 0 },
  newsapi:     { data: null, ts: 0 },
  countryNews: { data: {}, ts: 0 },
  hormuz:      { data: null, ts: 0 },
};

const ISW_TTL      = 30 * 60 * 1000;        // 30 min
const ACLED_TTL    = 10 * 60 * 1000;        // 10 min
const GDELT_TTL    = 15 * 60 * 1000;        // 15 min
const NEWSAPI_TTL  =  4 * 60 * 60 * 1000;  // 4 hours
const COUNTRY_TTL  = 15 * 60 * 1000;        // 15 min

// ─── ISW Scraper ─────────────────────────────────────────────────────────────

const ISW_KEYWORDS = /iran|israel|middle east|gaza|lebanon|iraq|hormuz|hezbollah|hamas|houthi|irgc|idf/i;

// Scrape the full body of a single ISW article and return up to 5 key points
async function fetchISWArticleContent(url) {
  if (!url || url === '#' || !url.includes('understandingwar.org')) return [];
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    }, 14000);
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const points = [];
    // ISW uses Drupal — try common content field selectors
    const bodyEl = $(
      '.field-name-body .field-items, .field-name-body, .field-items, .node-body, article .content'
    ).first();

    if (bodyEl.length) {
      bodyEl.find('p, li').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        // Skip short lines and generic headers like "Key Takeaways:"
        if (text.length > 80 && !/^key takeaway|^sources|^\[.*\]$/i.test(text)) {
          points.push(text.length > 600 ? text.substring(0, 600) + '…' : text);
        }
        if (points.length >= 5) return false;
      });
    }
    return points;
  } catch { return []; }
}

async function fetchISW() {
  if (cache.isw.data && Date.now() - cache.isw.ts < ISW_TTL) return cache.isw.data;

  const articles = [];

  // Layer 1: HTML scrape of the ISW Iran updates listing page
  try {
    const res = await fetchWithTimeout('https://www.understandingwar.org/backgrounders/iran-updates', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      $('article, .views-row, .node').each((_, el) => {
        if (articles.length >= 5) return false;
        const titleEl = $(el).find('h2 a, h3 a, .title a').first();
        const title = titleEl.text().trim();
        const href = titleEl.attr('href');
        const dateEl = $(el).find('time, .date-display-single').first();
        const excerpt = $(el).find('p').first().text().trim();
        if (title && href) {
          const url = href.startsWith('http') ? href : `https://www.understandingwar.org${href}`;
          if (!articles.find(a => a.url === url)) {
            articles.push({ title, url, date: dateEl.attr('datetime') || dateEl.text().trim() || null, excerpt: excerpt.substring(0, 300) || '', source: 'ISW', keyPoints: [] });
          }
        }
      });
    }
  } catch (e) { console.error('[ISW] Listing scrape error:', e.message); }

  // Layer 2: RSS fallback if listing scrape failed
  if (articles.length < 3) {
    const iswFeeds = [
      'https://www.understandingwar.org/feeds/all-recent-content',
      'https://news.google.com/rss/search?q=site:understandingwar.org+Iran+OR+Israel+OR+Gaza&hl=en',
    ];
    for (const feedUrl of iswFeeds) {
      if (articles.length >= 5) break;
      try {
        const items = await parseFeedUrl(feedUrl);
        if (items?.length) {
          for (const item of items) {
            if (ISW_KEYWORDS.test(`${item.title || ''} ${item.description || ''}`)) {
              const url = item.link || item.guid || '#';
              if (!articles.find(a => a.url === url)) {
                articles.push({ title: stripHtml(item.title || 'ISW Report'), url, date: item.pubDate || item.isoDate || null, excerpt: extractExcerpt(item), source: 'ISW RSS', keyPoints: [] });
              }
            }
            if (articles.length >= 5) break;
          }
        }
      } catch {}
    }
  }

  // Layer 3: Fetch full article content for each (parallel, with individual timeouts)
  await Promise.allSettled(articles.map(async (article) => {
    article.keyPoints = await fetchISWArticleContent(article.url);
  }));

  articles.sort((a, b) => parseDate(b.date) - parseDate(a.date));
  const result = articles.slice(0, 5);
  cache.isw = { data: result, ts: Date.now() };
  console.log(`[ISW] Fetched ${result.length} articles with full content`);
  return result;
}

// ─── ACLED API ────────────────────────────────────────────────────────────────

const ACLED_COUNTRIES = [
  'Israel', 'Palestine', 'Iran', 'Lebanon', 'Iraq',
  'United States', 'Saudi Arabia', 'United Arab Emirates',
  'Qatar', 'Bahrain', 'Kuwait', 'Oman',
];

function acledDateRange(daysBack) {
  const end = new Date();
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().split('T')[0];
  return `${fmt(start)}|${fmt(end)}`;
}

async function fetchACLED(params) {
  const email = process.env.ACLED_EMAIL;
  const key = process.env.ACLED_KEY;
  if (!email || !key) {
    console.warn('[ACLED] Missing credentials — set ACLED_EMAIL and ACLED_KEY in .env');
    return null;
  }

  const base = 'https://api.acleddata.com/acled/read';
  const qs = new URLSearchParams({
    key, email,
    fields: 'event_date,country,event_type,sub_event_type,actor1,notes,latitude,longitude',
    limit: '500',
    ...params,
  });

  try {
    const res = await fetchWithTimeout(`${base}?${qs}`, {}, 20000);
    if (!res.ok) {
      console.error(`[ACLED] HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json.data || [];
  } catch (e) {
    console.error('[ACLED] fetch error:', e.message);
    return null;
  }
}

async function refreshACLED() {
  if (cache.acled.data && Date.now() - cache.acled.ts < ACLED_TTL) return cache.acled.data;

  const countryParam = ACLED_COUNTRIES.join('|');

  const [events90, events48] = await Promise.all([
    fetchACLED({
      country: countryParam,
      event_date_where: 'BETWEEN',
      event_date: acledDateRange(90),
    }),
    fetchACLED({
      country: countryParam,
      event_date_where: 'BETWEEN',
      event_date: acledDateRange(2),
    }),
  ]);

  if (!events90) return cache.acled.data; // keep stale

  // Build per-country stats
  const stats = {};
  for (const country of ACLED_COUNTRIES) {
    stats[country] = {
      missiles: 0,
      drones: 0,
      airstrikes: 0,
      last48hIncidents: [],
      hasRecentEvents: false,
    };
  }

  for (const ev of events90) {
    const c = ev.country;
    if (!stats[c]) continue;
    const sub = (ev.sub_event_type || '').toLowerCase();
    if (sub.includes('missile') || sub.includes('shelling') || sub.includes('artillery')) {
      stats[c].missiles++;
    } else if (sub.includes('drone') || sub.includes('uav')) {
      stats[c].drones++;
    } else if (sub.includes('airstrike') || sub.includes('air/drone strike')) {
      stats[c].airstrikes++;
    }
    const daysAgo = (Date.now() - parseDate(ev.event_date)) / 86400000;
    if (daysAgo <= 7) stats[c].hasRecentEvents = true;
  }

  if (events48) {
    for (const ev of events48) {
      const c = ev.country;
      if (!stats[c]) continue;
      stats[c].last48hIncidents.push({
        date: ev.event_date,
        type: ev.sub_event_type || ev.event_type,
        actor: ev.actor1,
        notes: (ev.notes || '').substring(0, 200),
        lat: parseFloat(ev.latitude),
        lng: parseFloat(ev.longitude),
      });
    }
  }

  // Hormuz-area events (approx bbox)
  const hormuzEvents = (events48 || []).filter(ev => {
    const lat = parseFloat(ev.latitude);
    const lng = parseFloat(ev.longitude);
    return lat >= 23 && lat <= 30 && lng >= 54 && lng <= 62;
  });

  const result = { stats, hormuzEvents };
  cache.acled = { data: result, ts: Date.now() };
  console.log(`[ACLED] Refreshed — ${events90.length} events (90d)`);
  return result;
}

// ─── GDELT API ────────────────────────────────────────────────────────────────
// Free, no key needed, updates every 15 min. Provides media-derived event counts.

// ─── Conflict counter (Google News RSS) ──────────────────────────────────────
// Replaces GDELT — uses the same Google News RSS that already works for country news.
// Counts conflict-keyword articles per country as a proxy for strike activity.

function inferEventType(title) {
  const t = (title || '').toLowerCase();
  if (/drone|uav|unmanned/.test(t))           return 'Drone/UAV Strike';
  if (/missile|rocket|ballistic/.test(t))      return 'Missile/Rocket Attack';
  if (/shelling|artillery/.test(t))            return 'Shelling/Artillery';
  if (/airstrike|air strike|bomb/.test(t))     return 'Airstrike';
  return 'Military Incident';
}

// Per-country Google News RSS queries specifically for conflict activity
const CONFLICT_RSS = {
  'Israel':                 'https://news.google.com/rss/search?q=Israel+(missile+OR+drone+OR+airstrike+OR+attack+OR+bombing+OR+IDF+OR+strike)&hl=en&gl=US&ceid=US:en',
  'Iran':                   'https://news.google.com/rss/search?q=Iran+(missile+OR+drone+OR+attack+OR+IRGC+OR+strike+OR+nuclear)&hl=en&gl=US&ceid=US:en',
  'Lebanon':                'https://news.google.com/rss/search?q=Lebanon+(missile+OR+Hezbollah+OR+airstrike+OR+attack+OR+bombing)&hl=en&gl=US&ceid=US:en',
  'Iraq':                   'https://news.google.com/rss/search?q=Iraq+(militia+OR+attack+OR+drone+OR+missile+OR+strike)&hl=en&gl=US&ceid=US:en',
  'Palestine':              'https://news.google.com/rss/search?q=Gaza+(attack+OR+airstrike+OR+bombing+OR+missile+OR+strike+OR+Hamas)&hl=en&gl=US&ceid=US:en',
  'United States':          'https://news.google.com/rss/search?q=US+military+(Middle+East+OR+airstrike+OR+strike+OR+Pentagon+OR+CENTCOM)&hl=en&gl=US&ceid=US:en',
  'Saudi Arabia':           'https://news.google.com/rss/search?q="Saudi+Arabia"+(missile+OR+drone+OR+attack+OR+Houthi+OR+military)&hl=en&gl=US&ceid=US:en',
  'United Arab Emirates':   'https://news.google.com/rss/search?q=UAE+(attack+OR+missile+OR+drone+OR+military+OR+security)&hl=en&gl=US&ceid=US:en',
  'Qatar':                  'https://news.google.com/rss/search?q=Qatar+(military+OR+base+OR+attack+OR+security+OR+US+base)&hl=en&gl=US&ceid=US:en',
  'Bahrain':                'https://news.google.com/rss/search?q=Bahrain+(military+OR+navy+OR+attack+OR+US+fleet)&hl=en&gl=US&ceid=US:en',
  'Kuwait':                 'https://news.google.com/rss/search?q=Kuwait+(military+OR+attack+OR+security+OR+US+base)&hl=en&gl=US&ceid=US:en',
  'Oman':                   'https://news.google.com/rss/search?q=Oman+(military+OR+Hormuz+OR+attack+OR+security)&hl=en&gl=US&ceid=US:en',
};

async function refreshConflictCounts() {
  if (cache.gdelt.data && Date.now() - cache.gdelt.ts < GDELT_TTL) return cache.gdelt.data;

  const stats = {};
  for (const c of COUNTRY_META) {
    stats[c.name] = { missiles: 0, drones: 0, airstrikes: 0, hasRecentEvents: false, dataSource: 'News RSS' };
  }

  await Promise.allSettled(COUNTRY_META.map(async c => {
    const url = CONFLICT_RSS[c.name];
    if (!url) return;
    try {
      const items = await parseFeedUrl(url);
      if (!items?.length) return;
      for (const item of items) {
        const t = (item.title || '').toLowerCase();
        if (/drone|uav|unmanned/.test(t))                          stats[c.name].drones++;
        else if (/missile|rocket|ballistic|shelling|artillery/.test(t)) stats[c.name].missiles++;
        else if (/airstrike|air strike|bomb/.test(t))              stats[c.name].airstrikes++;
        else                                                        stats[c.name].missiles++;
      }
      if (items.length > 0) stats[c.name].hasRecentEvents = true;
    } catch {}
  }));

  cache.gdelt = { data: stats, ts: Date.now() };
  const total = Object.values(stats).reduce((s, c) => s + c.missiles + c.drones + c.airstrikes, 0);
  console.log(`[ConflictRSS] Refreshed — ${total} total mentions across ${COUNTRY_META.length} countries`);
  return stats;
}

// ─── NewsAPI ──────────────────────────────────────────────────────────────────

const NEWSAPI_COUNTRIES = [
  { name: 'Israel',               q: 'Israel war missile military attack' },
  { name: 'Iran',                 q: 'Iran military strike nuclear IRGC' },
  { name: 'Lebanon',              q: 'Lebanon Hezbollah military attack' },
  { name: 'Iraq',                 q: 'Iraq militia attack military' },
  { name: 'Saudi Arabia',         q: '"Saudi Arabia" military attack war' },
  { name: 'United Arab Emirates', q: '"UAE" OR "United Arab Emirates" military security' },
  { name: 'Qatar',                q: 'Qatar military base security' },
  { name: 'Bahrain',              q: 'Bahrain military navy attack' },
  { name: 'Kuwait',               q: 'Kuwait military security attack' },
  { name: 'Oman',                 q: 'Oman military Hormuz security' },
  { name: 'Palestine',            q: 'Gaza Palestine attack strike military' },
  { name: 'Hormuz',               q: '"Strait of Hormuz" OR "Persian Gulf" shipping military' },
];

async function refreshNewsAPI() {
  if (cache.newsapi.data && Date.now() - cache.newsapi.ts < NEWSAPI_TTL) return cache.newsapi.data;

  const key = process.env.NEWSAPI_KEY;
  if (!key) {
    console.warn('[NewsAPI] No NEWSAPI_KEY set — skipping');
    return cache.newsapi.data || {};
  }

  const results = {};
  const base = 'https://newsapi.org/v2/everything';
  const fromDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const { name, q } of NEWSAPI_COUNTRIES) {
    try {
      const qs = new URLSearchParams({
        q, language: 'en', sortBy: 'publishedAt',
        pageSize: '5', from: fromDate, apiKey: key,
      });
      const res = await fetchWithTimeout(`${base}?${qs}`, {}, 10000);
      if (!res.ok) {
        console.warn(`[NewsAPI] ${name}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      results[name] = (json.articles || []).map(a => ({
        title: a.title || 'No title',
        url: a.url,
        date: a.publishedAt,
        source: a.source?.name || 'Unknown',
        description: (a.description || '').substring(0, 200),
      }));
      // Small delay to be respectful
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error(`[NewsAPI] ${name}:`, e.message);
    }
  }

  cache.newsapi = { data: results, ts: Date.now() };
  console.log(`[NewsAPI] Refreshed ${Object.keys(results).length} country feeds`);
  return results;
}

// ─── Country RSS feeds ────────────────────────────────────────────────────────

const COUNTRY_RSS = {
  Israel:                 [
    'https://news.google.com/rss/search?q=Israel+military+war+attack&hl=en&gl=US&ceid=US:en',
    'https://www.jpost.com/Rss/RssFeedsMiddleEast.aspx',
  ],
  Iran:                   [
    'https://news.google.com/rss/search?q=Iran+military+IRGC+attack+nuclear&hl=en&gl=US&ceid=US:en',
    'https://en.irna.ir/rss',
  ],
  Lebanon:                [
    'https://news.google.com/rss/search?q=Lebanon+Hezbollah+military+attack&hl=en&gl=US&ceid=US:en',
    'https://www.nna-leb.gov.lb/en/rss',
  ],
  Iraq:                   [
    'https://news.google.com/rss/search?q=Iraq+militia+military+attack&hl=en&gl=US&ceid=US:en',
    'https://www.ina.iq/services/rss',
  ],
  'United States':        [
    'https://news.google.com/rss/search?q=US+military+Middle+East+Pentagon+CENTCOM&hl=en&gl=US&ceid=US:en',
  ],
  'Saudi Arabia':         [
    'https://news.google.com/rss/search?q="Saudi+Arabia"+military+security+attack&hl=en&gl=US&ceid=US:en',
    'https://www.spa.gov.sa/rss/rssnewen.xml',
  ],
  'United Arab Emirates': [
    'https://news.google.com/rss/search?q=UAE+"United+Arab+Emirates"+military+security&hl=en&gl=US&ceid=US:en',
    'https://wam.ae/en/rss',
  ],
  Qatar:                  [
    'https://news.google.com/rss/search?q=Qatar+military+security+base&hl=en&gl=US&ceid=US:en',
    'https://www.qna.org.qa/en/rss',
  ],
  Bahrain:                [
    'https://news.google.com/rss/search?q=Bahrain+military+navy+security&hl=en&gl=US&ceid=US:en',
    'https://bna.bh/en/?format=feed&type=rss',
  ],
  Kuwait:                 [
    'https://news.google.com/rss/search?q=Kuwait+military+security&hl=en&gl=US&ceid=US:en',
    'https://www.kuna.net.kw/feeds/rss.aspx',
  ],
  Oman:                   [
    'https://news.google.com/rss/search?q=Oman+military+Hormuz+security&hl=en&gl=US&ceid=US:en',
    'https://onaeng.com/feed',
  ],
  Palestine:              [
    'https://news.google.com/rss/search?q=Gaza+Palestine+war+attack+strike&hl=en&gl=US&ceid=US:en',
  ],
};

const HORMUZ_FEEDS = [
  'https://news.google.com/rss/search?q=%22Strait+of+Hormuz%22+OR+%22Persian+Gulf%22+military&hl=en',
  'https://news.google.com/rss/search?q=Hormuz+shipping+tanker+navy&hl=en',
];

async function fetchCountryNews(country) {
  const cached = cache.countryNews.data[country];
  if (cached?.articles && Date.now() - cached.ts < COUNTRY_TTL) return cached.articles;

  const feeds = COUNTRY_RSS[country] || [];
  for (const url of feeds) {
    try {
      const items = await parseFeedUrl(url);
      if (items?.length) {
        const articles = items.slice(0, 5).map(item => ({
          title: stripHtml(item.title || 'No title'),
          url: item.link || item.guid || '#',
          date: item.pubDate || item.isoDate || null,
          source: item.creator || url.split('/')[2] || 'News',
          description: extractExcerpt(item),
        }));
        cache.countryNews.data[country] = { articles, ts: Date.now() };
        return articles;
      }
    } catch {}
  }
  return [];
}

async function fetchHormuzNews() {
  if (cache.hormuz.data && Date.now() - cache.hormuz.ts < COUNTRY_TTL) return cache.hormuz.data;

  const articles = [];
  for (const url of HORMUZ_FEEDS) {
    try {
      const items = await parseFeedUrl(url);
      if (items?.length) {
        for (const item of items.slice(0, 5)) {
          articles.push({
            title: stripHtml(item.title || 'No title'),
            url: item.link || '#',
            date: item.pubDate || item.isoDate || null,
            source: item.creator || 'News',
            description: extractExcerpt(item),
          });
        }
        break;
      }
    } catch {}
  }

  const result = articles.slice(0, 8);
  cache.hormuz = { data: result, ts: Date.now() };
  return result;
}

// ─── Country config ───────────────────────────────────────────────────────────

const COUNTRY_META = [
  { id: 'israel',   name: 'Israel',                flag: '🇮🇱' },
  { id: 'iran',     name: 'Iran',                  flag: '🇮🇷' },
  { id: 'lebanon',  name: 'Lebanon',               flag: '🇱🇧' },
  { id: 'iraq',     name: 'Iraq',                  flag: '🇮🇶' },
  { id: 'usa',      name: 'United States',         flag: '🇺🇸' },
  { id: 'ksa',      name: 'Saudi Arabia',          flag: '🇸🇦' },
  { id: 'uae',      name: 'United Arab Emirates',  flag: '🇦🇪' },
  { id: 'qatar',    name: 'Qatar',                 flag: '🇶🇦' },
  { id: 'bahrain',  name: 'Bahrain',               flag: '🇧🇭' },
  { id: 'kuwait',   name: 'Kuwait',                flag: '🇰🇼' },
  { id: 'oman',     name: 'Oman',                  flag: '🇴🇲' },
  { id: 'pal',      name: 'Palestine',             flag: '🇵🇸' },
];

// ─── SSE clients ──────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcastUpdate() {
  for (const res of sseClients) {
    try { res.write(`data: update\n\n`); } catch {}
  }
}

// ─── Background refresh ───────────────────────────────────────────────────────

async function refreshAll() {
  console.log('[REFRESH] Starting background refresh…');
  const useACLED = !!(process.env.ACLED_EMAIL && process.env.ACLED_KEY);
  await Promise.allSettled([
    fetchISW(),
    useACLED ? refreshACLED() : refreshConflictCounts(),
    fetchHormuzNews(),
    ...COUNTRY_META.map(c => fetchCountryNews(c.name)),
  ]);
  broadcastUpdate();
  console.log('[REFRESH] Done');
}

let _refreshPromise = null;
function startRefresh() {
  if (!_refreshPromise) {
    _refreshPromise = refreshAll().catch(console.error).finally(() => { _refreshPromise = null; });
  }
  return _refreshPromise;
}

// ─── Express middleware ───────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── API: all data ────────────────────────────────────────────────────────────

app.get('/api/all', async (req, res) => {
  try {
    const useACLED = !!(process.env.ACLED_EMAIL && process.env.ACLED_KEY);

    // If cache is completely cold, wait for the in-progress refresh
    const isCold = !cache.isw.data && !cache.gdelt.data && !cache.acled.data;
    if (isCold) await startRefresh();

    // Serve from cache — always fast after the first load
    const isw = cache.isw.data || [];
    const conflictData = useACLED ? cache.acled.data : cache.gdelt.data;
    const newsapiData = cache.newsapi.data || {};
    const hormuzNews = cache.hormuz.data || [];

    const countryNewsAll = {};
    for (const c of COUNTRY_META) {
      countryNewsAll[c.name] = cache.countryNews.data[c.name]?.articles || [];
    }

    // Normalise: ACLED returns { stats, hormuzEvents }, conflict RSS returns stats directly
    const conflictStats = useACLED ? (conflictData?.stats || {}) : (conflictData || {});
    const hormuzEvents  = useACLED ? (conflictData?.hormuzEvents || []) : [];

    // Derive Hormuz status
    const hormuzKeywords = /seized|attacked|closed|blocked|mine|explosion|military|warning/i;
    const hormuzHot = hormuzEvents.length > 0 || hormuzNews.some(a => hormuzKeywords.test(a.title));
    const hormuzStatus = hormuzEvents.length > 2 ? 'RESTRICTED' : hormuzHot ? 'ELEVATED TENSION' : 'OPEN';

    const countries = COUNTRY_META.map(c => {
      const conflict  = conflictStats[c.name] || {};
      const newsapi   = newsapiData?.[c.name] || [];
      const rssNews   = countryNewsAll[c.name] || [];

      // Merge + deduplicate news
      const allNews = [...rssNews, ...newsapi]
        .filter((a, i, arr) => arr.findIndex(b => b.url === a.url) === i)
        .slice(0, 5);

      // Use RSS news as 48h incidents — they're fresh and in English
      const incidents = allNews.slice(0, 4).map(a => ({
        date: a.date,
        type: inferEventType(a.title),
        notes: a.title,
        url: a.url,
        source: a.source,
      }));

      const hasActivity = incidents.length > 0 || (conflict.missiles || 0) + (conflict.drones || 0) + (conflict.airstrikes || 0) > 0;

      let status = 'NO DATA';
      if (conflict.hasRecentEvents || (hasActivity && incidents.length > 0)) status = 'ACTIVE';
      else if (allNews.length > 0) status = 'MONITORING';

      return {
        ...c,
        status,
        missiles:         conflict.missiles   || 0,
        drones:           conflict.drones     || 0,
        airstrikes:       conflict.airstrikes || 0,
        dataSource:       conflict.dataSource || (useACLED ? 'ACLED' : 'GDELT'),
        last48hIncidents: incidents,
        news:             allNews,
      };
    });

    res.json({
      isw: isw || [],
      countries,
      hormuz: { status: hormuzStatus, news: hormuzNews, events: hormuzEvents },
      dataSources: {
        conflict: useACLED ? 'ACLED' : 'GDELT (media mentions)',
      },
      lastUpdated: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[/api/all]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: ISW only ────────────────────────────────────────────────────────────

app.get('/api/isw', async (req, res) => {
  const articles = await fetchISW();
  res.json({ articles });
});

// ─── API: missiles chart data ─────────────────────────────────────────────────

app.get('/api/missiles', async (req, res) => {
  const acledData = await refreshACLED();
  const stats = acledData?.stats || {};
  const data = COUNTRY_META.map(c => ({
    name: c.name,
    flag: c.flag,
    missiles: stats[c.name]?.missiles || 0,
    drones: stats[c.name]?.drones || 0,
    airstrikes: stats[c.name]?.airstrikes || 0,
  }));
  res.json({ countries: data });
});

// ─── API: hormuz ──────────────────────────────────────────────────────────────

app.get('/api/hormuz', async (req, res) => {
  const news = await fetchHormuzNews();
  res.json({ news });
});

// ─── SSE ──────────────────────────────────────────────────────────────────────

app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const useACLED = !!(process.env.ACLED_EMAIL && process.env.ACLED_KEY);
  console.log(`\n🌐 Middle East War Intelligence Dashboard`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   Conflict data: ${useACLED ? '✓ ACLED' : '✓ News RSS (Google News)'}`);
  console.log(`   NewsAPI:       ${process.env.NEWSAPI_KEY ? '✓ configured' : '— optional, add NEWSAPI_KEY'}\n`);

  // Initial data load (non-blocking — serve from cache ASAP)
  startRefresh();

  // Scheduled refreshes
  setInterval(startRefresh, 5 * 60 * 1000);        // 5 min — general
  setInterval(fetchISW, ISW_TTL);                  // 30 min — ISW
  setInterval(refreshNewsAPI, NEWSAPI_TTL);        // 4 hours — NewsAPI
});
