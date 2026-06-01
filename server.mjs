import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexFile = process.env.BTCC20_INDEX_FILE || path.join(__dirname, 'data/index-state.json');
const config = {
  host: process.env.BTCC20_VIEWER_HOST || '127.0.0.1',
  port: Number(process.env.BTCC20_VIEWER_PORT || 8798),
  chain: process.env.BTCC20_CHAIN || 'regtest',
  rpcUrl: process.env.BTCC20_RPC_URL || 'http://127.0.0.1:28577',
  rpcUser: process.env.BTCC20_RPC_USER || 'btcc20',
  rpcPassword: process.env.BTCC20_RPC_PASSWORD || 'btcc20',
  indexIntervalMs: Number(process.env.BTCC20_INDEX_INTERVAL_MS || 15_000),
  reorgCheckDepth: Number(process.env.BTCC20_REORG_CHECK_DEPTH || 20),
  indexBatchSize: Number(process.env.BTCC20_INDEX_BATCH_SIZE || 100),
};

async function rpc(method, params = []) {
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '1.0',
      id: 'btcc20-viewer',
      method,
      params,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function rpcAuthed(method, params = []) {
  const auth = Buffer.from(`${config.rpcUser}:${config.rpcPassword}`).toString('base64');
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      jsonrpc: '1.0',
      id: 'btcc20-viewer',
      method,
      params,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function rpcBatchAuthed(calls) {
  if (!calls.length) return [];
  const auth = Buffer.from(`${config.rpcUser}:${config.rpcPassword}`).toString('base64');
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(calls.map((call, index) => ({
      jsonrpc: '1.0',
      id: index,
      method: call.method,
      params: call.params || [],
    }))),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`RPC batch HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('RPC batch failed: non-array response');

  const byId = new Map(payload.map(item => [item.id, item]));
  return calls.map((call, index) => {
    const item = byId.get(index);
    if (!item) throw new Error(`RPC batch ${call.method} missing response`);
    if (item.error) throw new Error(`RPC batch ${call.method} failed: ${JSON.stringify(item.error)}`);
    return item.result;
  });
}

async function getTipHeight() {
  return config.rpcUser || config.rpcPassword
    ? rpcAuthed('getblockcount')
    : rpc('getblockcount');
}

async function getBlockHash(height) {
  return config.rpcUser || config.rpcPassword
    ? rpcAuthed('getblockhash', [height])
    : rpc('getblockhash', [height]);
}

async function getBlock(height) {
  const hash = await getBlockHash(height);
  return config.rpcUser || config.rpcPassword
    ? rpcAuthed('getblock', [hash, 2])
    : rpc('getblock', [hash, 2]);
}

async function getBlocksRange(startHeight, endHeight) {
  const heights = [];
  for (let height = startHeight; height <= endHeight; height += 1) heights.push(height);

  if (!config.rpcUser && !config.rpcPassword) {
    const blocks = [];
    for (const height of heights) blocks.push(await getBlock(height));
    return blocks;
  }

  const hashes = await rpcBatchAuthed(heights.map(height => ({
    method: 'getblockhash',
    params: [height],
  })));

  return rpcBatchAuthed(hashes.map(hash => ({
    method: 'getblock',
    params: [hash, 2],
  })));
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeIndex(data) {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const tmp = `${indexFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, indexFile);
}

const indexStatus = {
  running: false,
  last_error: null,
  last_update_at: null,
  last_checked_at: null,
  last_reorg_at: null,
  last_reorg_height: null,
  tip: null,
  scan_start_height: null,
  scan_current_height: null,
  scan_target_height: null,
};

let indexPromise = null;

const PROTOCOL = 'btcc-20';

function emptyState(startHeight = 0, endHeight = startHeight - 1) {
  return {
    start_height: startHeight,
    end_height: endHeight,
    blocks: [],
    ledger: { tokens: {}, balances: {}, transfers: {} },
    events: [],
  };
}

function cloneState(state) {
  return state ? JSON.parse(JSON.stringify(state)) : null;
}

function firstOutputAddress(tx) {
  for (const output of tx.vout || []) {
    const script = output.scriptPubKey || {};
    if (typeof script.address === 'string') return script.address;
    if (Array.isArray(script.addresses) && script.addresses[0]) return script.addresses[0];
  }
  return null;
}

function parseScript(hex) {
  const bytes = Buffer.from(hex || '', 'hex');
  const instructions = [];
  for (let i = 0; i < bytes.length;) {
    const opcode = bytes[i++];
    if (opcode === 0x00) {
      instructions.push({ push: Buffer.alloc(0) });
    } else if (opcode >= 0x01 && opcode <= 0x4b) {
      if (i + opcode > bytes.length) break;
      instructions.push({ push: bytes.subarray(i, i + opcode) });
      i += opcode;
    } else if (opcode === 0x4c) {
      if (i >= bytes.length) break;
      const len = bytes[i++];
      if (i + len > bytes.length) break;
      instructions.push({ push: bytes.subarray(i, i + len) });
      i += len;
    } else if (opcode === 0x4d) {
      if (i + 2 > bytes.length) break;
      const len = bytes.readUInt16LE(i);
      i += 2;
      if (i + len > bytes.length) break;
      instructions.push({ push: bytes.subarray(i, i + len) });
      i += len;
    } else if (opcode === 0x4e) {
      if (i + 4 > bytes.length) break;
      const len = bytes.readUInt32LE(i);
      i += 4;
      if (i + len > bytes.length) break;
      instructions.push({ push: bytes.subarray(i, i + len) });
      i += len;
    } else if (opcode === 0x4f) {
      instructions.push({ pushnum: Buffer.from([0x81]) });
    } else if (opcode >= 0x51 && opcode <= 0x60) {
      instructions.push({ pushnum: Buffer.from([opcode - 0x50]) });
    } else {
      instructions.push({ op: opcode });
    }
  }
  return instructions;
}

function envelopesFromWitness(witness, inputIndex) {
  if (!Array.isArray(witness) || witness.length < 2) return [];
  const tapscript = witness[witness.length - 2];
  const instructions = parseScript(tapscript);
  const envelopes = [];

  for (let i = 0; i < instructions.length; i += 1) {
    const marker = instructions[i];
    if (!marker?.push || marker.push.length !== 0) continue;
    if (instructions[i + 1]?.op !== 0x63) continue;
    const protocol = instructions[i + 2]?.push;
    if (!protocol || protocol.toString('utf8') !== 'ord') continue;

    const payload = [];
    let valid = false;
    for (let j = i + 3; j < instructions.length; j += 1) {
      const instruction = instructions[j];
      if (instruction?.op === 0x68) {
        valid = true;
        i = j;
        break;
      }
      if (instruction?.push) {
        payload.push(Buffer.from(instruction.push));
      } else if (instruction?.pushnum) {
        payload.push(Buffer.from(instruction.pushnum));
      } else {
        break;
      }
    }
    if (valid) envelopes.push({ input: inputIndex, offset: envelopes.length, payload });
  }

  return envelopes;
}

function parseInscriptionPayload(payload) {
  const bodyIndex = payload.findIndex((push, index) => index % 2 === 0 && push.length === 0);
  if (bodyIndex === -1) return null;

  for (let i = 0; i < bodyIndex; i += 2) {
    const tag = payload[i];
    const value = payload[i + 1];
    if (tag?.length === 1 && tag[0] === 7 && value?.toString('utf8') !== PROTOCOL) return null;
  }

  const body = Buffer.concat(payload.slice(bodyIndex + 1));
  let raw;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  return parsePayload(raw);
}

function parsePayload(raw) {
  if (!raw || raw.p !== PROTOCOL || typeof raw.tick !== 'string') return null;
  const tick = raw.tick.trim().toLowerCase();
  if (!/^[a-z0-9]{4}$/.test(tick)) return null;

  try {
    if (raw.op === 'deploy') {
      const dec = raw.dec === undefined ? 18 : Number(raw.dec);
      if (!Number.isInteger(dec) || dec < 0 || dec > 18) return null;
      const max = validDecimal(raw.max);
      const lim = validDecimal(raw.lim);
      if (!max || !lim) return null;
      return { protocol: PROTOCOL, operation: { op: 'deploy', tick, max, lim, dec } };
    }
    if (raw.op === 'mint' || raw.op === 'transfer') {
      const amt = validDecimal(raw.amt);
      if (!amt) return null;
      return { protocol: PROTOCOL, operation: { op: raw.op, tick, amt } };
    }
  } catch {
    return null;
  }
  return null;
}

function validDecimal(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) return null;
  if (!/[1-9]/.test(text)) return null;
  return text;
}

function parseAmount(value, decimals) {
  const text = validDecimal(value);
  if (!text) return null;
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function balance(ledger, tick, owner) {
  ledger.balances[tick] ||= {};
  ledger.balances[tick][owner] ||= { available: '0', transferable: '0' };
  return ledger.balances[tick][owner];
}

function addRaw(value, delta) {
  return (BigInt(value || '0') + delta).toString();
}

function applyInscription(ledger, inscription, owner, payload) {
  const op = payload.operation;
  if (op.op === 'deploy') {
    if (ledger.tokens[op.tick]) return invalid('ticker already deployed');
    const max = parseAmount(op.max, op.dec);
    const lim = parseAmount(op.lim, op.dec);
    if (max === null) return invalid('invalid max');
    if (lim === null) return invalid('invalid lim');
    if (lim > max) return invalid('lim exceeds max');
    ledger.tokens[op.tick] = {
      tick: op.tick,
      max: max.toString(),
      lim: lim.toString(),
      dec: op.dec,
      minted: '0',
      deployer: owner,
    };
    return valid();
  }

  const token = ledger.tokens[op.tick];
  if (!token) return invalid('ticker not deployed');
  const amount = parseAmount(op.amt, token.dec);
  if (amount === null) return invalid('invalid amount');

  if (op.op === 'mint') {
    if (amount > BigInt(token.lim)) return invalid('mint exceeds limit');
    if (BigInt(token.minted) + amount > BigInt(token.max)) return invalid('mint exceeds max');
    token.minted = addRaw(token.minted, amount);
    const ownerBalance = balance(ledger, op.tick, owner);
    ownerBalance.available = addRaw(ownerBalance.available, amount);
    return valid();
  }

  const ownerBalance = balance(ledger, op.tick, owner);
  if (BigInt(ownerBalance.available) < amount) return invalid('insufficient available balance');
  ownerBalance.available = addRaw(ownerBalance.available, -amount);
  ownerBalance.transferable = addRaw(ownerBalance.transferable, amount);
  ledger.transfers[inscription] = {
    tick: op.tick,
    amount: amount.toString(),
    owner,
    spent: false,
  };
  return valid();
}

function applyTransferSpend(ledger, inscription, newOwner) {
  const transfer = ledger.transfers[inscription];
  if (!transfer) return invalid('transfer inscription not found');
  if (transfer.spent) return invalid('transfer inscription already spent');

  transfer.spent = true;
  const oldBalance = balance(ledger, transfer.tick, transfer.owner);
  const amount = BigInt(transfer.amount);
  oldBalance.transferable = (BigInt(oldBalance.transferable || '0') > amount
    ? BigInt(oldBalance.transferable) - amount
    : 0n).toString();
  const newBalance = balance(ledger, transfer.tick, newOwner);
  newBalance.available = addRaw(newBalance.available, amount);
  return valid();
}

function valid() {
  return { valid: true, reason: null };
}

function invalid(reason) {
  return { valid: false, reason };
}

function transferLocations(ledger) {
  return new Map(Object.entries(ledger.transfers || {})
    .filter(([, transfer]) => !transfer.spent)
    .map(([inscription]) => [`${inscription.split('i')[0]}:0`, inscription]));
}

async function scanBlocks(current, tip, force) {
  const state = force || !current ? emptyState(0) : cloneState(current);
  state.ledger ||= { tokens: {}, balances: {}, transfers: {} };
  state.ledger.tokens ||= {};
  state.ledger.balances ||= {};
  state.ledger.transfers ||= {};
  state.events ||= [];
  state.blocks ||= [];

  const startHeight = force || !current ? 0 : current.end_height + 1;
  if (startHeight > tip) return state;

  indexStatus.scan_start_height = startHeight;
  indexStatus.scan_current_height = startHeight - 1;
  indexStatus.scan_target_height = tip;

  const batchSize = Math.max(1, Math.min(config.indexBatchSize, 500));
  const locations = transferLocations(state.ledger);
  for (let batchStart = startHeight; batchStart <= tip; batchStart += batchSize) {
    const batchEnd = Math.min(tip, batchStart + batchSize - 1);
    const blocks = await getBlocksRange(batchStart, batchEnd);

    for (const [offset, block] of blocks.entries()) {
      const height = batchStart + offset;
      state.blocks.push({ height, hash: block.hash });

      for (const tx of block.tx || []) {
        const owner = firstOutputAddress(tx);
        for (const input of tx.vin || []) {
          const previous = input.txid === undefined ? null : `${input.txid}:${input.vout}`;
          const inscription = previous ? locations.get(previous) : null;
          if (inscription && owner) {
            locations.delete(previous);
            const event = applyTransferSpend(state.ledger, inscription, owner);
            state.events.push({ height, txid: tx.txid, inscription, owner, valid: event.valid, reason: event.reason, payload: null });
          }
        }

        if (!owner) continue;
        for (const [inputIndex, input] of (tx.vin || []).entries()) {
          for (const envelope of envelopesFromWitness(input.txinwitness, inputIndex)) {
            const payload = parseInscriptionPayload(envelope.payload);
            if (!payload) continue;
            const inscription = `${tx.txid}i${envelope.offset}`;
            const event = applyInscription(state.ledger, inscription, owner, payload);
            if (event.valid && payload.operation.op === 'transfer') {
              locations.set(`${tx.txid}:0`, inscription);
            }
            state.events.push({ height, txid: tx.txid, inscription, owner, valid: event.valid, reason: event.reason, payload });
          }
        }
      }

      state.end_height = height;
      indexStatus.scan_current_height = height;
    }
  }

  return state;
}

const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) chk ^= generator[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  return [
    ...Array.from(hrp, char => char.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp, char => char.charCodeAt(0) & 31),
  ];
}

function bech32Decode(address) {
  const text = String(address || '').toLowerCase();
  const separator = text.lastIndexOf('1');
  if (separator < 1 || separator + 7 > text.length) return null;
  const hrp = text.slice(0, separator);
  const data = [];
  for (const char of text.slice(separator + 1)) {
    const value = BECH32_ALPHABET.indexOf(char);
    if (value === -1) return null;
    data.push(value);
  }
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  const encoding = polymod === 1 ? 'bech32' : polymod === 0x2bc830a3 ? 'bech32m' : null;
  if (!encoding) return null;
  return { hrp, data: data.slice(0, -6), encoding };
}

function bech32Encode(hrp, data, encoding) {
  const constant = encoding === 'bech32m' ? 0x2bc830a3 : 1;
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ constant;
  const checksum = [];
  for (let i = 0; i < 6; i += 1) {
    checksum.push((polymod >> (5 * (5 - i))) & 31);
  }
  return `${hrp}1${[...data, ...checksum].map(value => BECH32_ALPHABET[value]).join('')}`;
}

function toBtccAddress(value) {
  if (config.chain !== 'mainnet' || typeof value !== 'string' || !value.startsWith('bc1')) return value;
  const decoded = bech32Decode(value);
  if (!decoded || decoded.hrp !== 'bc') return value;
  return bech32Encode('cc', decoded.data, decoded.encoding);
}

function normalizeAddresses(value) {
  if (typeof value === 'string') return toBtccAddress(value);
  if (Array.isArray(value)) return value.map(item => normalizeAddresses(item));
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[toBtccAddress(key)] = normalizeAddresses(child);
  }
  return output;
}

