// Managing-Stocks Cloud Bot — roda no GitHub Actions (grátis) a cada ~10 min, 24/7,
// com o PC desligado. Notifica via Telegram. Mesma matemática do bot local/app/Pine.
// Sem dependências: Node 20 (fetch nativo). Estado em state.json (commitado de volta no repo).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('./config.json', 'utf8'));
const statePath = './state.json';
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
state.alerts = state.alerts || {}; state.rsiZone = state.rsiZone || {}; state.sigSeen = state.sigSeen || {}; state.siteDown = !!state.siteDown;

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
// Binance bloqueia IPs dos EUA (onde rodam os runners) — o espelho oficial de dados não:
const BINANCE = 'https://data-api.binance.vision';

const log = m => console.log(new Date().toISOString() + ' ' + m);

/* ---------- indicadores (idênticos ao bot local / app / Pine) ---------- */
function rsi(closes, len = 14) {
  if (closes.length < len + 2) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= len; i++) { const ch = closes[i] - closes[i - 1]; ag += Math.max(ch, 0); al += Math.max(-ch, 0); }
  ag /= len; al /= len;
  for (let i = len + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    ag = (ag * (len - 1) + Math.max(ch, 0)) / len;
    al = (al * (len - 1) + Math.max(-ch, 0)) / len;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function emaArr(src, len) {
  const k = 2 / (len + 1), out = new Array(src.length);
  let prev = src[0]; out[0] = prev;
  for (let i = 1; i < src.length; i++) { prev = src[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function smaArr(src, len) {
  const out = new Array(src.length).fill(null); let sum = 0;
  for (let i = 0; i < src.length; i++) { sum += src[i]; if (i >= len) sum -= src[i - len]; if (i >= len - 1) out[i] = sum / len; }
  return out;
}
function macdAdaptSignal(closes, lookback = 100, mult = 1.0) {
  if (closes.length < lookback + 30) return null;
  const eF = emaArr(closes, 12), eS = emaArr(closes, 26);
  const macd = closes.map((_, i) => eF[i] - eS[i]);
  const sig = emaArr(macd, 9);
  const n = closes.length - 1;
  let m = 0; for (let j = n - lookback + 1; j <= n; j++) m += macd[j]; m /= lookback;
  let v = 0; for (let j = n - lookback + 1; j <= n; j++) { const d = macd[j] - m; v += d * d; }
  const sd = Math.sqrt(v / lookback);
  const up = macd[n] > sig[n] && macd[n - 1] <= sig[n - 1];
  const dn = macd[n] < sig[n] && macd[n - 1] >= sig[n - 1];
  const zC = macd[n] > -sd * mult * 1.2 && macd[n] < -sd * mult * 0.3;
  const zV = macd[n] < sd * mult * 1.2 && macd[n] > sd * mult * 0.3;
  if (up && zC) return 'COMPRA';
  if (dn && zV) return 'VENDA';
  return null;
}
function hiloFlip(high, low, close, len = 34) {
  const hima = smaArr(high, len), loma = smaArr(low, len);
  const n = close.length; const trend = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (hima[i - 1] == null) continue;
    trend[i] = close[i] > hima[i - 1] ? 1 : close[i] < loma[i - 1] ? -1 : trend[i - 1];
  }
  if (trend[n - 1] !== trend[n - 2] && trend[n - 2] !== 0) return trend[n - 1] === 1 ? 'ALTA' : 'BAIXA';
  return null;
}

const pending = [];
function maybe(key, msg) {
  const cd = (cfg.rules.cooldownHours || 6) * 36e5;
  if (state.alerts[key] && Date.now() - state.alerts[key] < cd) return;
  state.alerts[key] = Date.now();
  pending.push(msg);
}
async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) { log('(sem Telegram configurado) ' + msg); return; }
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: '🔔 Managing-Stocks\n' + msg })
    });
  } catch (e) { log('telegram falhou: ' + e.message); }
}
const fmt = p => p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 1 ? p.toFixed(3) : p.toPrecision(4);

