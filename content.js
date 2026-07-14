var DEBUG = false;
const getDomain = url => new URL(url).hostname;

// Hosts the extension is switched OFF for by default (see shadow-hook.js). Keep
// this list in sync with REDACTION_IGNORED_HOSTS there. Cloudflare Turnstile
// challenge frames must be left completely untouched or the "verify you are
// human" check fails.
const IGNORED_HOSTS = ["challenges.cloudflare.com"];
const isIgnoredHost = host => IGNORED_HOSTS.some(h => host === h || host.endsWith("." + h));

chrome.storage.sync.get(["keywords", "siteFilters"], ({ keywords = [], siteFilters = {} }) => {
    const currentDomain = getDomain(window.location.href);
    // Off by default on ignored hosts, and not user-overridable (never scan/hide).
    if (isIgnoredHost(currentDomain)) return;
    let filterEnabled = siteFilters[currentDomain] ?? true;

    /**
     * Logs messages to the console only if DEBUG is true.
     *
     * @param {string} type - The console method to use ("log", "info", "warn", "group", "groupEnd", ...).
     * @param {...any} args - Arguments forwarded to the console method.
     */
    const debugLog = (type, ...args) => {
        if (DEBUG && console[type]) {
            console[type](...args);
        }
    };

    // ---------------------------------------------------------------------------
    // 1. Keyword matching — substring candidates, then morphological validation
    // ---------------------------------------------------------------------------

    /**
     * Normalizes text for comparison: lowercases, strips diacritics (so "Élon"
     * matches "elon"), folds curly to straight apostrophes, and collapses
     * whitespace. Unicode-aware.
     *
     * @param {string} s - Raw text.
     * @returns {string} Normalized text.
     */
    const normalize = s =>
        s.toLowerCase()
            .normalize("NFD")
            .replace(/\p{M}/gu, "")
            .replace(/[’]/g, "'")
            .replace(/\s+/g, " ")
            .trim();

    // Inflectional suffixes accepted after a whole-word stem (plurals, possessives,
    // common verb forms). The empty string covers the exact word.
    const WORD_SUFFIXES = ["", "s", "es", "'s", "ing", "ed", "er", "ers", "d"];

    // Matches word tokens including a trailing possessive/contraction ("trump's").
    const TOKEN_RE = /[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu;

    // Phrase containers longer than this are assumed to be broad blocks, not a
    // tight phrase, and are skipped to avoid false positives + needless cost.
    const PHRASE_MAX_LEN = 400;

    let compiled = { words: [], substrings: [], phrases: [] };

    /**
     * Compiles raw keyword strings into matcher buckets. Syntax:
     *   "~term"        -> substring (opt-in to the old broad behavior)
     *   "two words"    -> phrase (matched across inline tags via textContent)
     *   "term"         -> whole word (with inflection validation)
     *
     * @param {string[]} list - Raw keyword strings from storage.
     * @returns {{words:Object[], substrings:Object[], phrases:Object[]}}
     */
    const compileKeywords = list => {
        const words = [], substrings = [], phrases = [];
        for (const raw of list) {
            if (!raw) continue;
            let s = String(raw).trim();
            let substring = false;
            if (s.startsWith("~")) { substring = true; s = s.slice(1).trim(); }
            const stem = normalize(s);
            if (!stem) continue;
            const entry = { raw: s, stem };
            if (substring) substrings.push(entry);
            else if (/\s/.test(stem)) phrases.push(entry);
            else words.push(entry);
        }
        return { words, substrings, phrases };
    };

    /**
     * Matches word and substring keywords against a single text node's value.
     * Words are validated: the matched token must START with the stem and any
     * remainder must be an allowed inflection — so "art" won't match "Bart" and
     * "Elon" won't match "melon", but "Trumps"/"Trump's" still match "Trump".
     *
     * @param {string} normText - Already-normalized text.
     * @returns {Set<string>} Display names of matched keywords.
     */
    const matchWordSubstring = normText => {
        const found = new Set();

        for (const e of compiled.substrings) {
            if (normText.includes(e.stem)) found.add(e.raw);
        }

        if (compiled.words.length) {
            const tokens = normText.match(TOKEN_RE);
            if (tokens) {
                for (const e of compiled.words) {
                    for (const tok of tokens) {
                        if (tok.length < e.stem.length || !tok.startsWith(e.stem)) continue;
                        if (WORD_SUFFIXES.includes(tok.slice(e.stem.length))) { found.add(e.raw); break; }
                    }
                }
            }
        }

        return found;
    };

    /**
     * Matches phrase keywords by climbing from a text node toward a tight
     * containing block and testing its normalized textContent — so a phrase split
     * across inline tags ("<span>Breaking</span> <span>News</span>") still matches.
     *
     * @param {Text} textNode - The text node where scanning started.
     * @param {WeakSet} tested - Per-scan memo of already-tested ancestors.
     * @returns {{element:HTMLElement, keywords:Set<string>}|null}
     */
    const matchPhraseClimb = (textNode, tested) => {
        if (!compiled.phrases.length) return null;
        let el = textNode.parentElement;
        let depth = 0;
        while (el && el.nodeType === Node.ELEMENT_NODE && depth < 5 && !STRUCTURAL.has(el.tagName)) {
            if (!tested.has(el)) {
                tested.add(el);
                const tc = el.textContent;
                if (tc && tc.length <= PHRASE_MAX_LEN) {
                    const norm = normalize(tc);
                    const hit = new Set();
                    for (const p of compiled.phrases) if (norm.includes(p.stem)) hit.add(p.raw);
                    if (hit.size) return { element: el, keywords: hit };
                }
            }
            el = el.parentElement;
            depth++;
        }
        return null;
    };

    // ---------------------------------------------------------------------------
    // 2. Container selection — structural-signature repeating item + size guard
    // ---------------------------------------------------------------------------

    // Tags we never climb into / never hide wholesale.
    const STRUCTURAL = new Set(["BODY", "HTML", "MAIN", "NAV", "HEADER", "FOOTER"]);
    // Inline tags are climbed through but never chosen as the redaction target.
    const INLINE = new Set([
        "SPAN", "A", "B", "I", "EM", "STRONG", "SMALL", "MARK", "LABEL", "CODE",
        "SUP", "SUB", "U", "FONT", "TIME", "ABBR", "CITE", "Q", "S", "DEL", "INS", "WBR", "BR"
    ]);
    // Tags that are inherently "one item in a list".
    const ITEM_TAGS = new Set(["ARTICLE", "LI"]);

    const MIN_SIMILAR_SIBLINGS = 2;   // >= 2 similar siblings (3+ items) => a feed/grid item
    const MAX_CLIMB = 15;

    /**
     * Returns the tag names of an element's first children, used as a
     * class-independent structural fingerprint.
     *
     * @param {HTMLElement} el
     * @returns {string[]}
     */
    const childTagKey = el => {
        const out = [];
        const kids = el.children;
        for (let i = 0; i < kids.length && i < 12; i++) out.push(kids[i].tagName);
        return out;
    };

    /**
     * Determines whether two elements are structurally similar WITHOUT relying on
     * class names (which modern frameworks hash per-item). Same tag is required;
     * a shared data-testid is a strong signal; otherwise child-tag overlap
     * (Jaccard) is used, allowing differing child counts (SiSTeR-style).
     *
     * @param {HTMLElement} a
     * @param {HTMLElement} b
     * @returns {boolean}
     */
    const isSimilar = (a, b) => {
        if (a.tagName !== b.tagName) return false;

        const ta = a.getAttribute("data-testid"), tb = b.getAttribute("data-testid");
        if (ta || tb) return ta === tb;

        if (a.getAttribute("role") !== b.getAttribute("role")) return false;

        const ca = childTagKey(a), cb = childTagKey(b);
        if (ca.length === 0 && cb.length === 0) return true;

        const sa = new Set(ca), sb = new Set(cb);
        let inter = 0;
        sa.forEach(t => { if (sb.has(t)) inter++; });
        const union = new Set([...sa, ...sb]).size;
        return union ? inter / union >= 0.5 : true;
    };

    /**
     * Counts how many of an element's siblings are structurally similar to it.
     *
     * @param {HTMLElement} el
     * @returns {number}
     */
    const countSimilarSiblings = el => {
        const parent = el.parentElement;
        if (!parent) return 0;
        let n = 0;
        for (const sib of parent.children) {
            if (sib !== el && isSimilar(el, sib)) n++;
        }
        return n;
    };

    /**
     * Detects whether an element is itself a list/grid CONTAINER (many mutually
     * similar children) — we must never hide that, only the items inside it.
     *
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    const isListContainer = el => {
        const kids = el.children;
        if (kids.length < 5) return false;
        let similar = 0;
        for (const k of kids) if (isSimilar(kids[0], k)) similar++;
        return similar >= 5;
    };

    /**
     * Recognizes semantic "one item" elements (article/li, ARIA roles, itemprop,
     * data-testid cells, or custom elements) that have repeating siblings.
     *
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    const isItemish = el => {
        if (ITEM_TAGS.has(el.tagName)) return true;
        const role = el.getAttribute("role");
        if (role === "article" || role === "listitem") return true;
        if (el.hasAttribute("data-testid") || el.hasAttribute("data-test") || el.hasAttribute("itemprop")) {
            return countSimilarSiblings(el) >= 1;
        }
        if (el.tagName.includes("-") && countSimilarSiblings(el) >= 1) return true;  // web component
        return false;
    };

    /**
     * The real size guard (AND logic, unlike the old OR version). Rejects elements
     * that cover too much of the viewport, full-bleed regions, and list containers.
     * Elements with no layout box (0x0) pass, so not-yet-rendered nodes aren't lost.
     *
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    const sizeGuard = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return true;
        const vw = window.innerWidth, vh = window.innerHeight;
        if (r.width * r.height >= 0.5 * vw * vh) return false;        // too much screen area
        if (r.width >= 0.9 * vw && r.height >= 0.9 * vh) return false; // full-bleed region
        return true;
    };

    /**
     * Given the element where a keyword was found, finds the best container to
     * hide: the smallest repeating feed/grid item (or semantic item) that passes
     * the size guard. Falls back to the nearest block-level self-contained
     * ancestor so we never leave a broken inline fragment.
     *
     * @param {HTMLElement} startEl
     * @returns {HTMLElement|null}
     */
    const findTarget = startEl => {
        let el = startEl, depth = 0, lastWithinGuard = null;
        while (el && el.nodeType === Node.ELEMENT_NODE && !STRUCTURAL.has(el.tagName) && depth < MAX_CLIMB) {
            if (!sizeGuard(el)) break;          // too big -> stop climbing
            lastWithinGuard = el;
            if (isItemish(el)) return el;       // semantic item wins
            if (!INLINE.has(el.tagName) &&
                countSimilarSiblings(el) >= MIN_SIMILAR_SIBLINGS &&
                !isListContainer(el)) {
                return el;                       // smallest repeating block item
            }
            el = el.parentElement;
            depth++;
        }
        return fallbackBlock(startEl, lastWithinGuard);
    };

    /**
     * Fallback target: the nearest block-level ancestor (skipping inline wrappers)
     * that still passes the size guard.
     *
     * @param {HTMLElement} startEl
     * @param {HTMLElement|null} lastWithinGuard - Last ancestor known to pass the guard.
     * @returns {HTMLElement|null}
     */
    const fallbackBlock = (startEl, lastWithinGuard) => {
        let el = startEl;
        while (el && el.nodeType === Node.ELEMENT_NODE && !STRUCTURAL.has(el.tagName)) {
            if (!sizeGuard(el)) break;
            if (!INLINE.has(el.tagName)) return el;
            el = el.parentElement;
        }
        return lastWithinGuard;
    };

    // ---------------------------------------------------------------------------
    // 3. Hiding — stylesheet class + data attribute, fully reversible
    // ---------------------------------------------------------------------------

    const REDACTED_ATTR = "data-redacted-by";

    // Hide via an INLINE style, not a document CSS class: document stylesheets do
    // not cross shadow boundaries, so a class can't hide elements inside Shadow DOM
    // (MSN/Reddit/YouTube feeds). Inline display:none !important lives on the
    // element itself, works in light DOM and any shadow root, and beats site rules.
    const hideEl = el => el.style.setProperty("display", "none", "important");
    const showEl = el => el.style.removeProperty("display");

    /**
     * Marks an element as matched (data attribute) and hides it when the filter is
     * enabled for this domain.
     *
     * @param {HTMLElement} el
     * @param {Set<string>} keywords
     */
    const mark = (el, keywords) => {
        el.setAttribute(REDACTED_ATTR, [...keywords].join(", "));
        if (filterEnabled) hideEl(el); else showEl(el);
    };

    /**
     * Runs a callback against every root we observe (document body + shadow roots),
     * which is how we reach redacted elements that live inside Shadow DOM.
     *
     * @param {(root:ParentNode)=>void} fn
     */
    const forEachRoot = fn => {
        for (const root of observedRoots) {
            if (root.querySelectorAll) fn(root);
        }
    };

    /** Shows/hides all marked elements (used by the per-domain toggle). */
    const setHidden = hidden =>
        forEachRoot(root => root.querySelectorAll(`[${REDACTED_ATTR}]`)
            .forEach(hidden ? hideEl : showEl));

    /** Clears all redaction state (used when keywords change before a fresh scan). */
    const clearAll = () =>
        forEachRoot(root => root.querySelectorAll(`[${REDACTED_ATTR}]`).forEach(el => {
            showEl(el);
            el.removeAttribute(REDACTED_ATTR);
        }));

    // ---------------------------------------------------------------------------
    // 4. Scanning + Shadow DOM traversal + debounced incremental observation
    // ---------------------------------------------------------------------------

    const observedRoots = new Set();
    const observer = new MutationObserver(records => {
        for (const rec of records) {
            rec.addedNodes.forEach(n => {
                if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) pending.add(n);
            });
        }
        if (pending.size) schedule();
    });
    const pending = new Set();
    let scheduled = false;

    /**
     * Begins observing a root (document body or a shadow root) for added subtrees.
     * Attributes are intentionally NOT observed so our own class writes don't
     * retrigger the observer. Idempotent via observedRoots.
     *
     * @param {Node} root
     */
    const observeRoot = root => {
        if (observedRoots.has(root)) return;
        observedRoots.add(root);
        observer.observe(root, { childList: true, subtree: true });
    };

    /**
     * Processes one text node: matches keywords, resolves the container, and
     * records it (read phase only — no DOM writes here).
     *
     * @param {Text} node
     * @param {Map<HTMLElement,Set<string>>} targets
     * @param {WeakSet} phraseTested
     */
    const handleTextNode = (node, targets, phraseTested) => {
        const val = node.nodeValue;
        if (!val || !val.trim()) return;

        let matched = matchWordSubstring(normalize(val));
        let origin = node.parentElement;
        if (matched.size === 0) {
            const pr = matchPhraseClimb(node, phraseTested);
            if (!pr) return;
            matched = pr.keywords;
            origin = pr.element;
        }
        if (!origin) return;

        const target = findTarget(origin);
        if (!target) return;

        const set = targets.get(target) || new Set();
        matched.forEach(k => set.add(k));
        targets.set(target, set);
    };

    /**
     * Walks a root's subtree collecting redaction targets. Pierces open shadow
     * roots (registering an observer on each) so feed content inside Shadow DOM
     * (Reddit/YouTube) is reached.
     *
     * @param {Node} root
     * @param {Map<HTMLElement,Set<string>>} targets
     * @param {WeakSet} phraseTested
     */
    const collectFrom = (root, targets, phraseTested) => {
        if (root.nodeType === Node.TEXT_NODE) { handleTextNode(root, targets, phraseTested); return; }
        if (root.nodeType === Node.ELEMENT_NODE && root.shadowRoot) {
            observeRoot(root.shadowRoot);
            collectFrom(root.shadowRoot, targets, phraseTested);
        }

        let walker;
        try {
            walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        } catch (e) {
            return;
        }
        while (walker.nextNode()) {
            const n = walker.currentNode;
            try {
                if (n.nodeType === Node.ELEMENT_NODE) {
                    if (n.shadowRoot) {
                        observeRoot(n.shadowRoot);
                        collectFrom(n.shadowRoot, targets, phraseTested);
                    }
                    continue;
                }
                handleTextNode(n, targets, phraseTested);
            } catch (e) {
                debugLog("warn", "node error:", e && e.message);
            }
        }
    };

    /**
     * Read-then-write scan over a set of root nodes: collects all targets first
     * (reads/layout), then applies marks (writes) to avoid layout thrashing.
     *
     * @param {Node[]} roots
     */
    const runScan = roots => {
        if (!compiled.words.length && !compiled.substrings.length && !compiled.phrases.length) return;
        debugLog("group", "Redaction scan");
        const targets = new Map();
        const phraseTested = new WeakSet();
        for (const r of roots) {
            try {
                collectFrom(r, targets, phraseTested);
            } catch (e) {
                debugLog("warn", "scan error:", e && e.message);
            }
        }

        targets.forEach((kws, el) => {
            mark(el, kws);
            debugLog("log", "%cRedacted: " + [...kws].join(", "), "color:#009688; font-weight:bold;", el);
        });
        debugLog("info", "Targets this scan:", targets.size);
        debugLog("groupEnd");
    };

    /** Coalesces mutation bursts into a single idle scan of only the added subtrees. */
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        const run = () => {
            scheduled = false;
            const nodes = [...pending];
            pending.clear();
            if (nodes.length) runScan(nodes);
        };
        if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 500 });
        else setTimeout(run, 100);
    };

    // ---------------------------------------------------------------------------
    // 5. Bootstrap + live updates
    // ---------------------------------------------------------------------------

    // Re-walk the document to discover + observe any newly-attached shadow roots.
    // Coalesced through the same debounced scheduler so bursts collapse to one scan.
    const requestRescan = () => {
        if (!document.body) return;
        pending.add(document.body);
        schedule();
    };

    // SPA feeds (esp. inside Shadow DOM) render after our first scan, and NESTED
    // shadow roots can attach to existing hosts at any time with no childList
    // mutation we observe and no reliable attachShadow event (declarative/SSR
    // roots) — and a MutationObserver can't see across a shadow boundary. Dense
    // early sweeps catch the initial render; a steady low-frequency tick keeps
    // discovering + observing late/nested roots for the page's lifetime.
    const RESCAN_SCHEDULE = [400, 1000, 2000, 4000, 7000, 11000, 16000];
    const RESCAN_INTERVAL = 4000;

    const start = () => {
        compiled = compileKeywords(keywords);
        // Marker so the console can confirm THIS build is the one running.
        document.documentElement.setAttribute("data-redaction-active", chrome.runtime.getManifest().version);
        // The MAIN-world hook (shadow-hook.js) forces shadow roots open and fires
        // "redaction:shadow" on attach — a best-effort early trigger.
        window.addEventListener("redaction:shadow", requestRescan, true);
        observeRoot(document.body);
        runScan([document.body]);
        RESCAN_SCHEDULE.forEach(t => setTimeout(requestRescan, t));
        setInterval(requestRescan, RESCAN_INTERVAL);
    };

    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });

    // React to keyword / per-site toggle changes pushed from the popup.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;

        if (changes.keywords) {
            currentKeywords = changes.keywords.newValue || [];
            compiled = compileKeywords(currentKeywords);
            clearAll();                 // drop stale matches, then re-evaluate the page
            runScan([document.body]);
        }

        if (changes.siteFilters) {
            filterEnabled = (changes.siteFilters.newValue || {})[currentDomain] ?? true;
            setHidden(filterEnabled);   // toggle visibility without re-scanning
        }
    });
});
