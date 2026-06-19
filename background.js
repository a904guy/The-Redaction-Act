// Seed default keywords ONLY on first install — never on update — so the user's
// keywords and per-site toggles survive extension updates. Each key is filled in
// only if absent, so existing/synced data is never clobbered.
chrome.runtime.onInstalled.addListener(details => {
    if (details.reason !== "install") return;
    chrome.storage.sync.get(["keywords", "siteFilters"], data => {
        const seed = {};
        if (data.keywords === undefined) seed.keywords = ["Trump", "Donald", "MAGA", "Elon", "Musk", "DOGE"];
        if (data.siteFilters === undefined) seed.siteFilters = {};
        if (Object.keys(seed).length) chrome.storage.sync.set(seed);
    });
});