async function main() {
  /* ── 1. MAJORS: preço, RSI, gatilhos + sinais MACD adaptativo e HiLo ── */
  for (const sym of cfg.watch) {
    const nome = sym.replace('USDT', '');
    try {
      const t = await (await fetch(BINANCE + '/api/v3/ticker/24hr?symbol=' + sym)).json();
      const price = +t.lastPrice, chg = +t.priceChangePercent;
      if (Math.abs(chg) >= (cfg.rules.move24hPct || 5))
        maybe('move:' + sym + ':' + (chg > 0 ? 'up' : 'down'), nome + ' ' + (chg > 0 ? '▲' : '▼') + ' ' + chg.toFixed(2) + '% em 24h — $' + fmt(price));
      const k = await (await fetch(BINANCE + '/api/v3/klines?symbol=' + sym + '&interval=1h&limit=200')).json();
      if (Array.isArray(k) && k.length > 140) {
        k.pop();
        const closes = k.map(x => +x[4]), highs = k.map(x => +x[2]), lows = k.map(x => +x[3]);
        const lastBar = k[k.length - 1][0];
        const r = rsi(closes);
        if (r != null) {
          const zone = r < (cfg.rules.rsiLow || 30) ? 'low' : r > (cfg.rules.rsiHigh || 70) ? 'high' : 'mid';
          if (zone !== 'mid' && state.rsiZone[sym] !== zone)
            maybe('rsi:' + sym + ':' + zone, nome + ' RSI(1h) ' + r.toFixed(0) + ' — ' + (zone === 'low' ? 'SOBREVENDIDO: possível zona de compra' : 'SOBRECOMPRADO: cuidado ao comprar agora') + ' · $' + fmt(price));
          state.rsiZone[sym] = zone;
        }
        const ms = macdAdaptSignal(closes);
        if (ms && state.sigSeen['macd:' + sym] !== lastBar) {
          state.sigSeen['macd:' + sym] = lastBar;
          maybe('macdsig:' + sym + ':' + lastBar, '📈 SINAL ' + ms + ' (MACD adaptativo, 1h) em ' + nome + ' @ $' + fmt(price));
        }
        const hf = hiloFlip(highs, lows, closes);
        if (hf && state.sigSeen['hilo:' + sym] !== lastBar) {
          state.sigSeen['hilo:' + sym] = lastBar;
          maybe('hilosig:' + sym + ':' + lastBar, '🔄 ' + nome + ' virou tendência de ' + hf + ' (HiLo 34, 1h) @ $' + fmt(price));
        }
      }
      for (const pa of (cfg.rules.priceAlerts || [])) {
        if (pa.symbol !== sym) continue;
        if (pa.above && price >= pa.above) maybe('pxa:' + sym + ':' + pa.above, nome + ' cruzou ACIMA de $' + fmt(pa.above) + ' → $' + fmt(price));
        if (pa.below && price <= pa.below) maybe('pxb:' + sym + ':' + pa.below, nome + ' cruzou ABAIXO de $' + fmt(pa.below) + ' → $' + fmt(price));
      }
    } catch (e) { log('erro ' + sym + ': ' + e.message); }
  }

  /* ── 2. MEMECOINS (DexScreener): fixas do config + as que você adiciona no app (coins.json, sincronizado) ── */
  let extra = [];
  try { if (existsSync('./coins.json')) extra = JSON.parse(readFileSync('./coins.json', 'utf8')); } catch (e) {}
  const seenAddr = new Set();
  const allMemes = [...(cfg.memecoins || []), ...extra].filter(m => m && m.addr && !seenAddr.has(m.addr.toLowerCase()) && seenAddr.add(m.addr.toLowerCase()));
  for (const mc of allMemes) {
    try {
      const ds = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mc.addr)).json();
      const p = (ds.pairs || []).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
      if (!p) continue;
      const h1 = p.priceChange ? +p.priceChange.h1 : null;
      const h24 = p.priceChange ? +p.priceChange.h24 : null;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const px = +p.priceUsd || 0;
      if (h1 != null && Math.abs(h1) >= (cfg.rules.meme1hPct || 10))
        maybe('m1h:' + mc.sym + ':' + (h1 > 0 ? 'u' : 'd'), '🚀 ' + mc.sym + ' ' + (h1 > 0 ? '▲' : '▼') + ' ' + h1.toFixed(1) + '% na ÚLTIMA HORA — $' + fmt(px));
      if (h24 != null && Math.abs(h24) >= (cfg.rules.meme24hPct || 25))
        maybe('m24:' + mc.sym + ':' + (h24 > 0 ? 'u' : 'd'), '🚀 ' + mc.sym + ' ' + (h24 > 0 ? '▲' : '▼') + ' ' + h24.toFixed(0) + '% em 24h — $' + fmt(px));
      if (liq > 0 && liq < (cfg.rules.memeLiqMin || 20000))
        maybe('mliq:' + mc.sym, '⚠️ ANTI-RUG: liquidez de ' + mc.sym + ' caiu para $' + Math.round(liq / 1000) + 'K — risco alto de rug, avalie sair');
    } catch (e) { log('erro meme ' + mc.sym + ': ' + e.message); }
  }

  /* ── 2b. TRADERS SEGUIDOS (Solana on-chain): compra/venda de memecoin → Telegram ── */
  const RPC = 'https://solana-rpc.publicnode.com';
  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()).result;
  };
  const WSOL = 'So11111111111111111111111111111111111111112';
  state.wallSig = state.wallSig || {};
  state.buys = (state.buys || []).filter(b => Date.now() - b.ts < 24 * 36e5);   // histórico de 24h p/ convergência + resumo
  const CONV_WIN = 60 * 60e3;   // janela de convergência: 1h
  const LIQ_RISK = cfg.rules.memeLiqMin || 20000;
  for (const w of (cfg.wallets || [])) {
    try {
      const sigs = (await rpc('getSignaturesForAddress', [w.addr, { limit: 15 }])) || [];
      if (!sigs.length) continue;
      const lastSeen = state.wallSig[w.addr];
      state.wallSig[w.addr] = sigs[0].signature;
      if (!lastSeen) { log('carteira ' + w.name + ': baseline registrada'); continue; }  // 1ª vez: só marca o ponto
      const novas = [];
      for (const s of sigs) { if (s.signature === lastSeen) break; if (!s.err) novas.push(s); }   // ignora txs que falharam (spam de bots)
      const WMIN = cfg.rules.walletMinUsd || 500;
      for (const s of novas.reverse().slice(-3)) {   // no máx 3 por carteira/ciclo (protege o RPC com 10 traders ativos)
        try {
          const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
          if (!tx || !tx.meta) continue;
          const delta = {};
          for (const b of (tx.meta.postTokenBalances || [])) if (b.owner === w.addr) delta[b.mint] = (delta[b.mint] || 0) + (+b.uiTokenAmount.uiAmount || 0);
          for (const b of (tx.meta.preTokenBalances || []))  if (b.owner === w.addr) delta[b.mint] = (delta[b.mint] || 0) - (+b.uiTokenAmount.uiAmount || 0);
          const mints = Object.entries(delta).filter(([m, d]) => Math.abs(d) > 1e-9 && m !== WSOL).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
          if (!mints.length) continue;   // sem swap identificável → ignora (nada de "movimentou" genérico)
          const [mint, d] = mints[0];
          let symTok = mint.slice(0, 6) + '…', usd = null, liq = null, rugTag = '';
          try {
            const ds = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint)).json();
            const p = (ds.pairs || []).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
            if (p) {
              symTok = '$' + p.baseToken.symbol;
              usd = p.priceUsd ? Math.abs(d) * (+p.priceUsd) : null;
              liq = (p.liquidity && p.liquidity.usd) || 0;
              // #4 anti-rug no copy-trade: marca compra em token de liquidez baixa
              if (d > 0 && liq > 0 && liq < LIQ_RISK) rugTag = ' ⚠️ liq $' + Math.round(liq / 1000) + 'K (risco)';
            }
          } catch (e) {}
          // #2 registra COMPRAS para detectar convergência (vários traders no mesmo token)
          if (d > 0) state.buys.push({ mint, sym: symTok, name: w.name, ts: Date.now(), usd: usd || 0, liq: liq || 0 });
          if (usd != null && usd < WMIN) continue;   // abaixo do limiar → não notifica (corta a enxurrada)
          pending.push('🐐 ' + w.name + ' ' + (d > 0 ? 'COMPROU' : 'VENDEU') + ' ' + symTok + (usd != null ? ' (~$' + usd.toLocaleString('en-US', { maximumFractionDigits: usd >= 100 ? 0 : 2 }) + ')' : '') + rugTag + '\nsolscan.io/tx/' + s.signature);
        } catch (e) { log('tx parse ' + w.name + ': ' + e.message); }
      }
    } catch (e) { log('carteira ' + w.name + ': ' + e.message); }
  }

  /* ── 2c. CONVERGÊNCIA: 2+ traders comprando o MESMO token em ≤1h (o sinal de ouro) ── */
  const byMint = {};
  for (const b of state.buys) { if (Date.now() - b.ts > CONV_WIN) continue; (byMint[b.mint] = byMint[b.mint] || []).push(b); }
  for (const [mint, arr] of Object.entries(byMint)) {
    const names = [...new Set(arr.map(b => b.name.replace(/ #\d+$/, '')))];
    if (names.length >= (cfg.rules.convMin || 2)) {
      const sym = arr[0].sym, totUsd = arr.reduce((s, b) => s + (b.usd || 0), 0);
      maybe('conv:' + mint + ':' + names.length, '🔥🔥 CONVERGÊNCIA: ' + names.length + ' traders TOP compraram ' + sym + ' na última hora!\n(' + names.join(', ') + ')' + (totUsd ? ' · ~$' + Math.round(totUsd).toLocaleString('en-US') + ' no total' : '') + '\nsinal forte — mas confirme liquidez antes\ndexscreener.com/solana/' + mint);
    }
  }

  /* ── 2d. RESUMO DIÁRIO (uma vez por dia, na janela configurada) ── */
  const nowH = new Date().getUTCHours();
  const today = new Date().toISOString().slice(0, 10);
  if (nowH === (cfg.rules.digestHourUTC ?? 21) && state.lastDigest !== today) {
    state.lastDigest = today;
    const lines = ['📋 RESUMO DIÁRIO — Managing-Stocks', ''];
    // top tokens comprados pelos traders nas últimas 24h
    const agg = {};
    for (const b of state.buys) { const k = b.mint; (agg[k] = agg[k] || { sym: b.sym, buyers: new Set(), usd: 0 }); agg[k].buyers.add(b.name.replace(/ #\d+$/, '')); agg[k].usd += b.usd || 0; }
    const top = Object.values(agg).sort((a, b) => b.buyers.size - a.buyers.size || b.usd - a.usd).slice(0, 5);
    lines.push('🐐 Mais comprados pelos seus traders (24h):');
    if (top.length) for (const t of top) lines.push('  • ' + t.sym + ' — ' + t.buyers.size + ' trader(s)' + (t.usd ? ', ~$' + Math.round(t.usd).toLocaleString('en-US') : ''));
    else lines.push('  (sem compras rastreadas nas últimas 24h)');
    // memecoins que mais moveram
    lines.push('', '🚀 Suas memecoins (24h):');
    const movers = [];
    for (const mc of allMemes) {
      try {
        const ds = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mc.addr)).json();
        const p = (ds.pairs || []).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
        if (p && p.priceChange) movers.push({ sym: mc.sym, h24: +p.priceChange.h24 });
      } catch (e) {}
    }
    movers.sort((a, b) => Math.abs(b.h24) - Math.abs(a.h24));
    for (const m of movers.slice(0, 6)) lines.push('  • ' + m.sym + ' ' + (m.h24 >= 0 ? '▲ +' : '▼ ') + m.h24.toFixed(0) + '%');
    // majors
    lines.push('', '📊 Majors (24h):');
    for (const sym of cfg.watch.slice(0, 4)) {
      try { const t = await (await fetch(BINANCE + '/api/v3/ticker/24hr?symbol=' + sym)).json(); const c = +t.priceChangePercent; lines.push('  • ' + sym.replace('USDT', '') + ' ' + (c >= 0 ? '▲ +' : '▼ ') + c.toFixed(1) + '% · $' + fmt(+t.lastPrice)); } catch (e) {}
    }
    await sendTelegram(lines.join('\n'));
    log('resumo diário enviado');
  }

  /* ── 3. saúde da plataforma ── */
  if (cfg.siteCheck) {
    try {
      const r = await fetch(cfg.siteCheck, { method: 'HEAD' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (state.siteDown) { state.siteDown = false; maybe('site:up', 'Plataforma voltou ao ar ✓'); }
    } catch (e) {
      if (!state.siteDown) { state.siteDown = true; maybe('site:down', 'Plataforma fora do ar: ' + e.message); }
    }
  }

  for (const m of pending) await sendTelegram(m);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  log('ciclo ok — ' + pending.length + ' alerta(s)');
}
main().catch(e => { log('falha geral: ' + e.message); process.exit(0); });
