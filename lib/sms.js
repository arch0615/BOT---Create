const API_BASE = 'https://5sim.net/v1';

async function apiCall(token, endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`5sim API ${res.status}: ${text}`);
  }
  return res.json();
}

async function getBalance(token) {
  const profile = await apiCall(token, '/user/profile');
  return profile.balance;
}

async function buyNumber(token, { country = 'italy', operator = 'any', product = 'libero' } = {}) {
  const data = await apiCall(token, `/user/buy/activation/${country}/${operator}/${product}`);
  return { id: data.id, phone: data.phone, operator: data.operator, product: data.product };
}

async function checkSms(token, orderId) {
  const data = await apiCall(token, `/user/check/${orderId}`);
  return { status: data.status, sms: data.sms || [] };
}

async function finishOrder(token, orderId) {
  return apiCall(token, `/user/finish/${orderId}`);
}

async function cancelOrder(token, orderId) {
  return apiCall(token, `/user/cancel/${orderId}`);
}

async function waitForCode(token, orderId, { timeout = 120000, interval = 5000, onStatus } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { status, sms } = await checkSms(token, orderId);
    if (onStatus) onStatus(status, sms);
    if (sms.length > 0) {
      const text = sms[sms.length - 1].text || '';
      const code = text.match(/\b(\d{4,8})\b/);
      if (code) return code[1];
      return text;
    }
    if (status === 'CANCELED' || status === 'TIMEOUT' || status === 'BANNED') {
      throw new Error(`5sim order ${status}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('SMS verification timed out');
}

module.exports = { getBalance, buyNumber, checkSms, finishOrder, cancelOrder, waitForCode };
