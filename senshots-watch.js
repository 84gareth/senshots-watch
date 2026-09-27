#!/usr/bin/env node
/*
 * SEN Shots watcher  v1.0.1
 * Checks https://sen-shots.cic-connect.co.uk/ and sends a phone alert (via ntfy)
 * when a Drills & Games session has spaces, or when a new date is posted.
 * It does NOT book anything - you tap the alert and book by hand.
 *
 * Requires Node 18+ (built-in fetch). No npm installs.
 *
 * SETUP
 * 1. Install the free "ntfy" app (iOS/Android). Subscribe to a hard-to-guess
 *    topic name, e.g. senshots-gareth-7q2x (anyone who knows the name can read it).
 * 2. Test:   NTFY_TOPIC=your-topic node senshots-watch.js --test
 * 3. Run:    NTFY_TOPIC=your-topic node senshots-watch.js
 *            (checks every 10 min while the machine is on; INTERVAL_MIN=5 to change)
 *
 * OR RUN IT IN THE CLOUD (GitHub Actions, no machine needed)
 * Put this file in a new PUBLIC repo (public = free unlimited Actions minutes),
 * add a repo secret NTFY_TOPIC, and create .github/workflows/watch.yml:
 *
 *   name: senshots-watch
 *   on:
 *     schedule: [{ cron: '*\/10 * * * *' }]
 *     workflow_dispatch:
 *   jobs:
 *     check:
 *       runs-on: ubuntu-latest
 *       steps:
 *         - uses: actions/checkout@v4
 *         - uses: actions/cache/restore@v4
 *           with: { path: senshots-state.json, key: 'senshots-${{ github.run_id }}', restore-keys: senshots- }
 *         - uses: actions/setup-node@v4
 *           with: { node-version: 20 }
 *         - run: node senshots-watch.js --once
 *           env: { NTFY_TOPIC: '${{ secrets.NTFY_TOPIC }}' }
 *         - uses: actions/cache/save@v4
 *           if: always()
 *           with: { path: senshots-state.json, key: 'senshots-${{ github.run_id }}' }
 *
 * (Remove the backslash in the cron line - it is only there to keep this comment valid.)
 * Notes: GitHub cron can run a few minutes late, and pauses scheduled runs after
 * 60 days without repo activity - re-enable from the Actions tab if that happens.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.1';
const PAGE = 'https://sen-shots.cic-connect.co.uk/';
const TOPIC = process.env.NTFY_TOPIC || '';
const MATCH = /drills/i; // only Drills & Games, not the sensory sessions
const INTERVAL_MIN = Math.max(5, Number(process.env.INTERVAL_MIN || 10));
const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'senshots-state.json');
const ONCE = process.argv.includes('--once');
const TEST = process.argv.includes('--test');

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

// Flatten HTML to lines of text, keeping link targets as "HREF:" lines.
function flatten(html) {
  const withLinks = html
    .replace(/\s+/g, ' ') // headings can wrap across source lines
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>/gi, '\nHREF:$1\n')
    .replace(/<[^>]+>/g, '\n');
  return decode(withLinks)
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function parse(html) {
  const text = flatten(html);
  const heading = /^(.*Sen Shots.*?) on ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* \d{1,2}(?:st|nd|rd|th)? [A-Za-z]+)$/gim;
  const hits = [];
  let m;
  while ((m = heading.exec(text))) hits.push({ title: m[1].trim(), date: m[2].trim(), at: m.index });

  const sessions = new Map();
  hits.forEach((h, i) => {
    const block = text.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : text.length);
    const key = `${h.title} | ${h.date}`;
    if (sessions.has(key)) return;
    const idMatch = block.match(/\/session\/(\d+)\//);
    const spaces = block.match(/(\d+)\s+(?:spaces?|places?)\b/i);
    const full = /no spaces left|fully booked|sold out/i.test(block);
    const link = (block.match(/^HREF:(\S*\/session\/\d+\S*)$/m) || [])[1];
    sessions.set(key, {
      key,
      title: h.title,
      date: h.date,
      id: idMatch ? idMatch[1] : null,
      open: !full,
      spaces: spaces ? Number(spaces[1]) : null,
      link: link ? new URL(link, PAGE).href : PAGE,
    });
  });
  return [...sessions.values()];
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen: {}, warnedEmpty: false, first: true }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { console.error('Could not save state:', e.message); }
}

async function notify(title, message, click = PAGE, priority = 'high') {
  const line = `[${new Date().toISOString()}] ${title} - ${message}`;
  console.log(line);
  if (!TOPIC) return;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}`, {
      method: 'POST',
      body: message,
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ''), Click: click, Priority: priority },
    });
    if (!res.ok) console.error('ntfy error', res.status);
  } catch (e) {
    console.error('ntfy failed:', e.message);
  }
}

async function check() {
  let html;
  try {
    const res = await fetch(PAGE, {
      headers: { 'User-Agent': `senshots-watch/${VERSION} (personal availability alert)` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Fetch failed: ${e.message}`);
    return;
  }

  const state = loadState();
  const all = parse(html);
  const drills = all.filter(s => MATCH.test(s.title));

  if (!all.length) {
    if (!state.warnedEmpty) {
      await notify('SEN Shots watcher needs a look', 'Could not read any sessions - the page layout may have changed.', PAGE, 'default');
      state.warnedEmpty = true;
      saveState(state);
    }
    return;
  }
  state.warnedEmpty = false;

  for (const s of drills) {
    const prev = state.seen[s.key];
    const now = s.open ? 'open' : 'full';
    const spaceText = s.spaces != null ? `${s.spaces} space${s.spaces === 1 ? '' : 's'}` : 'Spaces';
    if (now === 'open' && prev !== 'open') {
      await notify(`SEN Shots: ${s.date} has space`, `${spaceText} available on Drills & Games ${s.date}. Tap to book.`, s.link, 'urgent');
    } else if (!prev && !state.first) {
      await notify(`SEN Shots: new date ${s.date}`, `New Drills & Games date posted (${now}). ${now === 'full' ? 'Join the waiting list.' : ''}`.trim(), s.link, 'default');
    }
    state.seen[s.key] = now;
  }
  state.first = false;
  saveState(state);

  console.log(`[${new Date().toISOString()}] Checked: ${drills.map(s => `${s.date}=${s.open ? 'OPEN' : 'full'}`).join(', ') || 'no Drills sessions listed'}`);
}

async function main() {
  console.log(`SEN Shots watcher v${VERSION}${TOPIC ? '' : ' (no NTFY_TOPIC set - console only)'}`);
  if (TEST) {
    await notify('SEN Shots watcher test', 'If you can see this, alerts are working.', PAGE, 'default');
    const res = await fetch(PAGE, { signal: AbortSignal.timeout(20000) });
    for (const s of parse(await res.text())) console.log(` - ${s.date}: ${s.title} -> ${s.open ? 'OPEN' : 'full'}`);
    return;
  }
  await check();
  if (ONCE) return;
  const loop = () => setTimeout(async () => { await check(); loop(); },
    (INTERVAL_MIN * 60 + Math.floor(Math.random() * 60)) * 1000);
  loop();
}

main();
