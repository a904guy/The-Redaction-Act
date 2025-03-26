var DEBUG = false;
const getDomain = url => new URL(url).hostname;

chrome.storage.sync.get(["keywords", "siteFilters"], ({ keywords = [], siteFilters = {} }) => {
    const currentDomain = getDomain(window.location.href);
    let filterEnabled = siteFilters[currentDomain] ?? true;
    let currentKeywords = keywords;

    /**
     * Logs messages to the console only if DEBUG is true.
     *
     * @param {string} type - The type of console method (e.g., "log", "info", "warn", "error", "group", "groupEnd").
     * @param {...any} args - The arguments to pass to the console method.
     */
    const debugLog = (type, ...args) => {
        if (DEBUG && console[type]) {
            console[type](...args);
        }
    };

    /**
     * Checks if the given text contains any of the current keywords.
     *
     * @param {string} txt - The text to check for keywords.
     * @returns {boolean} - Returns true if the text contains any of the keywords, otherwise false.
     */
    const hasKeyword = txt => {
        const lower = txt.toLowerCase();
        return currentKeywords.some(k => lower.includes(k.toLowerCase()));
    };

    /**
     * Filters the current keywords that are present in the given text.
     *
     * @param {string} text - The text to search for keywords.
     * @returns {Array} - An array of keywords found in the text.
     */
    const containsKeywords = text => {
        return currentKeywords.filter(keyword => text.toLowerCase().includes(keyword.toLowerCase()));
    }

    /**
     * Finds the nearest ancestor element that has repeating siblings with the same tag name and class name.
     *
     * @param {HTMLElement} el - The starting element to search from.
     * @returns {HTMLElement|null} The nearest ancestor element with repeating siblings, or null if none is found.
     */
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

    /**
     * Checks the content of the document for specific keywords and applies a redaction filter to matched elements.
     *
     * This function traverses the document's text nodes using a TreeWalker, identifies nodes containing specific keywords,
     * and checks if their parent elements and ancestors are small enough based on their dimensions. If the conditions are met,
     * the elements are added to a list and a redaction filter is applied to them.
     *
     * The function logs the matched elements and their keywords to the console and applies a CSS class to hide or show the elements
     * based on the filterEnabled flag.
     */
    const checkContent = () => {
        debugLog("group", "Content Check");
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const matched = [];
        const screenArea = window.innerWidth * window.innerHeight;

            /**
             * Determines if an element is small enough based on its dimensions.
             *
             * This function checks if the area of the element is less than half of the screen area,
             * or if the width is less than 80% of the window's inner width, or if the height is less
             * than 80% of the window's inner height.
             *
             * @param {HTMLElement} el - The element to be checked.
             * @returns {boolean} - Returns true if the element is small enough, otherwise false.
             */
            const isSmallEnough = el => {
                const { width, height } = el.getBoundingClientRect();
                return (width * height < 0.5 * screenArea) || width < 0.5 * window.innerWidth || height < 0.5 * window.innerHeight;
            };

        /**
         * Iterates through all text nodes in the document body using a TreeWalker.
         * 
         * For each text node, it checks if the node contains a keyword and if its parent element
         * is small enough based on certain criteria. If both conditions are met, it adds the parent
         * element to the matched array. It also checks if the ancestor of the parent element is 
         * repeating and small enough, and if so, logs the matched ancestor and keywords.
         */
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!hasKeyword(node.nodeValue)) continue;

            const parentElement = node.parentElement;
            if (!isSmallEnough(parentElement)) continue;
            matched.push(parentElement);

            const ancestor = getRepeatingAncestor(parentElement);
            if (!ancestor || !isSmallEnough(ancestor)) continue;

            debugLog("log", "%cAncestor Match: " + node.nodeValue.trim(), "color: #009688; font-weight: bold;");
            debugLog("log", '%cKeywords Matched: ' + containsKeywords(node.nodeValue.trim()), "color:rgb(150, 0, 0); font-weight: bold;");

            matched.push(ancestor);
        }

        // Log the total number of matched elements to the console.
        debugLog("info", "Total matched elements:", matched.length);

        // Iterate over each matched element, add the "redaction-filter" class,
        // and set the display style based on the filterEnabled flag.
        matched.forEach(container => {
            container.classList.add("redaction-filter");
            container.style.display = filterEnabled ? "none" : "";
        });

        // End the console group for the content check.
        debugLog("groupEnd");
    };

    // Initial Page Load Function Call
    checkContent();

    // Create a new MutationObserver instance to monitor changes in the DOM.
    const observer = new MutationObserver(() => {
        debugLog("group", "DOM Mutation");
        debugLog("info", "Content re-check triggered by DOM update.");
        checkContent();
        debugLog("groupEnd");
    });

    // Start observing the document body for changes in its child elements and subtree.
    observer.observe(document.body, { childList: true, subtree: true });

    // Listen for changes in Chrome storage and update the content accordingly
    chrome.storage.onChanged.addListener((changes, area) => {
        debugLog("group", "Storage Change");
        if (area === "sync") {

            // Check if the siteFilters have changed in the storage
            if (changes.siteFilters) {
                debugLog("info", "siteFilters updated:", changes.siteFilters.newValue);
                chrome.storage.sync.get("siteFilters", ({ siteFilters }) => {
                    filterEnabled = siteFilters[currentDomain] ?? true;
                    document.querySelectorAll(".redaction-filter").forEach(el => {
                        el.style.display = filterEnabled ? "none" : "";
                    });
                    checkContent();
                });
            }
            
            // Check if the keywords have changed in the storage
            if (changes.keywords) {
                debugLog("info", "keywords updated:", changes.keywords.newValue);
                currentKeywords = changes.keywords.newValue || [];
                checkContent();
            }

        }
        debugLog("groupEnd");
    });
});
