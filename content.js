const getDomain = url => new URL(url).hostname;

chrome.storage.sync.get(["keywords", "siteFilters"], ({ keywords = [], siteFilters = {} }) => {
    const currentDomain = getDomain(window.location.href);
    let filterEnabled = siteFilters[currentDomain] ?? true;
    let currentKeywords = keywords;

    const hasKeyword = txt => {
        const lower = txt.toLowerCase();
        return currentKeywords.some(k => lower.includes(k.toLowerCase()));
    };

    const getRepeatingAncestor = el => {
        let current = el;
        while (current && current.parentElement && current.parentElement.tagName !== "BODY") {
            const parent = current.parentElement;
            const siblings = [...parent.parentElement.children].filter(sib =>
                sib.tagName === parent.tagName && sib.className === parent.className
            );
            if (siblings.length > 1) return parent;
            current = parent;
        }
        return null;
    };

    const checkContent = () => {
        console.group("Content Check");
        console.info("Keywords:", currentKeywords);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const matched = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (hasKeyword(node.nodeValue)) {
                const parentElement = node.parentElement;
                matched.push(parentElement);
                const ancestor = getRepeatingAncestor(parentElement);
                if (ancestor) {
                    console.log("%cAncestor match: " + node.nodeValue.trim(), "color: #009688; font-weight: bold;");
                    matched.push(ancestor);
                }
            }
        }
        console.info("Total matched elements:", matched.length);
        matched.forEach(container => {
            container.classList.add("redaction-filter");
            container.style.display = filterEnabled ? "none" : "";
        });
        console.groupEnd();
    };

    checkContent();

    const observer = new MutationObserver(() => {
        console.group("DOM Mutation");
        console.info("Content re-check triggered by DOM update.");
        checkContent();
        console.groupEnd();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync") {
            console.group("Storage Change");
            console.info("Changes:", changes);
            if (changes.siteFilters) {
                console.info("siteFilters updated:", changes.siteFilters.newValue);
                chrome.storage.sync.get("siteFilters", ({ siteFilters }) => {
                    filterEnabled = siteFilters[currentDomain] ?? true;
                    document.querySelectorAll(".redaction-filter").forEach(el => {
                        el.style.display = filterEnabled ? "none" : "";
                    });
                    checkContent();
                });
            }
            if (changes.keywords) {
                console.info("keywords updated:", changes.keywords.newValue);
                currentKeywords = changes.keywords.newValue || [];
                checkContent();
            }
            console.groupEnd();
        }
    });
});