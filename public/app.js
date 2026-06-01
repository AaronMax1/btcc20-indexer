const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });
const pctFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const TOKEN_META = {
  cord: { name: 'Classic Ordinal' },
};

let lastData = null;
let currentPage = localStorage.getItem('btcc20-page') || 'tokens';

const short = value => {
  const text = String(value || '');
  return text.length > 24 ? `${text.slice(0, 12)}...${text.slice(-10)}` : text;
};

function tokenMeta(tick) {
  return TOKEN_META[String(tick || '').toLowerCase()] || {};
}

function asBigInt(raw) {
  if (raw === null || raw === undefined || raw === '') return 0n;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return BigInt(Math.trunc(raw));
  return BigInt(String(raw));
}

function amount(raw, dec = 18) {
  const scale = 10n ** BigInt(dec);
  const value = asBigInt(raw);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(dec, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}

function decimalToRaw(value, dec = 18) {
  const text = String(value || '').trim();
  if (!text) return 0n;
  const [whole, frac = ''] = text.split('.');
  const scale = 10n ** BigInt(dec);
  const fracText = frac.slice(0, dec).padEnd(dec, '0');
  return BigInt(whole || '0') * scale + BigInt(fracText || '0');
}

function decimalMultiply(left, right) {
  const scale = 10n ** 18n;
  const product = decimalToRaw(left, 18) * decimalToRaw(right, 18) / scale;
  const whole = product / scale;
  const frac = (product % scale).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}

function countFromLimit(totalRaw, limitRaw) {
  const total = asBigInt(totalRaw);
  const limit = asBigInt(limitRaw);
  if (!limit) return '--';
  const whole = total / limit;
  const remainder = total % limit;
  return remainder ? `${whole}+` : fmt.format(Number(whole));
}

function rawAdd(left, right) {
  return asBigInt(left) + asBigInt(right);
}

function ratio(part, total) {
  const p = Number(part);
  const t = Number(total || 0);
  if (!t) return 0;
  return Math.max(0, Math.min(100, p / t * 100));
}

async function get(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `${path} ${res.status}`);
  return data;
}