function clientState(state) {
  return normalizeAddresses(state);
}

async function updateIndex({ force = false } = {}) {
  let tip;
  try {
    tip = await getTipHeight();
  } catch (error) {
    indexStatus.last_error = String(error?.message || error);
    indexStatus.last_checked_at = new Date().toISOString();
    throw error;
  }

  const current = readIndex();
  indexStatus.tip = tip;
  indexStatus.last_checked_at = new Date().toISOString();

  const reorg = current ? await detectReorg(current, tip) : null;
  if (reorg) {
    indexStatus.last_reorg_at = new Date().toISOString();
    indexStatus.last_reorg_height = reorg.height;
  }

  if (!force && !reorg && current?.end_height >= tip) {
    return clientState({
      ...current,
      index: indexMeta(current, true),
    });
  }

  if (!indexPromise) {
    indexStatus.running = true;
    indexPromise = scanBlocks(current, tip, force || Boolean(reorg))
      .then(data => {
        writeIndex(data);
        indexStatus.last_error = null;
        indexStatus.last_update_at = new Date().toISOString();
        return clientState({
          ...data,
          index: indexMeta(data, false, Boolean(reorg)),
        });
      })
      .catch(error => {
        indexStatus.last_error = String(error?.message || error);
        throw error;
      })
      .finally(() => {
        indexStatus.running = false;
        indexStatus.scan_start_height = null;
        indexStatus.scan_current_height = null;
        indexStatus.scan_target_height = null;
        indexPromise = null;
      });
  }

  return indexPromise;
}

