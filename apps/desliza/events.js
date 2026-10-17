/* Funnel events for Desliza. Posts {app, type, session_id, props} to the platform's /events
   (text/plain JSON, so no CORS preflight). A no-op on localhost and file:// so development
   doesn't pollute the funnel. Set ENDPOINT to "" to turn it off entirely. */
(() => {
  "use strict";
  const ENDPOINT = "https://api.odapt.ai/events";
  const APP = "desliza";
  const local = location.protocol === "file:" || /^(localhost|127\.|0\.0\.0\.0|\[::1\]|.*\.local$)/.test(location.hostname);

  let sid = "";
  try {
    sid = localStorage.getItem("desliza:sid") || "";
    if (!sid) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("desliza:sid", sid); }
  } catch (_) { sid = "anon-" + Math.random().toString(36).slice(2); }

  function track(type, props) {
    if (local || !ENDPOINT) return;
    const body = JSON.stringify({ app: APP, type, session_id: sid, props: Object.assign({ ref: document.referrer || "" }, props || {}) });
    try { fetch(ENDPOINT, { method: "POST", body, headers: { "content-type": "text/plain" }, keepalive: true, mode: "cors" }).catch(() => {}); } catch (_) {}
  }

  window.deslizaEvents = { track };
})();
