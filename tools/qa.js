#!/usr/bin/env node
// Athens UI QA harness.
// Deterministic DOM checks (ground truth) + optional vision-model pass.
// Usage: node qa.js [--vision] [--shot DIR]
// Requires the app running (default http://127.0.0.1:8317).
const { chromium } = require('/home/hermes/projects/macro-selfhost/node_modules/playwright-core');

const BASE = process.env.ATHENS_URL || 'http://127.0.0.1:8317';
const SHOT_DIR = process.env.ATHENS_SHOT_DIR || '/tmp/athens-qa';
const DO_VISION = process.argv.includes('--vision');

const fs = require('fs');

function contrast(hex1, hex2) {
  const lum = (h) => {
    const c = h.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const l1 = lum(hex1), l2 = lum(hex2);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const issues = [];
  const browser = await chromium.launch({
    executablePath: '/home/hermes/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  const check = (cond, tag, detail) => { if (!cond) issues.push({ tag, detail }); };

  // ---- home ----
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => ({
    bask: document.fonts.check('700 20px "Libre Baskerville"'),
    source: document.fonts.check('400 16px "Source Serif 4"'),
  }));
  check(fonts.bask && fonts.source, 'FONT', 'webfonts not loaded: ' + JSON.stringify(fonts));
  await page.screenshot({ path: SHOT_DIR + '/home.png', fullPage: true });

  // text overflow across all headings/paragraphs on home
  const homeOverflow = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('h1,h2,h3,p,.step-title,.step-summary,.ask-sub').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2)
        bad.push(el.className + ':' + el.textContent.slice(0, 25));
    });
    return bad;
  });
  check(homeOverflow.length === 0, 'OVERFLOW', 'home: ' + homeOverflow.join(', '));

  // contrast on key text
  const homeFg = await page.evaluate(() => {
    const out = {};
    for (const sel of ['.ask-title', '.ask-sub', '.navlink', '.btn-primary']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      out[sel] = getComputedStyle(el).color;
    }
    return out;
  });
  const homeContrast = [];
  for (const [sel, bg] of [['.ask-title', '#f6f0e6'], ['.ask-sub', '#f6f0e6'], ['.navlink', '#f6f0e6'], ['.btn-primary', '#b8552b']]) {
    if (!homeFg[sel]) continue;
    const m = homeFg[sel].match(/\d+/g);
    if (!m) continue;
    const hex = '#' + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
    const c = contrast(hex, bg);
    if (c < 4.5) homeContrast.push(sel + ' ' + c.toFixed(2));
  }
  check(homeContrast.length === 0, 'CONTRAST', 'home: ' + homeContrast.join(', '));

  // ---- lesson ----
  const nodes = await page.evaluate(() => fetch('/api/nodes').then((r) => r.json()));
  const root = nodes.nodes.find((n) => n.kind === 'root');
  if (root) {
    await page.goto(BASE + '/#/node/' + root.id, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: SHOT_DIR + '/intro.png' });

    // walk blocks until we hit a diagram module (structure is now flexible)
    for (let i = 0; i < 20; i++) {
      const hasDiagram = await page.evaluate(() => !!document.querySelector('.diagram-box svg, #diagram-box'));
      if (hasDiagram) break;
      const fwd = await page.$('#nav-fwd');
      if (!fwd) break;
      await fwd.click();
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1600);
    await page.screenshot({ path: SHOT_DIR + '/diagram.png' });

    // diagram label clipping
    const clip = await page.evaluate(() => {
      const svg = document.querySelector('.diagram-box svg');
      if (!svg) return 'no svg';
      return [...svg.querySelectorAll('.node')].filter((n) => {
        const rect = n.querySelector('rect');
        const label = n.querySelector('.nodeLabel');
        if (!rect || !label) return false;
        const rb = rect.getBoundingClientRect(), lb = label.getBoundingClientRect();
        return lb.width > rb.width + 2 || lb.height > rb.height + 2;
      }).map((n) => n.querySelector('.nodeLabel').textContent.slice(0, 20));
    });
    check(clip === 'no svg' || clip.length === 0, 'DIAGRAM', 'clipped labels: ' + JSON.stringify(clip));
  }

  // ---- map ----
  await page.goto(BASE + '/#/map', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.screenshot({ path: SHOT_DIR + '/map.png' });

  const map = await page.evaluate(() => {
    const svg = document.querySelector('#map-svg');
    if (!svg) return { error: 'no svg' };
    const circles = [...svg.querySelectorAll('.map-node circle')].map((c) => {
      const b = c.getBoundingClientRect();
      return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, r: b.width / 2 };
    });
    let overlaps = 0;
    for (let i = 0; i < circles.length; i++)
      for (let j = i + 1; j < circles.length; j++) {
        const dx = circles[i].cx - circles[j].cx;
        const dy = circles[i].cy - circles[j].cy;
        if (Math.hypot(dx, dy) < circles[i].r + circles[j].r - 4) overlaps++;
      }
    return { nodeCount: circles.length, overlaps };
  });
  check(map.error || map.overlaps === 0, 'MAP', 'overlaps: ' + JSON.stringify(map));

  // ---- vision pass (secondary, cross-checked) ----
  if (DO_VISION) {
    console.log('\n--- vision pass (llava:7b, low trust) ---');
    const { execSync } = require('child_process');
    try {
      const out = execSync(`python3 /tmp/vision_review.py ${SHOT_DIR}`, { encoding: 'utf8', timeout: 600000 });
      console.log(out);
    } catch (e) {
      console.log('vision pass failed:', e.message);
    }
  }

  await browser.close();
  console.log('\n===== QA RESULT =====');
  if (issues.length === 0) {
    console.log('PASS — no deterministic issues found.');
  } else {
    console.log(`${issues.length} issue(s):`);
    for (const i of issues) console.log(`  [${i.tag}] ${i.detail}`);
  }
  console.log('screenshots in', SHOT_DIR);
})();
