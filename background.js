chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.set({ keywords: ["Trump", "Donald", "MAGA", "Elon", "Musk", "DOGE"], siteFilters: {} });
});