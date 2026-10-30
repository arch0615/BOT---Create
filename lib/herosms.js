const SA_BASE = 'https://hero-sms.com/stubs/handler_api.php';
const API_BASE = 'https://hero-sms.com/api/v1';

// Italy = 86 in SMS-Activate country numbering.
// Service code for Libero: try 'ot' (other) first — generic catch-all.
const DEFAULT_COUNTRY = 86;
const DEFAULT_SERVICE = 'ot';

async function saCall(apiKey, params) {
  const url = new URL(SA_BASE);
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok || text.startsWith('BAD_KEY') || text.startsWith('NO_KEY')) {
    throw new Error(`HeroSMS auth error: ${text}`);
  }
  if (text.startsWith('NO_BALANCE')) throw new Error('HeroSMS: insufficient balance');
  if (text.startsWith('NO_NUMBERS')) throw new Error('HeroSMS: no numbers available');
  if (text.startsWith('BAD_') || text.startsWith('WRONG_') || text.startsWith('ERROR_')) {
    throw new Error(`HeroSMS error: ${text}`);
  }
  return text;
}

async function apiCall(apiKey, method, endpoint, body) {
  const url = `${API_BASE}${endpoint}`;
  const opts = {
    method: method || 'GET',
    headers: { Authorization: `ApiKey ${apiKey}`, Accept: 'application/json' },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && data.details ? data.details : `HTTP ${res.status}`;
    throw new Error(`HeroSMS ${res.status}: ${msg}`);
  }
  return data;
}

async function getHeroSmsCode(service = DEFAULT_SERVICE, country = DEFAULT_COUNTRY, apiKey, log) {
  const key = apiKey || process.env.HERO_SMS_API_KEY;
  if (!key) throw new Error('HeroSMS API key not configured — add it in Settings');
  const emit = (msg) => { console.log(msg); if (log) log(msg); };

  emit(`📱 [HeroSMS] Requesting number: service="${service}", country=${country}…`);

  // Use the v2 endpoint for richer response
  const text = await saCall(key, { action: 'getNumberV2', service, country });

  let order;
  try { order = JSON.parse(text); } catch {
    // Fallback: getNumber returns "ACCESS_NUMBER:<id>:<phone>"
    if (text.startsWith('ACCESS_NUMBER:')) {
      const parts = text.split(':');
      order = { activationId: parts[1], phoneNumber: parts[2] };
    } else {
      throw new Error(`HeroSMS unexpected response: ${text}`);
    }
  }

  const activationId = order.activationId;
  const rawPhone = String(order.phoneNumber);
  // Strip country code prefix (e.g. 39 for Italy) — Libero wants local number
  const phone = rawPhone.startsWith('39') ? rawPhone.slice(2) : rawPhone;
  const cost = order.activationCost || 0;
  const operator = order.activationOperator || 'unknown';

  emit(`📱 [HeroSMS] Rented: +39${phone} (id: ${activationId}, operator: ${operator}, cost: $${cost})`);

  return {
    phone,
    orderId: activationId,
    operator,
    product: service,
    cost,

    async waitForCode(timeout = 180000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        emit(`🔄 [HeroSMS] Waiting for SMS… (${elapsed}s)`);

        const status = await saCall(key, { action: 'getStatus', id: activationId });

        if (status.startsWith('STATUS_OK:')) {
          const fullText = status.slice('STATUS_OK:'.length);
          // Extract the verification code from the SMS text.
          // Libero sends codes like "cksija" or "1234" at the end after ": "
          const afterColon = fullText.split(':').pop().trim();
          // Try to find a standalone code (alphanumeric, 4-8 chars)
          const m = afterColon.match(/\b([A-Za-z0-9]{4,8})\b/);
          const code = m ? m[1] : afterColon;
          emit(`🎉 [HeroSMS] Code received: ${code} (from: ${fullText})`);
          return code;
        }
        if (status === 'STATUS_CANCEL') {
          throw new Error('HeroSMS activation canceled');
        }

        // Exponential backoff: 8s → 10s → 13s → 16s … capped at 20s
        const pollNum = Math.floor((Date.now() - start) / 8000);
        const delay = Math.min(8000 * Math.pow(1.15, pollNum), 20000);
        await new Promise((r) => setTimeout(r, delay));
      }
      emit('⏰ [HeroSMS] Timeout — canceling activation to save funds');
      try { await saCall(key, { action: 'setStatus', id: activationId, status: 8 }); } catch {}
      throw new Error('SMS verification timed out (3 min)');
    },

    async finish() {
      emit('✅ [HeroSMS] Activation finished');
      try { await saCall(key, { action: 'setStatus', id: activationId, status: 6 }); } catch {}
    },

    async cancel() {
      emit('❌ [HeroSMS] Canceling activation to recover funds');
      try { await saCall(key, { action: 'setStatus', id: activationId, status: 8 }); } catch {}
    },
  };
}

async function getBalance(apiKey) {
  const key = apiKey || process.env.HERO_SMS_API_KEY;
  const text = await saCall(key, { action: 'getBalance' });
  // Response: "ACCESS_BALANCE:100.5"
  const m = text.match(/ACCESS_BALANCE:([\d.]+)/);
  if (!m) throw new Error(`HeroSMS balance error: ${text}`);
  return parseFloat(m[1]);
}

module.exports = { getHeroSmsCode, getBalance };
