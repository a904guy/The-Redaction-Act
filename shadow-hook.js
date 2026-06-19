// Runs in the page's MAIN world at document_start (see manifest).
//
// Extensions can't read CLOSED shadow roots and get no event when a root is
// attached, so feed content inside Shadow DOM (MSN, Reddit, YouTube, ...) is
// invisible to a content script. We wrap Element.prototype.attachShadow to:
//   1. force every shadow root to mode "open" so it becomes reachable, and
//   2. notify the isolated content script (via a DOM event) each time a root is
//      attached, so it can re-walk to discover + observe the new root.
(function () {
    try {
        const proto = Element.prototype;
        const native = proto.attachShadow;
        if (!native || native.__redactionWrapped) return;

        const wrapped = function (init) {
            const opts = Object.assign({}, init, { mode: "open" });
            const root = native.call(this, opts);
            try { window.dispatchEvent(new Event("redaction:shadow")); } catch (e) { /* ignore */ }
            return root;
        };
        wrapped.__redactionWrapped = true;
        proto.attachShadow = wrapped;
    } catch (e) {
        /* never break the host page */
    }
})();