function indexMeta(state, hit) {
  return {
    mode: 'incremental',
    hit,
    path: indexFile,
    tip: indexStatus.tip,
    synced: state?.end_height >= indexStatus.tip,
    running: indexStatus.running,
    reorg_check_depth: config.reorgCheckDepth,
    last_reorg_at: indexStatus.last_reorg_at,
    last_reorg_height: indexStatus.last_reorg_height,
    last_update_at: indexStatus.last_update_at,
    last_checked_at: indexStatus.last_checked_at,
    last_error: indexStatus.last_error,
  };
}

async function detectReorg(state, tip) {
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  if (!blocks.length) {
    return state.end_height > 0 ? { height: 0, reason: 'missing indexed block hashes' } : null;
  }

  const indexedTip = Math.min(state.end_height, tip);
  const minHeight = Math.max(state.start_height, indexedTip - config.reorgCheckDepth + 1);
  const byHeight = new Map(blocks.map(block => [block.height, block.hash]));

  for (let height = indexedTip; height >= minHeight; height -= 1) {
    const indexedHash = byHeight.get(height);
    if (!indexedHash) return { height, reason: 'missing indexed block hash' };
    const chainHash = await getBlockHash(height);
    if (indexedHash !== chainHash) {
      return { height, indexedHash, chainHash };
    }
  }

  return null;
}

