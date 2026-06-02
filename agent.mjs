import { spawn } from 'node:child_process';
import http from 'node:http';

const config = {
  host: process.env.BTCC20_AGENT_HOST || '127.0.0.1',
  port: Number(process.env.BTCC20_AGENT_PORT || 28798),
  ord: process.env.BTCC20_AGENT_ORD || 'ord',
  chain: process.env.BTCC20_AGENT_CHAIN || 'mainnet',
  rpcUrl: process.env.BTCC20_AGENT_RPC_URL || 'http://127.0.0.1:28476',
  rpcUser: process.env.BTCC20_AGENT_RPC_USER || 'btcc_rpc_user',
  rpcPassword: process.env.BTCC20_AGENT_RPC_PASSWORD || 'change_me',
  wallet: process.env.BTCC20_AGENT_WALLET || 'miner',
  dryRun: process.env.BTCC20_AGENT_DRY_RUN !== '0',
  allowedOrigins: (process.env.BTCC20_AGENT_ALLOWED_ORIGINS || [
    'http://127.0.0.1:8798',
    'http://127.0.0.1:8799',
    'http://127.0.0.1:8899',
    'http://localhost:8798',
    'http://localhost:8799',
    'http://localhost:8899',
    'http://104.154.199.255:8798',
  ].join(',')).split(',').map(origin => origin.trim()).filter(Boolean),
};

const jobs = new Map();
let nextJobId = 1;

function json(res, status, payload, origin) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(JSON.stringify(payload, null, 2));
}

function corsHeaders(origin) {
  const allowed = origin && config.allowedOrigins.includes(origin);
  return {
    'access-control-allow-origin': allowed ? origin : config.allowedOrigins[0],
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'origin',
  };
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function rpc(method, params = []) {
  const auth = Buffer.from(`${config.rpcUser}:${config.rpcPassword}`).toString('base64');
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      jsonrpc: '1.0',
      id: 'btcc20-agent',
      method,
      params,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function nodeStatus() {
  const info = await rpc('getblockchaininfo');
  let wallets = [];
  try {
    wallets = await rpc('listwallets');
  } catch {
    wallets = [];
  }
  return {
    chain: info.chain,
    blocks: info.blocks,
    headers: info.headers,
    initialblockdownload: info.initialblockdownload,
    verificationprogress: info.verificationprogress,
    wallets,
    rpc_url: config.rpcUrl,
  };
}

function cleanText(value) {
  return String(value || '').trim();
}

function requireTicker(value) {
  const tick = cleanText(value).toLowerCase();
  if (!/^[a-z0-9]{4,12}$/.test(tick)) throw new Error('ticker must be 4-12 letters or numbers');
  return tick;
}

function requireDecimal(value, name) {
  const text = cleanText(value);
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) throw new Error(`${name} must be a positive decimal`);
  return text;
}

function buildCommand(op, input) {
  if (!['deploy', 'mint', 'transfer'].includes(op)) throw new Error(`unsupported op: ${op}`);

  const wallet = cleanText(input.wallet) || config.wallet;
  const tick = requireTicker(input.tick);
  const args = [
    '--chain', config.chain,
    '--bitcoin-rpc-url', config.rpcUrl,
    '--bitcoin-rpc-username', config.rpcUser,
    '--bitcoin-rpc-password', config.rpcPassword,
    'btcc20',
    'inscribe',
    '--wallet', wallet,
    op,
    '--tick', tick,
  ];

  if (op === 'deploy') {
    args.push('--max', requireDecimal(input.max, 'max'));
    args.push('--lim', requireDecimal(input.lim, 'lim'));
    const dec = cleanText(input.dec);
    if (dec) {
      if (!/^\d+$/.test(dec) || Number(dec) > 18) throw new Error('dec must be an integer from 0 to 18');
      args.push('--dec', dec);
    }
  } else {
    args.push('--amt', requireDecimal(input.amt, 'amt'));
  }

  const destination = cleanText(input.destination);
  if (destination) args.push('--destination', destination);

  return { bin: config.ord, args };
}

function publicCommand(command) {
  return [command.bin, ...command.args].map(arg => {
    const text = String(arg);
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, `'\\''`)}'`;
  }).join(' ');
}

function createJob(op, input) {
  const command = buildCommand(op, input);
  const id = String(nextJobId++);
  const now = new Date().toISOString();
  const job = {
    id,
    op,
    status: config.dryRun ? 'dry_run' : 'queued',
    dry_run: config.dryRun,
    command: publicCommand(command),
    created_at: now,
    updated_at: now,
    exit_code: null,
    logs: [],
  };
  jobs.set(id, job);
  job.logs.push(config.dryRun
    ? 'Dry run enabled. Set BTCC20_AGENT_DRY_RUN=0 to execute.'
    : 'Queued local inscription command.');

  if (!config.dryRun) runJob(job, command);
  return job;
}

async function assertNodeReady() {
  const status = await nodeStatus();
  if (status.initialblockdownload || status.blocks < status.headers) {
    throw new Error(`BTCC Core is not synced: ${status.blocks}/${status.headers}`);
  }
  return status;
}

function appendLog(job, chunk) {
  const text = String(chunk || '').trimEnd();
  if (!text) return;
  job.logs.push(...text.split(/\r?\n/).filter(Boolean));
  job.updated_at = new Date().toISOString();
}

function runJob(job, command) {
  job.status = 'running';
  job.updated_at = new Date().toISOString();
  const child = spawn(command.bin, command.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => appendLog(job, chunk));
  child.stderr.on('data', chunk => appendLog(job, chunk));
  child.on('error', error => {
    job.status = 'failed';
    job.exit_code = null;
    appendLog(job, error.message);
  });
  child.on('close', code => {
    job.status = code === 0 ? 'completed' : 'failed';
    job.exit_code = code;
    job.updated_at = new Date().toISOString();
    appendLog(job, `Process exited with code ${code}.`);
  });
}

function publicJob(job) {
  return {
    ...job,
    logs: job.logs.slice(-200),
  };
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        agent: 'btcc20-inscriber-agent',
        version: '0.1.0',
        dry_run: config.dryRun,
        chain: config.chain,
        rpc_url: config.rpcUrl,
        wallet: config.wallet,
      }, origin);
    }
    if (req.method === 'GET' && url.pathname === '/node/status') {
      return json(res, 200, await nodeStatus(), origin);
    }
    if (req.method === 'GET' && url.pathname === '/jobs') {
      return json(res, 200, { jobs: [...jobs.values()].map(publicJob).reverse() }, origin);
    }
    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      return job ? json(res, 200, publicJob(job), origin) : json(res, 404, { error: 'job not found' }, origin);
    }
    const inscribeMatch = url.pathname.match(/^\/inscribe\/(deploy|mint|transfer)$/);
    if (req.method === 'POST' && inscribeMatch) {
      const input = await body(req);
      if (!config.dryRun) await assertNodeReady();
      return json(res, 200, publicJob(createJob(inscribeMatch[1], input)), origin);
    }

    json(res, 404, { error: 'not found' }, origin);
  } catch (error) {
    json(res, 500, { error: String(error?.message || error) }, origin);
  }
}).listen(config.port, config.host, () => {
  console.log(`BTCC-20 local agent listening on http://${config.host}:${config.port}`);
  console.log(`dry_run=${config.dryRun} rpc=${config.rpcUrl} wallet=${config.wallet}`);
});
