/** Static dev phone page (served at /dev/phone). Script is a separate file so the default CSP (script-src 'self') applies. */
export const PHONE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev phone · SMS simulator</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; }
  body { margin: 0; background: #f2f2f7; }
  header { padding: 12px 16px; background: #fff; border-bottom: 1px solid #ddd; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 17px; margin: 0; } .warn { font-size: 12px; color: #8a5a00; background: #fff4d6; padding: 2px 8px; border-radius: 99px; }
  main { display: grid; grid-template-columns: 260px 1fr; gap: 0; height: calc(100vh - 50px); }
  #numbers { background: #fff; border-right: 1px solid #ddd; overflow: auto; margin: 0; padding: 0; list-style: none; }
  #numbers button { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 10px 14px; border-bottom: 1px solid #eee; cursor: pointer; }
  #numbers button[aria-current="true"] { background: #e8f0fe; } #numbers small { display: block; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #phone { display: flex; flex-direction: column; min-width: 0; }
  #thread { flex: 1; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
  .b { max-width: 70%; padding: 8px 12px; border-radius: 18px; white-space: pre-wrap; word-wrap: break-word; font-size: 15px; }
  .in { align-self: flex-start; background: #e5e5ea; } .out { align-self: flex-end; background: #34c759; color: #fff; }
  .in.auto { background: #d9d9de; font-style: italic; } .t { font-size: 11px; color: #888; align-self: center; }
  form { display: flex; gap: 6px; padding: 10px; background: #fff; border-top: 1px solid #ddd; flex-wrap: wrap; }
  input, textarea { font: inherit; padding: 8px 10px; border: 1px solid #ccc; border-radius: 18px; }
  #msg { flex: 1; min-width: 160px; } button.k, form button { font: inherit; border: 0; border-radius: 16px; padding: 7px 12px; background: #e5e5ea; cursor: pointer; }
  form button[type=submit] { background: #0a84ff; color: #fff; } .empty { color: #666; padding: 24px; }
  details { background: #fff; border-top: 1px solid #ddd; padding: 8px 12px; } details form { border: 0; padding: 8px 0; flex-direction: column; align-items: stretch; }
  details textarea { border-radius: 10px; min-height: 60px; } #emailResult, #status { font-size: 13px; color: #555; }
</style></head>
<body>
<header><h1>📱 Dev phone</h1><span class="warn">Local SMS simulator. Nothing is sent to real phones.</span><span id="status"></span></header>
<main>
  <ul id="numbers" aria-label="Phone numbers"></ul>
  <section id="phone" aria-label="Conversation">
    <div id="thread" aria-live="polite"><p class="empty">Send a text from the outreach deck (SMS channel) and it shows up here.</p></div>
    <form id="reply">
      <input id="from" aria-label="Customer phone (E.164)" placeholder="+15551234567" size="14" required>
      <input id="msg" aria-label="Reply" placeholder="Type a reply as the customer…" required>
      <button type="submit">Send</button>
      <button type="button" class="k" data-k="STOP">STOP</button><button type="button" class="k" data-k="START">START</button>
      <button type="button" class="k" data-k="JOIN">JOIN</button><button type="button" class="k" data-k="HELP">HELP</button>
    </form>
    <details><summary>Simulate an email reply (no inbound email provider needed)</summary>
      <form id="email">
        <input id="eto" aria-label="Reply-To address" placeholder="reply+…@reply.localhost (copy it from the email in Mailpit)" required>
        <input id="efrom" aria-label="Customer email" placeholder="customer@example.com (the address you emailed)" required>
        <textarea id="etext" aria-label="Reply text" placeholder="Reply text" required></textarea>
        <button type="submit">Deliver reply to the Replies inbox</button><span id="emailResult" role="status"></span>
      </form>
    </details>
  </section>
</main>
<script src="/dev/phone.js"></script>
</body></html>`;

export const PHONE_JS = `(() => {
  const $ = id => document.getElementById(id);
  let threads = [], current = null;
  const api = (p, body) => fetch('/api/dev/sim/' + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}).then(async r => {
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function render() {
    const ul = $('numbers'); ul.replaceChildren();
    for (const t of threads) {
      const li = el('li'), b = el('button'); b.type = 'button'; b.setAttribute('aria-current', String(t.phone === current));
      b.append(el('strong', '', t.phone), el('small', '', (t.messages.at(-1) || {}).body || ''));
      b.onclick = () => { current = t.phone; $('from').value = t.phone; render(); };
      li.append(b); ul.append(li);
    }
    const box = $('thread'), t = threads.find(x => x.phone === current);
    if (!t) return;
    box.replaceChildren();
    // Store texts are "inbound" to this phone (grey, left); the customer's replies are "outbound" from it (green, right).
    for (const m of t.messages) {
      box.append(el('div', 'b ' + (m.direction === 'outbound' ? 'in' : 'out') + (m.auto ? ' auto' : ''), m.body));
      box.append(el('div', 't', new Date(m.at).toLocaleTimeString()));
    }
    box.scrollTop = box.scrollHeight;
  }
  async function refresh() {
    try { threads = (await api('threads')).threads; if (!current && threads[0]) { current = threads[0].phone; $('from').value = current; } render(); }
    catch (e) { $('status').textContent = 'Error: ' + e.message; }
  }
  async function reply(body) {
    const from = $('from').value.trim(); if (!from || !body) return;
    try { const r = await api('sms-reply', { from, body }); current = from; $('status').textContent = r.status === 200 ? '' : 'Webhook returned HTTP ' + r.status; }
    catch (e) { $('status').textContent = 'Error: ' + e.message; }
    await refresh();
  }
  $('reply').onsubmit = e => { e.preventDefault(); const v = $('msg').value.trim(); $('msg').value = ''; reply(v); };
  for (const b of document.querySelectorAll('button.k')) b.onclick = () => reply(b.dataset.k);
  $('email').onsubmit = async e => {
    e.preventDefault();
    try { const r = await api('email-reply', { to: $('eto').value.trim(), from: $('efrom').value.trim(), text: $('etext').value });
      $('emailResult').textContent = r.matched ? 'Delivered: open Replies in the app.' : 'Not matched: check the Reply-To address and that From is the address you emailed.'; }
    catch (err) { $('emailResult').textContent = 'Error: ' + err.message; }
  };
  api('status').then(s => { if (s.smsProvider !== 'simulator') $('status').textContent = 'SMS_PROVIDER=' + s.smsProvider + ': set SMS_PROVIDER=simulator to see texts here.'; }).catch(() => {});
  refresh(); setInterval(refresh, 3000);
})();`;
