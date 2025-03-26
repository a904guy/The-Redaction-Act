ko.bindingProvider.instance = new ko.secureBindingsProvider({
    attribute: "data-bind",
    globals: window,
    bindings: ko.bindingHandlers,
    noVirtualElements: false
});

function ViewModel() {
    const self = this;
    self.newKeyword = ko.observable("");
    self.keywords = ko.observableArray([]);
    self.filterEnabled = ko.observable(true);
    self.currentDomain = ko.observable("");

    const getDomain = url => new URL(url).hostname;

    const init = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            const domain = getDomain(tabs[0].url);
            self.currentDomain(domain);
            chrome.storage.sync.get(["keywords", "siteFilters"], ({ keywords = [], siteFilters = {} }) => {
                self.keywords(keywords);
                self.filterEnabled(siteFilters[domain] !== undefined ? siteFilters[domain] : true);
            });
        });
    };

    self.addKeyword = () => {
        const input = self.newKeyword().trim();
        if (!input) return;
        const newKeywords = input.split(",").map(k => k.trim()).filter(Boolean);
        chrome.storage.sync.get("keywords", ({ keywords = [] }) => {
            const updatedKeywords = [...new Set([...keywords, ...newKeywords])];
            chrome.storage.sync.set({ keywords: updatedKeywords }, () => {
                self.keywords(updatedKeywords);
            });
        });
        self.newKeyword("");
    };

    self.removeKeyword = keyword => {
        chrome.storage.sync.get("keywords", ({ keywords = [] }) => {
            const updatedKeywords = keywords.filter(k => k !== keyword);
            chrome.storage.sync.set({ keywords: updatedKeywords }, () => {
                self.keywords(updatedKeywords);
            });
        });
    };

    self.isFilterOn = ko.computed(() => self.filterEnabled() ? "Toggle OFF" : "Toggle On");
    self.backgroundColor = ko.computed(() => self.filterEnabled() ? '#f44336' : '#4caf50');

    self.toggleFilter = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            const domain = getDomain(tabs[0].url);
            chrome.storage.sync.get("siteFilters", ({ siteFilters }) => {
                siteFilters[domain] = !self.filterEnabled();
                chrome.storage.sync.set({ siteFilters }, () => {
                    self.filterEnabled(!self.filterEnabled());
                });
            });
        });
    };

    init();
}

document.addEventListener("DOMContentLoaded", () => {
    const app = new ViewModel();
    ko.applyBindings(app, document.body);
});