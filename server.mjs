import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const ord = process.env.BTCC20_ORD || path.join(projectRoot, '../btcc20-inscriber/target/release/ord');
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
};

function runOrd(args, { raw = false } = {}) {
  const base = [
    '--chain', config.chain,
    '--bitcoin-rpc-url', config.rpcUrl,
    '--bitcoin-rpc-username', config.rpcUser,
    '--bitcoin-rpc-password', config.rpcPassword,
    'btcc20',
  ];
  return new Promise((resolve, reject) => {
    execFile(ord, [...base, ...args], { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || stdout}`;
        reject(error);
        return;
      }
      resolve(raw ? stdout : JSON.parse(stdout));
    });
  });
}

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

async function getTipHeight() {
  try {
    return await rpcAuthed('getblockcount');
  } catch {
    return await rpc('getblockcount');
  }
}

async function getBlockHash(height) {
  try {
    return await rpcAuthed('getblockhash', [height]);
  } catch {
    return await rpc('getblockhash', [height]);
  }
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
};

let indexPromise = null;

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
  const tip = await getTipHeight();
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
    const canResume = current && !force && !reorg;
    const args = canResume
      ? ['scan', '--state-in', indexFile, '--end-height', String(tip)]
      : ['scan', '--start-height', '0', '--end-height', String(tip)];

    indexPromise = runOrd(args)
      .catch(error => {
        if (canResume && /block hash mismatch|resume state/i.test(String(error?.message || error))) {
          indexStatus.last_reorg_at = new Date().toISOString();
          indexStatus.last_reorg_height = current.end_height;
          return runOrd(['scan', '--start-height', '0', '--end-height', String(tip)]);
        }
        throw error;
      })
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
