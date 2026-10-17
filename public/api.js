// Small helper the pages use to talk to the server.
window.api = async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error('No internet connection. Please check it and try again.');
    err.status = 0;
    throw err;
  }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
};

// Resilient attempt submission with localStorage offline queue
window.saveAndSubmitQuizAttempt = async function saveAndSubmitQuizAttempt(payload) {
  try {
    const queue = JSON.parse(localStorage.getItem('fin_pending_attempts') || '[]');
    const isDup = queue.some(q => (q.attemptId && q.attemptId === payload.attemptId) || (q.name === payload.name && q.classId === payload.classId && q.finishedAt === payload.finishedAt));
    if (!isDup) {
      queue.push({ ...payload, queuedAt: Date.now() });
      localStorage.setItem('fin_pending_attempts', JSON.stringify(queue));
    }
  } catch (_) {}

  try {
    const res = await window.api('POST', '/api/submit', payload);
    try {
      let queue = JSON.parse(localStorage.getItem('fin_pending_attempts') || '[]');
      queue = queue.filter(q => {
        if (payload.attemptId && q.attemptId === payload.attemptId) return false;
        if (q.name === payload.name && q.classId === payload.classId) return false;
        return true;
      });
      localStorage.setItem('fin_pending_attempts', JSON.stringify(queue));
    } catch (_) {}
    return res;
  } catch (err) {
    console.warn('[QUIZ] Submit failed, saved locally to retry:', err.message);
    return null;
  }
};

async function flushPendingAttempts() {
  try {
    const queue = JSON.parse(localStorage.getItem('fin_pending_attempts') || '[]');
    if (!queue.length) return;
    const remaining = [];
    for (const item of queue) {
      try {
        await window.api('POST', '/api/submit', item);
      } catch (err) {
        remaining.push(item);
      }
    }
    localStorage.setItem('fin_pending_attempts', JSON.stringify(remaining));
  } catch (_) {}
}

window.addEventListener('online', flushPendingAttempts);
setInterval(flushPendingAttempts, 30000);
setTimeout(flushPendingAttempts, 2000);
