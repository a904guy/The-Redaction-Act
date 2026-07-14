// Runs in the page's MAIN world at document_start (see manifest).
//
// Extensions can't read CLOSED shadow roots and get no event when a root is
// attached, so feed content inside Shadow DOM (MSN, Reddit, YouTube, ...) is
// invisible to a content script. We wrap Element.prototype.attachShadow to force
// every shadow root to mode "open" so the ISOLATED-world content script can reach
// it, and notify that script (via a DOM event) each time a root is attached.
//
// The catch: naively replacing a native prototype method is exactly what anti-bot
// systems (Cloudflare Turnstile, etc.) flag as a tampered environment, failing
// their challenge. So everything below is invisible IN THE MAIN WORLD:
//   * Function.prototype.toString reports the real native source for the three
//     functions we replace (and for itself), so integrity checks see no override.
//   * the shadowRoot getter returns null for roots we force-opened, preserving the
//     closed-root invariant the page created.
// The content script lives in the isolated world with the untouched native
// getter, so it still sees the real (open) roots. NOTE: a fresh-realm toString
// (clean iframe) can still see through this — no in-page patch can fully hide.
//
// Hosts we never touch at all (their own anti-bot UI must run pristine).
const REDACTION_IGNORED_HOSTS = ["challenges.cloudflare.com"];

(function () {
    try {
        const host = location.hostname;
        if (REDACTION_IGNORED_HOSTS.some(h => host === h || host.endsWith("." + h))) return;

        // Re-injection guard (non-enumerable so it doesn't surface in scans).
        if (Object.getOwnPropertyDescriptor(window, "__raShadowHooked")) return;
        Object.defineProperty(window, "__raShadowHooked", { value: true });

        const proto = Element.prototype;
        const nativeAttach = proto.attachShadow;
        const nativeToString = Function.prototype.toString;
        const shadowDesc = Object.getOwnPropertyDescriptor(proto, "shadowRoot");
        if (!nativeAttach || !shadowDesc || !shadowDesc.get) return;
        const nativeGet = shadowDesc.get;

        // Native source snapshots, captured before we replace toString.
        const srcAttach = nativeToString.call(nativeAttach);
        const srcGet = nativeToString.call(nativeGet);
        const srcToString = nativeToString.call(nativeToString);

        // Hosts whose closed root we transparently forced open.
        const forcedOpen = new WeakSet();

        // Object-method shorthand gives us functions with the right name/length and
        // NO own "prototype" property — matching the shape of a native method.
        const wrapped = ({
            attachShadow(init) {
                const wanted = init && init.mode;
                const root = nativeAttach.call(this, Object.assign({}, init, { mode: "open" }));
                if (wanted !== "open") forcedOpen.add(this);
                try { window.dispatchEvent(new Event("redaction:shadow")); } catch (e) { /* ignore */ }
                return root;
            }
        }).attachShadow;

        const patchedGet = ({
            "get shadowRoot"() {
                if (forcedOpen.has(this)) return null;
                return nativeGet.call(this);
            }
        })["get shadowRoot"];

        const patchedToString = ({
            toString() {
                if (this === wrapped) return srcAttach;
                if (this === patchedGet) return srcGet;
                if (this === patchedToString) return srcToString;
                return nativeToString.call(this);
            }
        }).toString;

        Function.prototype.toString = patchedToString;
        proto.attachShadow = wrapped;
        Object.defineProperty(proto, "shadowRoot", {
            get: patchedGet,
            set: shadowDesc.set,
            enumerable: shadowDesc.enumerable,
            configurable: shadowDesc.configurable
        });
    } catch (e) {
        /* never break the host page */
    }
})();