async function getIndex() {
  const state = readIndex();
  if (!state) return updateIndex({ force: true });

  const tip = await getTipHeight();
  indexStatus.tip = tip;
  indexStatus.last_checked_at = new Date().toISOString();
  if (state.end_height < tip) return updateIndex();

  return clientState({
    ...state,
    index: indexMeta(state, true),
  });
}

function startIndexer() {
  updateIndex().catch(error => {
    console.error(`BTCC-20 index update failed: ${error.message || error}`);
  });
  setInterval(() => {
    updateIndex().catch(error => {
      console.error(`BTCC-20 index update failed: ${error.message || error}`);
    });
  }, config.indexIntervalMs).unref();
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function staticFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full)) return false;
  const type = full.endsWith('.css') ? 'text/css' : full.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(full));
  return true;
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/scan') {
      return json(res, 200, url.searchParams.get('force') === '1' ? await updateIndex({ force: true }) : await getIndex());
    }
    if (url.pathname === '/api/index/status') {
      const state = readIndex();
      return json(res, 200, { ...indexStatus, height: state?.end_height ?? null, path: indexFile });
    }
    if (staticFile(req, res)) return;
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, 500, { error: String(error?.message || error) });
  }
}).listen(config.port, config.host, () => {
  startIndexer();
  console.log(`BTCC-20 viewer listening on http://${config.host}:${config.port}`);
  console.log(`BTCC-20 chain: ${config.chain}`);
  console.log(`BTCC-20 index state: ${indexFile}`);
});
