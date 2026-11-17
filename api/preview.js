/* Lê a página de um produto e devolve nome, preço e foto.
   O site chama: /api/preview?url=https://...  */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const dec = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

function meta(html, keys) {
  for (const k of keys) {
    const a = new RegExp('<meta[^>]+(?:property|name|itemprop)=["\']' + k + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
    const b = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name|itemprop)=["\']' + k + '["\']', 'i');
    const m = html.match(a) || html.match(b);
    if (m && m[1].trim()) return dec(m[1]);
  }
  return '';
}

function toNum(s) {
  if (s == null) return null;
  s = String(s).replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) && n > 0 && n < 1e7 ? n : null;
}

function jsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const walk = x => {
        if (!x) return;
        if (Array.isArray(x)) return x.forEach(walk);
        if (typeof x === 'object') {
          const t = [].concat(x['@type'] || []).join(',');
          if (/Product/i.test(t)) out.push(x);
          if (x['@graph']) walk(x['@graph']);
        }
      };
      walk(JSON.parse(m[1]));
    } catch (e) { /* ignora */ }
  }
  return out;
}

const GENERIC = /^(shopee|mercado ?livre|amazon|robot|just a moment|acesso negado|access denied|verifica|captcha|página não encontrada)/i;

function clean(t) {
  t = dec(t).replace(/\s+/g, ' ');
  t = t.replace(/^Amazon\.com\.br\s*:\s*/i, '').replace(/\s*:\s*Amazon\.com\.br.*$/i, '')
       .replace(/\s*[|–-]\s*(Shopee.*|Mercado ?Livre.*|Magazine ?Luiza.*|Casas ?Bahia.*)$/i, '')
       .replace(/\s*\|\s*[^|]+$/, m => (m.length < 40 ? '' : m));
  t = t.trim();
  if (t.length > 90) t = t.slice(0, 90).replace(/\s+\S*$/, '') + '…';
  return t;
}

function parse(html, url) {
  const r = { name: '', price: null, image: '' };
  const host = new URL(url).hostname;

  // 1) dados estruturados (a maioria das lojas)
  for (const p of jsonLd(html)) {
    if (!r.name && p.name) r.name = String(p.name);
    if (!r.image && p.image) r.image = [].concat(p.image).map(i => (typeof i === 'string' ? i : i && i.url)).filter(Boolean)[0] || '';
    if (r.price == null && p.offers) {
      const o = [].concat(p.offers)[0] || {};
      r.price = toNum(o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : (o.priceSpecification && o.priceSpecification.price)));
    }
  }

  // 2) Amazon
  if (/amazon\./i.test(host)) {
    const t = html.match(/id=["']productTitle["'][^>]*>\s*([^<]+)/i);
    if (t) r.name = dec(t[1]);
    const img = html.match(/id=["']landingImage["'][^>]*data-old-hires=["']([^"']+)["']/i)
      || html.match(/data-a-dynamic-image=["']\{&quot;([^&]+)&quot;/i)
      || html.match(/data-a-dynamic-image=["']\{"([^"]+)"/i);
    if (img) r.image = dec(img[1]);
    if (r.price == null) {
      const pr = html.match(/class=["']a-offscreen["'][^>]*>\s*R\$(?:\s|&nbsp;)*([\d.,]+)/i)
        || html.match(/class=["']a-price-whole["'][^>]*>\s*([\d.]+)[^<]*<[^>]*>\s*,?\s*<\/span>\s*<span[^>]*class=["']a-price-fraction["'][^>]*>(\d+)/i);
      if (pr) r.price = toNum(pr[2] ? pr[1] + ',' + pr[2] : pr[1]);
    }
  }

  // 3) etiquetas og: / product:
  if (!r.name) r.name = meta(html, ['og:title', 'twitter:title']) || ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '');
  if (!r.image) r.image = meta(html, ['og:image', 'og:image:secure_url', 'twitter:image']);
  if (r.price == null) r.price = toNum(meta(html, ['product:price:amount', 'og:price:amount', 'price']));

  r.name = clean(r.name);
  if (GENERIC.test(r.name) && r.name.length < 40) r.name = '';
  if (r.image && r.image.startsWith('//')) r.image = 'https:' + r.image;
  if (r.image && r.image.startsWith('/')) r.image = new URL(r.image, url).href;
  if (r.image && !/^https?:\/\//i.test(r.image)) r.image = '';
  return r;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  try {
    let u;
    try { u = new URL(String((req.query && req.query.url) || '')); } catch (e) { return res.status(200).json({ ok: false, error: 'Link inválido' }); }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':'))
      return res.status(200).json({ ok: false, error: 'Link inválido' });

    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(u.href, {
      redirect: 'follow', signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5' }
    });
    clearTimeout(to);
    const html = (await r.text()).slice(0, 2500000);
    const d = parse(html, r.url || u.href);
    if (!d.name && !d.image && d.price == null)
      return res.status(200).json({ ok: false, error: r.ok ? 'Esse site não deixou eu ler a página' : 'O site bloqueou a leitura (' + r.status + ')' });
    return res.status(200).json({ ok: true, ...d });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.name === 'AbortError' ? 'O site demorou demais' : 'Não consegui abrir esse link' });
  }
}

module.exports = handler;
module.exports.parse = parse;