function shellQuote(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function eventOp(event) {
  return event.payload?.operation?.op || 'spend';
}

function activityType(event) {
  const op = eventOp(event);
  if (op === 'spend') return 'transfer';
  if (op === 'transfer') return 'transfer_inscription';
  return op;
}

function activityLabel(type) {
  return {
    deploy: 'Deploy',
    mint: 'Mint',
    transfer: 'Transfer',
    transfer_inscription: 'Transfer Inscription',
  }[type] || type;
}

function buildHolderRows(data) {
  const rows = [];
  for (const [tick, holders] of Object.entries(data.ledger.balances || {})) {
    const token = data.ledger.tokens[tick] || {};
    const dec = token.dec ?? 18;
    for (const [address, balance] of Object.entries(holders)) {
      const available = asBigInt(balance.available);
      const transferable = asBigInt(balance.transferable);
      rows.push({
        tick,
        address,
        available,
        transferable,
        total: available + transferable,
        dec,
        minted: asBigInt(token.minted || 0),
      });
    }
  }
  return rows;
}

function renderSummary(data, holders) {
  const tokens = Object.values(data.ledger.tokens || {});
  const events = data.events || [];
  const validEvents = events.filter(e => e.valid).length;
  const indexText = data.index
    ? `${data.end_height}/${data.index.tip ?? data.end_height}`
    : data.end_height;
  $('range').textContent = `height ${data.start_height} - ${data.end_height}`;
  $('updated').textContent = new Date().toLocaleString();
  $('summary').innerHTML = [
    ['Token', tokens.length],
    ['有效活动', validEvents],
    ['持仓地址', holders.length],
    ['索引高度', indexText],
  ].map(([k, v]) => `<div class="card"><span>${k}</span><strong>${typeof v === 'number' ? fmt.format(v) : v}</strong></div>`).join('');
}

function renderAnalysis(data, holders) {
  const events = data.events || [];
  const latest = events.at(-1);
  const tokens = Object.values(data.ledger.tokens || {});
  const opCounts = events.reduce((acc, event) => {
    const type = activityType(event);
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const invalid = events.filter(e => !e.valid);
  const mintedSupply = tokens
    .map(token => `${tokenMeta(token.tick).name || token.tick.toUpperCase()} ${amount(token.minted, token.dec ?? 18)}`)
    .join(' · ') || '--';
  const syncText = data.index?.synced ? '已同步' : '同步中';
  $('analysis').innerHTML = [
    ['最新活动', latest ? `${activityLabel(activityType(latest))} @ ${latest.height}` : '--', latest ? short(latest.txid) : '暂无活动'],
    ['已铸造供应', mintedSupply, tokens.length ? '按 token deploy 精度格式化' : '暂无 token'],
    ['活动结构', `D ${opCounts.deploy || 0} · M ${opCounts.mint || 0} · T ${opCounts.transfer || 0}`, 'deploy / mint / transfer'],
    ['索引状态', syncText, data.index ? `tip ${data.index.tip} · reorg depth ${data.index.reorg_check_depth}` : '本地索引服务'],
    ['异常事件', invalid.length, invalid[0]?.reason || '当前扫描范围未发现无效铭文'],
  ].map(([k, v, s]) => `<div class="analysis-item"><span>${k}</span><strong>${v}</strong><span>${s}</span></div>`).join('');
}

function renderTokens(data) {
  const tokens = Object.values(data.ledger.tokens || {});
  $('token-grid').innerHTML = tokens.map(t => {
    const pct = ratio(t.minted, t.max);
    const totalCount = countFromLimit(t.max, t.lim);
    const mintedCount = countFromLimit(t.minted, t.lim);
    const meta = tokenMeta(t.tick);
    return `<div class="card token-card">
      <div class="token-top">
        <div class="token-title">
          <div>
            <strong class="token-symbol">${t.tick.toUpperCase()}</strong>
            ${meta.name ? `<span class="token-name">${meta.name}</span>` : ''}
          </div>
          <span class="token-dec">dec ${t.dec}</span>
        </div>
        <div class="token-supply">
          <strong>${amount(t.minted, t.dec)}</strong>
          <span>of ${amount(t.max, t.dec)} minted · ${pctFmt.format(pct)}%</span>
        </div>
        <div class="meter" aria-label="mint progress"><i style="--value:${pct}%"></i></div>
      </div>
      <div class="token-stats">
        <div><span>总张数</span><strong>${totalCount}</strong></div>
        <div><span>已铸张数</span><strong>${mintedCount}</strong></div>
        <div><span>每张数量</span><strong>${amount(t.lim, t.dec)}</strong></div>
        <div><span>Holders</span><strong>${Object.keys(data.ledger.balances?.[t.tick] || {}).length}</strong></div>
        <div><span>Deployer</span><strong class="mono" title="${t.deployer}">${short(t.deployer)}</strong></div>
      </div>
    </div>`;
  }).join('') || '<div class="panel empty">暂无 token</div>';
}

function renderHolders(data, holders) {
  const q = $('holder-search').value.trim().toLowerCase();
  const [sortKey, dir] = $('holder-sort').value.split('-');
  const direction = dir === 'asc' ? 1 : -1;
  const visible = holders
    .filter(row => !q || row.tick.includes(q) || row.address.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sortKey === 'address') return a.address.localeCompare(b.address) * direction;
      return Number((b[sortKey] || 0n) - (a[sortKey] || 0n)) * (dir === 'desc' ? 1 : -1);
    });

  $('holders-body').innerHTML = visible.map(row => {
    const pct = row.minted ? ratio(row.total, row.minted) : 0;
    const meta = tokenMeta(row.tick);
    return `<tr>
      <td><div class="ticker-cell"><span class="badge">${row.tick.toUpperCase()}</span>${meta.name ? `<span>${meta.name}</span>` : ''}</div></td>
      <td><code class="full-address" title="${row.address}">${row.address}</code></td>
      <td class="num">${amount(row.available, row.dec)}</td>
      <td class="num">${amount(row.transferable, row.dec)}</td>
      <td class="num"><strong>${amount(row.total, row.dec)}</strong></td>
      <td class="num">${pctFmt.format(pct)}%</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">没有匹配的持仓</td></tr>';
}

function renderEvents(data) {
  const filter = $('event-filter').value;
  const events = (data.events || []).slice().reverse().filter(event => {
    if (filter === 'all') return true;
    if (filter === 'invalid') return !event.valid;
    return activityType(event) === filter;
  });

  $('events-body').innerHTML = events.map(e => {
    const op = eventOp(e);
    const type = activityType(e);
    const spentTransfer = op === 'spend' ? data.ledger.transfers?.[e.inscription] : null;
    const tick = e.payload?.operation?.tick || spentTransfer?.tick || '';
    const token = tick ? data.ledger.tokens?.[tick] : null;
    const dec = token?.dec ?? 18;
    const rawAmt = e.payload?.operation?.amt || e.payload?.operation?.max || null;
    const qty = spentTransfer
      ? amount(spentTransfer.amount, dec)
      : rawAmt || '--';
    const from = spentTransfer?.owner || (type === 'transfer_inscription' ? e.owner : '--');
    const to = type === 'transfer' ? e.owner : e.owner || '--';
    return `<tr>
      <td class="mono">${e.height}</td>
      <td><span class="badge">${activityLabel(type)}</span></td>
      <td>${tick ? tick.toUpperCase() : '--'}</td>
      <td>${qty}</td>
      <td><code title="${from}">${short(from)}</code></td>
      <td><code title="${to}">${short(to)}</code></td>
      <td><code title="${e.txid || ''}">${short(e.txid)}</code></td>
      <td class="${e.valid ? 'ok' : 'bad'}">${e.valid ? '有效' : e.reason}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">没有匹配的活动</td></tr>';
}

function render(data) {
  lastData = data;
  const holders = buildHolderRows(data);
  renderSummary(data, holders);
  renderAnalysis(data, holders);
  renderTokens(data);
  renderHolders(data, holders);
  renderEvents(data);
}

function setPage(page) {
  currentPage = page;
  localStorage.setItem('btcc20-page', page);
  document.querySelectorAll('[data-page]').forEach(section => {
    section.hidden = section.dataset.page !== page;
  });
  document.querySelectorAll('[data-page-target]').forEach(button => {
    button.classList.toggle('active', button.dataset.pageTarget === page);
  });
}

async function refresh() {
  $('status').textContent = '扫描中';
  const data = await get('/api/scan');
  render(data);
  $('status').textContent = `最新 ${new Date().toLocaleTimeString()}`;
}

$('refresh').onclick = () => refresh().catch(err => $('status').textContent = err.message);

document.querySelectorAll('[data-page-target]').forEach(button => {
  button.addEventListener('click', () => setPage(button.dataset.pageTarget));
});

function selectedOp() {
  return document.querySelector('input[name="op"]:checked').value;
}

function syncInscribeFields() {
  const op = selectedOp();
  document.querySelectorAll('.deploy-field').forEach(field => {
    field.hidden = op !== 'deploy';
  });
  document.querySelectorAll('.amount-field').forEach(field => {
    field.hidden = op === 'deploy';
  });
  renderPayloadPreview();
}

function syncDeployMax() {
  const form = $('inscribe-form');
  const count = form.elements.mint_count?.value || '';
  const limit = form.elements.lim?.value || '';
  if (form.elements.max) {
    form.elements.max.value = decimalMultiply(count, limit);
  }
}

function currentInscribePayload() {
  const form = new FormData($('inscribe-form'));
  const op = selectedOp();
  const payload = {
    p: 'btcc-20',
    op,
    tick: String(form.get('tick') || '').trim(),
  };
  if (op === 'deploy') {
    payload.max = String(form.get('max') || '').trim();
    payload.lim = String(form.get('lim') || '').trim();
    payload.dec = String(form.get('dec') || '').trim();
  } else {
    payload.amt = String(form.get('amt') || '').trim();
  }
  return payload;
}

function renderPayloadPreview() {
  $('payload-preview').textContent = JSON.stringify(currentInscribePayload(), null, 2);
}

function currentInscribeCommand() {
  const form = new FormData($('inscribe-form'));
  const op = selectedOp();
  const wallet = String(form.get('wallet') || 'btcc20').trim();
  const tick = String(form.get('tick') || '').trim();
  const args = ['btcc20-inscriber', 'inscribe', '--wallet', wallet, op, '--tick', tick];
  if (op === 'deploy') {
    args.push('--max', String(form.get('max') || '').trim());
    args.push('--lim', String(form.get('lim') || '').trim());
    const dec = String(form.get('dec') || '').trim();
    if (dec) args.push('--dec', dec);
  } else {
    args.push('--amt', String(form.get('amt') || '').trim());
  }
  const destination = String(form.get('destination') || '').trim();
  if (destination) args.push('--destination', destination);
  return args.map(shellQuote).join(' ');
}

$('inscribe-form').addEventListener('change', syncInscribeFields);
$('inscribe-form').addEventListener('input', () => {
  syncDeployMax();
  renderPayloadPreview();
});
$('inscribe-form').addEventListener('submit', async event => {
  event.preventDefault();
  syncDeployMax();
  $('inscribe-result').textContent = currentInscribeCommand();
  $('inscribe-result').hidden = false;
  $('inscribe-status').textContent = '已生成，本地执行';
});

$('holder-search').addEventListener('input', () => lastData && render(lastData));
$('holder-sort').addEventListener('change', () => lastData && render(lastData));
$('event-filter').addEventListener('change', () => lastData && render(lastData));

refresh().catch(err => $('status').textContent = err.message);
setPage(currentPage);
syncDeployMax();
syncInscribeFields();
setInterval(() => refresh().catch(console.error), 10000);
