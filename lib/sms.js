const API_BASE = 'https://5sim.net/v1';

// Products to try in order — 'libero' is the dedicated one, but 'other' and 'any'
// cast a wider net of operators that may have better delivery rates.
const PRODUCTS_TO_TRY = ['libero', 'other'];

// Premium operators tried first — better SMS delivery rates.
const PREFERRED_OPERATORS = ['virtual21', 'lycamobile', 'windtre', 'vodafone', 'tim', 'iliad'];

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
    // 5sim API: /guest/products/{country}/operator — returns all products for that country
    // We need to check the product-level data
    const data = await apiCall(token, `/guest/products/${country}/any`);
    const info = data[product];
    if (!info) return [];
    // The response shape can vary: { Category, Qty, Price } at top level,
    // and operators under an "operators" or "Operators" key (case varies by API version)
    const ops = info.operators || info.Operators;
    if (!ops || typeof ops !== 'object') return [];
    return Object.entries(ops)
      .filter(([, v]) => (v.count || v.Count || 0) > 0)
      .sort((a, b) => (b[1].cost || b[1].Cost || 0) - (a[1].cost || a[1].Cost || 0))
      .map(([name, v]) => ({ name, count: v.count || v.Count || 0, cost: v.cost || v.Cost || 0 }));
  } catch (err) {
    // Silently fail — we'll fall back to 'any' operator
    return [];
  }
}

async function get5SimCode(product = 'libero', country = 'italy', token, log) {
  const t = token || process.env.FIVE_SIM_TOKEN;
  if (!t) throw new Error('5sim token not configured — set FIVE_SIM_TOKEN env var or add it in Settings');
  const emit = (msg) => { console.log(msg); if (log) log(msg); };

  // Determine which products to try
  const products = product === 'libero' ? PRODUCTS_TO_TRY : [product];

  // Try to find the best operator for each product
  let selectedOperator = 'any';
  let selectedProduct = products[0];

  for (const prod of products) {
    emit(`📱 [5sim] Checking operators for "${prod}" in ${country}…`);
    const operators = await getAvailableOperators(t, country, prod);

    if (operators.length > 0) {
      emit(`📱 [5sim] Found ${operators.length} operators for "${prod}": ${operators.map((o) => `${o.name}(${o.cost}₽×${o.count})`).join(', ')}`);

      // Try preferred operators first
      for (const pref of PREFERRED_OPERATORS) {
        const match = operators.find((op) => op.name.toLowerCase() === pref.toLowerCase());
        if (match && match.count > 0) {
          selectedOperator = match.name;
          selectedProduct = prod;
          break;
        }
      }
      // If no preferred operator, pick the most expensive (highest quality)
      if (selectedOperator === 'any' && operators.length > 0) {
        selectedOperator = operators[0].name;
        selectedProduct = prod;
      }
      if (selectedOperator !== 'any') break;
    } else {
      emit(`📱 [5sim] No operator info for "${prod}" — will try with any`);
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

    async waitForCode(timeout = 120000) {
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
        await new Promise((r) => setTimeout(r, 5000));
      }
      emit('⏰ [5sim] Timeout — canceling order to save funds');
      try { await apiCall(t, `/user/cancel/${order.id}`); } catch {}
      throw new Error('SMS verification timed out (2 min)');
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
