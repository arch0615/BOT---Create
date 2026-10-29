const API_BASE = 'https://5sim.net/v1';

// 'other' first — physical/higher-quality operators with better delivery to Libero.
// 'libero' as fallback (cheap virtual numbers, low success rate).
const PRODUCTS_TO_TRY = ['other', 'libero'];

// Operators ranked by real SMS delivery rates to Libero.it (from 5sim stats).
// virtual4 ~27-58%, virtual21 ~28%, physical carriers best but rarely in stock.
const PREFERRED_OPERATORS = ['virtual4', 'virtual21', 'lycamobile', 'windtre', 'vodafone', 'tim', 'iliad', 'virtual34'];

async function apiCall(token, endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`5sim ${res.status}: ${text}`);
  }
  return res.json();
}

async function getAvailableOperators(token, country, product) {
  try {
    const data = await apiCall(token, `/guest/prices?country=${country}&product=${product}`);
    // Response: { "italy": { "other": { "virtual4": { cost, count, rate, rate3, ... } } } }
    const countryData = data[country];
    if (!countryData || typeof countryData !== 'object') return [];
    const productData = countryData[product];
    if (!productData || typeof productData !== 'object') return [];
    return Object.entries(productData)
      .filter(([, v]) => (v.count || 0) > 0)
      .map(([name, v]) => ({
        name,
        count: v.count || 0,
        cost: v.cost || 0,
        rate: v.rate || 0,
        rate3: v.rate3 || 0,
        rate24: v.rate24 || 0,
      }))
      // Sort by best recent success: rate3 (3-day) first, then rate (1-hour), then cost
      .sort((a, b) => (b.rate3 - a.rate3) || (b.rate - a.rate) || (b.cost - a.cost));
  } catch (err) {
    return [];
  }
}

async function get5SimCode(product = 'libero', country = 'italy', token, log, excludeOperators = []) {
  const t = token || process.env.FIVE_SIM_TOKEN;
  if (!t) throw new Error('5sim token not configured — set FIVE_SIM_TOKEN env var or add it in Settings');
  const emit = (msg) => { console.log(msg); if (log) log(msg); };
  const excluded = new Set(excludeOperators.map(o => o.toLowerCase()));

  // Determine which products to try
  const products = product === 'libero' ? PRODUCTS_TO_TRY : [product];

  // Try to find the best operator for each product
  let selectedOperator = 'any';
  let selectedProduct = products[0];

  for (const prod of products) {
    emit(`📱 [5sim] Checking operators for "${prod}" in ${country}…`);
    const operators = await getAvailableOperators(t, country, prod);
    // Filter out already-tried operators
    const available = operators.filter(o => !excluded.has(o.name.toLowerCase()));

    if (available.length > 0) {
      emit(`📱 [5sim] Found ${available.length} operators for "${prod}": ${available.map((o) => `${o.name}(now:${o.rate}% 3d:${o.rate3}% ${o.cost}₽ ×${o.count})`).join(', ')}`);

      // Try preferred operators first (if in stock)
      for (const pref of PREFERRED_OPERATORS) {
        const match = available.find((op) => op.name.toLowerCase() === pref.toLowerCase() && op.count > 0);
        if (match) {
          selectedOperator = match.name;
          selectedProduct = prod;
          break;
        }
      }
      // If no preferred operator, pick the one with the best 3-day success rate
      if (selectedOperator === 'any' && available.length > 0) {
        selectedOperator = available[0].name;  // already sorted by rate3 desc
        selectedProduct = prod;
      }
      if (selectedOperator !== 'any') break;
    } else {
      emit(`📱 [5sim] No available operators for "${prod}"${excluded.size ? ' (after excluding tried ones)' : ''}`);
    }
  }

  const opLabel = selectedOperator === 'any' ? 'any (cheapest)' : selectedOperator;
  emit(`📱 [5sim] Requesting number: product="${selectedProduct}", operator="${opLabel}"…`);

  // Try to buy with the selected operator first, fall back to 'any' if it fails
  let order;
  if (selectedOperator !== 'any') {
    try {
      order = await apiCall(t, `/user/buy/activation/${country}/${selectedOperator}/${selectedProduct}`);
    } catch (err) {
      emit(`📱 [5sim] ${selectedOperator} failed (${err.message}) — falling back to any operator…`);
      selectedOperator = 'any';
    }
  }
  if (!order) {
    // Try each product with 'any' operator
    for (const prod of products) {
      try {
        order = await apiCall(t, `/user/buy/activation/${country}/any/${prod}`);
        selectedProduct = prod;
        break;
      } catch (err) {
        emit(`📱 [5sim] Product "${prod}" with any operator failed: ${err.message}`);
      }
    }
  }
  if (!order) {
    throw new Error('No numbers available on 5sim for any product/operator combination');
  }

  emit(`📱 [5sim] Rented: ${order.phone} (product: ${selectedProduct}, operator: ${order.operator || selectedOperator}, cost: ${order.price || '?'} RUB)`);

  return {
    phone: order.phone,
    orderId: order.id,
    operator: order.operator || selectedOperator,
    product: selectedProduct,
    cost: order.price,

    async waitForCode(timeout = 180000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        emit(`🔄 [5sim] Waiting for SMS… (${elapsed}s)`);
        const data = await apiCall(t, `/user/check/${order.id}`);
        if (data.sms && data.sms.length > 0) {
          const text = data.sms[data.sms.length - 1].text || '';
          const m = text.match(/\b(\d{4,8})\b/);
          const code = m ? m[1] : text;
          emit(`🎉 [5sim] Code Received: ${code}`);
          return code;
        }
        if (['CANCELED', 'TIMEOUT', 'BANNED'].includes(data.status)) {
          throw new Error(`5sim order ${data.status}`);
        }
        // Exponential backoff: 8s → 10s → 13s → 16s … capped at 20s
        const pollNum = Math.floor((Date.now() - start) / 8000);
        const delay = Math.min(8000 * Math.pow(1.15, pollNum), 20000);
        await new Promise((r) => setTimeout(r, delay));
      }
      emit('⏰ [5sim] Timeout — canceling order to save funds');
      try { await apiCall(t, `/user/cancel/${order.id}`); } catch {}
      throw new Error('SMS verification timed out (3 min)');
    },

    async finish() {
      emit('✅ [5sim] Order finished');
      try { await apiCall(t, `/user/finish/${order.id}`); } catch {}
    },

    async cancel() {
      emit('❌ [5sim] Canceling order to recover funds');
      try { await apiCall(t, `/user/cancel/${order.id}`); } catch {}
    },
  };
}

async function getBalance(token) {
  const t = token || process.env.FIVE_SIM_TOKEN;
  return (await apiCall(t, '/user/profile')).balance;
}

module.exports = { get5SimCode, getBalance };
