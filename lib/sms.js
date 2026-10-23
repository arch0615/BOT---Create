const API_BASE = 'https://5sim.net/v1';

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

async function get5SimCode(product = 'libero', country = 'italy', token) {
  const t = token || process.env.FIVE_SIM_TOKEN;
  if (!t) throw new Error('5sim token not configured — set FIVE_SIM_TOKEN env var or add it in Settings');

  console.log('📱 [5sim] Requesting activation number…');
  const order = await apiCall(t, `/user/buy/activation/${country}/any/${product}`);
  console.log(`📱 [5sim] Rented Number: ${order.phone}`);

  return {
    phone: order.phone,
    orderId: order.id,

    async waitForCode(timeout = 120000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        console.log('🔄 [5sim] Waiting for SMS…');
        const data = await apiCall(t, `/user/check/${order.id}`);
        if (data.sms && data.sms.length > 0) {
          const text = data.sms[data.sms.length - 1].text || '';
          const m = text.match(/\b(\d{4,8})\b/);
          const code = m ? m[1] : text;
          console.log(`🎉 [5sim] Code Received: ${code}`);
          return code;
        }
        if (['CANCELED', 'TIMEOUT', 'BANNED'].includes(data.status)) {
          throw new Error(`5sim order ${data.status}`);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      console.log('⏰ [5sim] Timeout — canceling order to save funds');
      try { await apiCall(t, `/user/cancel/${order.id}`); } catch {}
      throw new Error('SMS verification timed out (2 min)');
    },

    async finish() {
      console.log('✅ [5sim] Order finished');
      try { await apiCall(t, `/user/finish/${order.id}`); } catch {}
    },

    async cancel() {
      console.log('❌ [5sim] Canceling order to recover funds');
      try { await apiCall(t, `/user/cancel/${order.id}`); } catch {}
    },
  };
}

async function getBalance(token) {
  const t = token || process.env.FIVE_SIM_TOKEN;
  return (await apiCall(t, '/user/profile')).balance;
}

module.exports = { get5SimCode, getBalance };
